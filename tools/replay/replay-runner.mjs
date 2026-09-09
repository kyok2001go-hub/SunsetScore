#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..', '..');
const RUNTIME_FILES = [
  'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
  'js/data.js', 'js/cloud_field.js', 'js/wind.js', 'js/cloud_motion.js', 'js/sky_state.js',
  'js/nowcast.js', 'js/evolution.js', 'js/engine.js', 'js/baseline.js', 'js/sampling.js'
];

let runtimeLoaded = false;
async function runtime() {
  if (!runtimeLoaded) {
    for (const file of RUNTIME_FILES) await import(pathToFileURL(path.join(ROOT, file)).href);
    runtimeLoaded = true;
  }
  return globalThis.SunsetScore;
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override;
  const output = { ...(base || {}) };
  for (const [key, value] of Object.entries(override)) {
    output[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(output[key], value) : value;
  }
  return output;
}

function restoreForecast(node) {
  const offset = node.utc_offset_seconds || 0;
  const hourly = { time: node.time_utc.map((value) =>
    new Date(Date.parse(value) + offset * 1000).toISOString().slice(0, 16)) };
  for (const [name, values] of Object.entries(node.variables)) hourly[name] = values.slice();
  return {
    point: {
      key: node.key, direction: node.direction, azimuth: node.azimuth,
      distanceKm: node.distance_km, azimuthOffset: node.azimuth_offset,
      latitude: node.latitude, longitude: node.longitude, weight: node.weight
    },
    forecast: { timezone: node.timezone, utc_offset_seconds: offset, hourly }
  };
}

function restoreAir(source, offset) {
  if (!source || !source.available) return null;
  const hourly = { time: source.time_utc.map((value) =>
    new Date(Date.parse(value) + offset * 1000).toISOString().slice(0, 16)) };
  for (const [name, values] of Object.entries(source.variables)) hourly[name] = values.slice();
  return { utc_offset_seconds: offset, hourly };
}

function restoreVisual(source) {
  if (!source || !source.available) return null;
  return {
    available: true, source: source.source, layer: source.layer,
    coverageSeries: (source.coverage_series || []).map((entry) => ({ t: entry.t, pct: entry.pct }))
  };
}

function restorePrecip(source, SS, nowMs) {
  if (!source || !source.available) return null;
  const raw = { source: source.source, times: source.minute_series.time_utc_ms.slice(),
    precipitation: source.minute_series.precipitation_mm.slice(), stepMs: source.step_ms,
    intervalAnchor: source.interval_anchor };
  return SS.nowcast.analyzePrecip(raw, nowMs);
}

function forecastTrend(SS, forecast, nowMs, sunsetMs) {
  const current = SS.cloudField.extractInterpolatedAt(forecast, nowMs);
  const sunset = SS.cloudField.extractInterpolatedAt(forecast, sunsetMs);
  return current && sunset ? SS.domain.clamp((current.cloud_cover - sunset.cloud_cover) * 2, -100, 100) : null;
}

function levelOf(SS, score) {
  const levels = SS.modelConfig.scoring.levels;
  return levels.find((item) => score >= item.min)?.label || levels[levels.length - 1].label;
}

export async function runReplay(replay, options = {}) {
  if (!replay || replay.replay_schema_version !== 1) throw new Error('Only replay_schema_version=1 is supported');
  const SS = await runtime();
  const current = SS.modelConfig;
  const captured = deepMerge(replay.effective_config, options.configOverride || {});
  const scoring = deepMerge(current.scoring, captured.scoring || {});
  SS.modelConfig = { ...current, ...captured, scoring };
  try {
    const ctx = replay.context;
    const nowMs = Date.parse(replay.identity.prediction_time_utc);
    const sunsetMs = Date.parse(ctx.sunset_time_utc);
    const solar = {
      sunset: new Date(sunsetMs), civilDusk: new Date(ctx.civil_dusk_utc),
      goldenHourStart: ctx.golden_hour_start_utc ? new Date(ctx.golden_hour_start_utc) : null,
      goldenHourEnd: ctx.golden_hour_end_utc ? new Date(ctx.golden_hour_end_utc) : null,
      sunsetAzimuthDeg: ctx.sunset_azimuth_deg, twilightMinutes: ctx.twilight_minutes
    };
    const nodes = replay.nwp.nodes.map(restoreForecast);
    const engineInputs = replay.engine_inputs;
    const corridor = engineInputs.sampling_mode === 'FULL_SKY_33'
      ? SS.cloudField.interpolateCorridorSamples(nodes, ctx.latitude, ctx.longitude, ctx.sunset_azimuth_deg,
        SS.modelConfig.scoring.distancesKm, SS.modelConfig.scoring.azimuthOffsets)
      : nodes;
    const currentField = SS.cloudField.buildCloudField(nodes, nowMs);
    const sunsetField = SS.cloudField.buildCloudField(nodes, sunsetMs);
    const motion = SS.cloudMotion.forecast({ currentField, targetAzimuthDeg: ctx.sunset_azimuth_deg, samples: nodes, nowUtcMs: nowMs });
    const skyState = SS.skyState.determineState(currentField, motion, ctx.sunset_azimuth_deg);
    const localSunset = SS.time.toLocalShifted(sunsetMs, ctx.utc_offset_seconds);
    const localForecast = nodes.find((sample) => sample.point.distanceKm === 0)?.forecast || nodes[0].forecast;
    const precip = restorePrecip(replay.minute_precip, SS, nowMs);
    const air = restoreAir(replay.air_quality, ctx.utc_offset_seconds);
    const result = SS.engine.compute({
      location: { name: ctx.city, admin1: ctx.admin1, country: ctx.country, latitude: ctx.latitude, longitude: ctx.longitude },
      utcOffsetSeconds: ctx.utc_offset_seconds, localNowUtc: new Date(nowMs), solar,
      sunsetLocal: localSunset, samples: corridor, air, cloudField: sunsetField,
      expectedSampleCount: engineInputs.expected_sample_count,
      totalSkyNodeCount: engineInputs.total_sky_node_count,
      spatialCompleteness: engineInputs.spatial_completeness,
      samplingMode: engineInputs.sampling_mode, cacheStatus: engineInputs.cache_status,
      dataAgeMinutes: engineInputs.data_age_minutes, minutePrecip: precip
    });
    const baseline = SS.baseline.compute({ solar, sunsetLocal: localSunset }, corridor);
    result.base_score = result.score;
    result.baseline_score = baseline.score;
    result.baseline_level = baseline.level;
    result.sky_evolution_factor = skyState.factor;
    let gwFactor = null;
    const time = { nowUtcMs: nowMs, sunsetUtcMs: sunsetMs, minutesToSunset: (sunsetMs - nowMs) / 60000 };
    if (SS.evolution.isGoldenWindowActive({ time })) {
      const radar = restoreVisual(replay.radar);
      const satellite = restoreVisual(replay.satellite);
      const evo = SS.evolution.evaluate({
        forecastTrend: forecastTrend(SS, localForecast, nowMs, sunsetMs), precip, radar, satellite,
        motionForecast: motion, sunsetCloudCover: sunsetField?.summary?.avgCloudCover,
        nowMs, sunsetMs,
        sourcesStatus: {
          radar: { available: replay.radar.available, status: replay.radar.source_status },
          satellite: { available: replay.satellite.available, status: replay.satellite.source_status },
          precip: { available: replay.minute_precip.available, status: replay.minute_precip.available ? 'OK' : 'UNAVAILABLE' }
        }
      });
      gwFactor = evo ? SS.domain.clamp(evo.gwFactor, SS.modelConfig.goldenWindow.floor, 1, 1) : 1;
      result.score = Math.round(SS.domain.clamp(result.score * SS.domain.clamp(skyState.factor, 0.65, 1.15, 1) * gwFactor, 0, 100));
    } else {
      result.score = Math.round(SS.domain.clamp(result.score * SS.domain.clamp(skyState.factor, 0.65, 1.15, 1), 0, 100));
    }
    result.level = levelOf(SS, result.score);
    const actual = {
      score: result.score, level: result.level, base_score: result.base_score,
      baseline_score: result.baseline_score, baseline_level: result.baseline_level,
      components: result.components, regime_label: result.regime_label,
      regime_strength: result.regime_state && result.regime_state.strength,
      sky_evolution_state: skyState.state, sky_evolution_factor: result.sky_evolution_factor, gw_factor: gwFactor
    };
    const expected = options.reference || null;
    const deltas = {};
    const referenceMap = expected ? {
      score: expected.predicted_score, level: expected.predicted_level,
      baseline_score: expected.baseline_score, baseline_level: expected.baseline_level,
      regime_label: expected.regime_label, regime_strength: expected.regime_strength,
      sky_evolution_state: expected.sky_evolution_state, sky_evolution_factor: expected.sky_evolution_factor,
      gw_factor: expected.gw_factor,
      components: { sky_canvas: expected.comp_sky_canvas, horizon: expected.comp_horizon,
        illumination: expected.comp_illumination, atmosphere: expected.comp_atmosphere, weather: expected.comp_weather }
    } : null;
    for (const key of ['score', 'baseline_score', 'regime_strength', 'sky_evolution_factor', 'gw_factor']) {
      deltas[key] = !referenceMap || referenceMap[key] == null || actual[key] == null ? null : actual[key] - referenceMap[key];
    }
    const componentDeltas = {};
    for (const key of Object.keys(actual.components || {})) {
      componentDeltas[key] = !referenceMap || referenceMap.components[key] == null ? null : actual.components[key] - referenceMap.components[key];
    }
    const pass = !referenceMap ? null : Math.abs(deltas.score) <= 1 &&
      Object.values(componentDeltas).every((value) => value == null || Math.abs(value) <= 1) &&
      actual.regime_label === referenceMap.regime_label && actual.sky_evolution_state === referenceMap.sky_evolution_state &&
      (deltas.gw_factor == null || Math.abs(deltas.gw_factor) < 0.01);
    return { mode: options.configOverride ? 'candidate' : 'reference', pass, actual,
      reference: referenceMap, deltas: { ...deltas, components: componentDeltas } };
  } finally {
    SS.modelConfig = current;
  }
}

async function readReplay(file) {
  const bytes = await readFile(file);
  const text = file.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  return JSON.parse(text);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) throw new Error('Usage: node tools/replay/replay-runner.mjs <replay.json[.gz]> --reference snapshot.json [--config candidate.json]');
  const configIndex = args.indexOf('--config');
  const referenceIndex = args.indexOf('--reference');
  const configOverride = configIndex >= 0 ? JSON.parse(await readFile(args[configIndex + 1], 'utf8')) : null;
  const reference = referenceIndex >= 0 ? JSON.parse(await readFile(args[referenceIndex + 1], 'utf8')) : null;
  const report = await runReplay(await readReplay(args[0]), { configOverride, reference });
  console.log(JSON.stringify(report, null, 2));
  if (report.pass === false) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
