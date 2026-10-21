#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { bindEngineRoot } from './engine-root.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPLAY_RUNTIME_FILES = Object.freeze([
  'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
  'js/data.js', 'js/cloud_field.js', 'js/wind.js', 'js/cloud_motion.js', 'js/sky_state.js',
  'js/nowcast.js', 'js/evolution.js', 'js/engine.js', 'js/baseline.js', 'js/sampling.js'
]);

let runtimeRoot = null;
async function runtime(engineRoot = ROOT) {
  const resolvedRoot = bindEngineRoot(path.resolve(engineRoot));
  if (runtimeRoot && runtimeRoot !== resolvedRoot) {
    throw new Error('MULTIPLE_ENGINE_ROOTS_UNSUPPORTED');
  }
  if (!runtimeRoot) {
    delete globalThis.SunsetScore;
    for (const file of REPLAY_RUNTIME_FILES) {
      // A dedicated module instance keeps this runtime self-contained: other tools may have
      // imported the same js files first, and re-running them here must always repopulate
      // globalThis.SunsetScore instead of reading a cached no-op module.
      const url = pathToFileURL(path.join(resolvedRoot, file)).href;
      await import(`${url}?replay-runtime=1`);
    }
    runtimeRoot = resolvedRoot;
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
  const raw = { source: source.source,
    times: source.minute_series.time_utc_ms.map(time => new Date(time).toISOString()),
    precip: source.minute_series.precipitation_mm.slice(), stepMs: source.step_ms,
    intervalAnchor: ['end', 'interval_end'].includes(source.interval_anchor) ? 'end' : 'start' };
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

const COMPONENT_FIELDS = Object.freeze([
  ['sky_canvas', 'comp_sky_canvas'],
  ['horizon', 'comp_horizon'],
  ['illumination', 'comp_illumination'],
  ['atmosphere', 'comp_atmosphere'],
  ['weather', 'comp_weather']
]);

function referenceMap(expected) {
  return {
    score: expected.predicted_score,
    level: expected.predicted_level,
    baseline_score: expected.baseline_score,
    baseline_level: expected.baseline_level,
    regime_label: expected.regime_label,
    regime_strength: expected.regime_strength,
    sky_evolution_state: expected.sky_evolution_state,
    sky_evolution_factor: expected.sky_evolution_factor,
    gw_factor: expected.gw_factor,
    components: Object.fromEntries(COMPONENT_FIELDS.map(([actual, stored]) => [actual, expected[stored]]))
  };
}

export function compareReference(actual, expected) {
  const reference = referenceMap(expected);
  const issues = [];
  const deltas = { components: {} };

  function number(name, tolerance, inclusive = true) {
    const actualValue = actual[name], expectedValue = reference[name];
    if (!Number.isFinite(actualValue) || !Number.isFinite(expectedValue)) {
      issues.push('INVALID_REFERENCE_FIELD:' + name);
      deltas[name] = null;
      return false;
    }
    const delta = actualValue - expectedValue;
    deltas[name] = delta;
    return inclusive ? Math.abs(delta) <= tolerance : Math.abs(delta) < tolerance;
  }

  function exact(name) {
    if (typeof actual[name] !== 'string' || !actual[name] || typeof reference[name] !== 'string' || !reference[name]) {
      issues.push('INVALID_REFERENCE_FIELD:' + name);
      return false;
    }
    return actual[name] === reference[name];
  }

  const checks = [
    number('score', 1), exact('level'),
    number('baseline_score', 1), exact('baseline_level'),
    exact('regime_label'), number('regime_strength', 0.01),
    exact('sky_evolution_state'), number('sky_evolution_factor', 0.01, false),
    number('gw_factor', 0.01, false)
  ];
  let pass = checks.every(Boolean);

  for (const [name] of COMPONENT_FIELDS) {
    const actualValue = actual.components && actual.components[name];
    const expectedValue = reference.components[name];
    if (!Number.isFinite(actualValue) || !Number.isFinite(expectedValue)) {
      issues.push('INVALID_REFERENCE_FIELD:components.' + name);
      deltas.components[name] = null;
      pass = false;
      continue;
    }
    const delta = actualValue - expectedValue;
    deltas.components[name] = delta;
    if (Math.abs(delta) > 1) pass = false;
  }

  return { pass: pass && issues.length === 0, reference, deltas, issues };
}

export async function runReplay(replay, options = {}) {
  if (!replay || replay.replay_schema_version !== 1) throw new Error('Only replay_schema_version=1 is supported');
  const SS = await runtime(options.engineRoot);
  const current = SS.modelConfig;
  let installed;
  if (options.modelConfig) {
    // TUNING_BASE mode: the caller supplies a fully built modelConfig (frozen base config
    // plus a single experiment override) so production aliasing, e.g.
    // modelConfig.scoring === modelConfig.goldenWindow, is preserved exactly.
    installed = options.modelConfig;
  } else {
    // PARITY / candidate mode keeps the historical behaviour: the Replay's own captured
    // effective_config is the base and any override is layered on top of it.
    const captured = deepMerge(replay.effective_config, options.configOverride || {});
    const scoring = deepMerge(current.scoring, captured.scoring || {});
    installed = { ...current, ...captured, scoring };
  }
  SS.modelConfig = installed;
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
    let skyBranchTrace;
    const skyState = SS.skyState.determineState(currentField, motion, ctx.sunset_azimuth_deg,
      options.skyBranchTrace === true ? value => { skyBranchTrace = value; } : undefined);
    const localSunset = SS.time.toLocalShifted(sunsetMs, ctx.utc_offset_seconds);
    const localForecast = nodes.find((sample) => sample.point.distanceKm === 0)?.forecast || nodes[0].forecast;
    const precip = restorePrecip(replay.minute_precip, SS, nowMs);
    const air = restoreAir(replay.air_quality, ctx.utc_offset_seconds);
    const engineSamples = corridor.map(sample => ({ ...sample,
      forecast: SS.data.trimForecastWindow(sample.forecast, nowMs, sunsetMs) }));
    let coreTrace;
    const result = SS.engine.compute({
      ...(options.trace === true ? { offlineTrace: value => { coreTrace = value; } } : {}),
      ...(options.illuminationTrace === true ? { illuminationTrace: true } : {}),
      location: { name: ctx.city, admin1: ctx.admin1, country: ctx.country, latitude: ctx.latitude, longitude: ctx.longitude },
      utcOffsetSeconds: ctx.utc_offset_seconds, localNowUtc: new Date(nowMs), solar,
      sunsetLocal: localSunset, samples: engineSamples, air, cloudField: sunsetField,
      expectedSampleCount: engineInputs.expected_sample_count,
      totalSkyNodeCount: engineInputs.total_sky_node_count,
      spatialCompleteness: engineInputs.spatial_completeness,
      samplingMode: engineInputs.sampling_mode, cacheStatus: engineInputs.cache_status,
      dataAgeMinutes: engineInputs.data_age_minutes, minutePrecip: precip
    });
    const baseline = SS.baseline.compute({ solar, sunsetLocal: localSunset }, engineSamples);
    result.base_score = result.score;
    result.baseline_score = baseline.score;
    result.baseline_level = baseline.level;
    result.sky_evolution_factor = skyState.factor;
    let gwFactor = 1;
    let fusionTrace;
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
      if (options.trace === true) fusionTrace = { sky: result.base_score * SS.domain.clamp(skyState.factor, 0.65, 1.15, 1),
        fused: result.base_score * SS.domain.clamp(skyState.factor, 0.65, 1.15, 1) * gwFactor,
        clamped: SS.domain.clamp(result.base_score * SS.domain.clamp(skyState.factor, 0.65, 1.15, 1) * gwFactor, 0, 100), golden_window_active: true,
        golden_window_observation: evo ? {
          status: 'OBSERVED_PROBABILITY_AND_FACTOR_REMAINING_INTERNALS_PARTIAL_TRACE',
          sunset_open_probability: evo.sunsetOpenProbability ?? null,
          probability_source: evo.sunsetProbabilitySource ?? null,
          returned_factor: evo.gwFactor ?? null, applied_factor: gwFactor,
          floor: SS.modelConfig.goldenWindow.floor,
          state: evo.state ?? null, confidence: evo.confidence ?? null
        } : { status: 'EXECUTED_NO_RESULT', applied_factor: 1, reason_code: 'EVOLUTION_RETURNED_NULL' } };
    } else {
      result.score = Math.round(SS.domain.clamp(result.score * SS.domain.clamp(skyState.factor, 0.65, 1.15, 1), 0, 100));
      if (options.trace === true) fusionTrace = { sky: result.base_score * SS.domain.clamp(skyState.factor, 0.65, 1.15, 1),
        fused: result.base_score * SS.domain.clamp(skyState.factor, 0.65, 1.15, 1),
        clamped: SS.domain.clamp(result.base_score * SS.domain.clamp(skyState.factor, 0.65, 1.15, 1), 0, 100), golden_window_active: false };
    }
    result.level = levelOf(SS, result.score);
    const actual = {
      score: result.score, level: result.level, base_score: result.base_score,
      baseline_score: result.baseline_score, baseline_level: result.baseline_level,
      components: result.components, regime_label: result.regime_label,
      regime_strength: result.regime_state && result.regime_state.strength,
      sky_evolution_state: skyState.state, sky_evolution_factor: result.sky_evolution_factor, gw_factor: gwFactor
    };
    const comparison = options.reference ? compareReference(actual, options.reference) : null;
    return { mode: options.modelConfig ? 'tuning-base' : (options.configOverride ? 'candidate' : 'reference'),
      ...(options.trace === true ? { trace: { trace_schema_version: 1,
        status: coreTrace ? 'COMPLETE_REPLAY_PATH' : 'PARTIAL_TRACE',
        reason_code: coreTrace ? null : 'CORE_OBSERVER_UNAVAILABLE', ...coreTrace,
        ...(options.skyBranchTrace === true ? { sky_branch: { ...skyBranchTrace,
          execution_context: { prediction_time_utc: replay.identity.prediction_time_utc, sunset_time_utc: ctx.sunset_time_utc,
            current_field_timestamp: currentField.timestamp, future_horizon: 'M60_FROM_CURRENT_MOTION; NOT_SUNSET_FIELD' },
          fusion: { returned_factor: skyState.factor, external_range: [0.65, 1.15],
            applied_factor: SS.domain.clamp(skyState.factor, 0.65, 1.15, 1), score_engine: result.base_score,
            score_after_sky: fusionTrace.sky, F_gw: gwFactor, final_score: result.score, final_ordinal: result.score >= 90 ? 4 : result.score >= 60 ? 3 : result.score >= 40 ? 2 : result.score >= 20 ? 1 : 0 } } } : {}),
        nowcast: { status: 'NOT_EXECUTED', reason_code: 'REPLAY_PATH_HAS_NO_SEPARATE_NOWCAST_ADJUSTMENT' },
        golden_window_active: fusionTrace.golden_window_active,
        golden_window_observation: fusionTrace.golden_window_observation ?? { status: 'NOT_EXECUTED', reason_code: 'OUTSIDE_GOLDEN_WINDOW' },
        executed_regime: { label: result.regime_label, strength: result.regime_state?.strength ?? null },
        internal_trace_limits: options.skyBranchTrace === true ? ['GOLDEN_WINDOW_INTERNAL_CONTRIBUTIONS_PARTIAL_TRACE'] : ['SKY_STATE_FACTOR_INTERNAL_CONTRIBUTIONS_PARTIAL_TRACE','GOLDEN_WINDOW_INTERNAL_CONTRIBUTIONS_PARTIAL_TRACE'],
        stages: [...(coreTrace?.stages || []),
          { stage: 'sky_evolution', input_score: result.base_score,
            output_score: fusionTrace.sky },
          { stage: 'golden_window', input_score: fusionTrace.sky, output_score: fusionTrace.fused },
          { stage: 'final_clamp', input_score: fusionTrace.fused, output_score: fusionTrace.clamped },
          { stage: 'final_round', input_score: fusionTrace.clamped, output_score: result.score }].map(stage => ({ ...stage,
            reason_code: stage.input_score === null ? 'WEIGHTED_COMPONENT_SUM_ORIGIN' : 'OBSERVED_REPLAY_EXECUTION',
            trace_detail: options.skyBranchTrace === true && stage.stage === 'sky_evolution' ? 'COMPLETE_SHARED_BRANCH_OBSERVER' : ['sky_evolution','golden_window'].includes(stage.stage) ? 'PARTIAL_TRACE_FACTOR_BOUNDARY' : 'EXECUTION_BOUNDARY' })),
        final_score: result.score, rounded_score: true } } : {}),
      pass: comparison ? comparison.pass : null, actual,
      reference: comparison ? comparison.reference : null,
      deltas: comparison ? comparison.deltas : {},
      comparison_errors: comparison ? comparison.issues : [] };
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
  if (!args.length || args[0].startsWith('--')) {
    throw new Error('Usage: node tools/replay/replay-runner.mjs <replay.json[.gz]> --reference snapshot.json [--config candidate.json] [--engine-root path]');
  }
  const options = { replayFile: args[0], referenceFile: null, configFile: null, engineRoot: ROOT };
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!value || !['--reference', '--config', '--engine-root'].includes(name)) throw new Error('Invalid Replay Runner arguments');
    if (name === '--reference') options.referenceFile = value;
    if (name === '--config') options.configFile = value;
    if (name === '--engine-root') options.engineRoot = path.resolve(value);
  }
  const configOverride = options.configFile ? JSON.parse(await readFile(options.configFile, 'utf8')) : null;
  const reference = options.referenceFile ? JSON.parse(await readFile(options.referenceFile, 'utf8')) : null;
  const report = await runReplay(await readReplay(options.replayFile), { configOverride, reference, engineRoot: options.engineRoot });
  console.log(JSON.stringify(report, null, 2));
  if (report.pass === false) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
