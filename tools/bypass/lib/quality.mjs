// V2.5.5.9 weekly bypass quality report (label-free). Thresholds come from the V2.5.5.7 / V2.5.5.8 PRD section 6;
// a missed threshold is WARN, never a failure. PRD: ref_docs/PRD/V2.5.5.9--旁路对象导出与质量巡检方案.md §3.5
import { compare, fail } from '../../dataset/lib/common.mjs';

// v1 thresholds are part of every v1 report and must never change (bypass:validate recomputes old reports).
export const THRESHOLDS = Object.freeze({ requestOk: 0.95, shadowOk: 0.9, maxFrameAgeMinutes: 120, maxUncompressedBytes: 150 * 1024 });
// V2.5.5.15 report v2 (PRD: ref_docs/PRD/V2.5.5.15--旁路质量报告修正与气压层云量核查方案.md §3).
// V2.5.5.29 report v3 adds requests C / D (light-path profile, upstream AOD); v2 reports are still rebuilt with version 2.
export const QUALITY_VERSION = 3;
export const THRESHOLDS_V2 = Object.freeze({ ...THRESHOLDS, shadowAllFramesOk: 0.8, pressureLevelInconsistent: 0.3, minConsistencySupport: 10 });
export const THRESHOLDS_V3 = Object.freeze({ ...THRESHOLDS_V2, rayRequestOk: 0.9 });

const round = (value, digits = 3) => value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
const ratio = (part, total) => total ? round(part / total) : null;
function distribution(values) {
  const list = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const at = p => list[Math.min(list.length - 1, Math.floor(p * list.length))];
  return { n: list.length, min: list[0], p50: at(0.5), p90: at(0.9), max: list.at(-1) };
}
function counts(values) {
  const map = {};
  for (const v of values) map[v ?? 'null'] = (map[v ?? 'null'] || 0) + 1;
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => compare(a, b)));
}
function spearman(pairs) {
  if (pairs.length < 10) return null;
  const rank = values => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), ranks = new Array(values.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return ranks;
  };
  const x = rank(pairs.map(p => p[0])), y = rank(pairs.map(p => p[1]));
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length, mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? round(sxy / Math.sqrt(sxx * syy)) : null;
}

const latestOkFrame = shadow => shadow && [...shadow.frames].reverse().find(f => f.status === 'OK') || null;
const latestFrame = shadow => shadow && shadow.frames.length ? shadow.frames.at(-1) : null;

// NWP mid/high proxy within the satellite corridor: max of 500 / 300 / 250 hPa cloud at the hour nearest sunset,
// averaged over grid nodes within 250 km.
function nwpMidHigh(payload) {
  const sunset = Date.parse(payload.sunset_time_utc), values = [];
  for (const node of payload.grid_nodes) {
    if (node.distance_km > 250 || !node.time_utc.length) continue;
    let best = 0;
    node.time_utc.forEach((t, i) => { if (Math.abs(Date.parse(t) - sunset) < Math.abs(Date.parse(node.time_utc[best]) - sunset)) best = i; });
    const level = ['cloud_cover_500hPa', 'cloud_cover_300hPa', 'cloud_cover_250hPa'].map(k => node.variables[k]?.[best]).filter(v => v != null);
    if (level.length) values.push(Math.max(...level));
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function variableMissing(payloads) {
  const nulls = {}, totals = {};
  for (const payload of payloads) {
    for (const node of [...payload.grid_nodes, ...payload.far_nodes]) {
      for (const [name, series] of Object.entries(node.variables)) totals[name] = (totals[name] || 0) + series.length;
    }
    for (const [name, count] of Object.entries(payload.quality.null_counts)) nulls[name] = (nulls[name] || 0) + count;
  }
  return Object.fromEntries(Object.keys(totals).sort(compare).map(name => [name, ratio(nulls[name] || 0, totals[name])]));
}

function breakdown(rows, key) {
  const groups = {};
  for (const row of rows.filter(r => r.expected === 'EXPECTED')) {
    const g = groups[row[key] ?? 'null'] ||= { expected: 0, valid: 0, shadow_ok: 0 };
    g.expected++;
    if (row.object_status === 'VALID') g.valid++;
    if (row.shadow_status === 'OK') g.shadow_ok++;
  }
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => compare(a, b)));
}

/** Frame-level satellite statistics: the object-level OK hides failed frames (V2.5.5.13: only 60% had all three OK). */
function frameStats(shadows) {
  const byPosition = {}, groups = { slot: {}, city: {} }, failedTiles = {};
  let allOk = 0, latestOk = 0, noOk = 0;
  for (const x of shadows) {
    const frames = x.shadow.frames;
    frames.forEach((f, i) => {
      (byPosition[String(i + 1)] ||= []).push(f.status);
      if (f.status !== 'OK') (failedTiles[f.status] ||= []).push(`${f.tiles_ok ?? 'null'}/${f.tiles_requested ?? 'null'}`);
    });
    const all = frames.length > 0 && frames.every(f => f.status === 'OK');
    if (all) allOk++;
    if (frames.length && frames.at(-1).status === 'OK') latestOk++;
    if (!frames.some(f => f.status === 'OK')) noOk++;
    for (const [key, value] of [['slot', x.row.scheduled_slot], ['city', x.row.city]]) {
      const g = groups[key][value ?? 'null'] ||= { objects: 0, all_frames_ok: 0 };
      g.objects++; if (all) g.all_frames_ok++;
    }
  }
  const ratios = map => Object.fromEntries(Object.entries(map).sort(([a], [b]) => compare(a, b))
    .map(([k, g]) => [k, { ...g, ratio: ratio(g.all_frames_ok, g.objects) }]));
  return {
    status_by_position: Object.fromEntries(Object.entries(byPosition).sort(([a], [b]) => compare(a, b)).map(([k, v]) => [k, counts(v)])),
    all_frames_ok_ratio: ratio(allOk, shadows.length), latest_frame_ok_ratio: ratio(latestOk, shadows.length), objects_without_ok_frame: noOk,
    all_frames_ok_by_slot: ratios(groups.slot), all_frames_ok_by_city: ratios(groups.city),
    failed_frame_tiles: Object.fromEntries(Object.entries(failedTiles).sort(([a], [b]) => compare(a, b)).map(([k, v]) => [k, counts(v)]))
  };
}

// Pressure-level cloud vs the same model's single-level mid/high cloud, on the far nodes (they carry both), at the
// hour nearest sunset. V2.5.5.13 found the pressure-level cloud far below the single-level cloud.
function pressureLevelConsistency(payloads) {
  const pairs = [];
  for (const payload of payloads) {
    const sunset = Date.parse(payload.sunset_time_utc);
    for (const node of payload.far_nodes || []) {
      if (!node.time_utc.length) continue;
      let best = 0;
      node.time_utc.forEach((t, i) => { if (Math.abs(Date.parse(t) - sunset) < Math.abs(Date.parse(node.time_utc[best]) - sunset)) best = i; });
      const pl = ['cloud_cover_500hPa', 'cloud_cover_300hPa', 'cloud_cover_250hPa'].map(k => node.variables[k]?.[best]).filter(v => v != null);
      const sl = ['cloud_cover_mid', 'cloud_cover_high'].map(k => node.variables[k]?.[best]).filter(v => v != null);
      if (pl.length && sl.length) pairs.push([Math.max(...pl), Math.max(...sl)]);
    }
  }
  const mean = a => a.length ? round(a.reduce((s, v) => s + v, 0) / a.length, 1) : null;
  const high = pairs.filter(p => p[1] >= 50);
  return { nodes: pairs.length, mean_pressure_level: mean(pairs.map(p => p[0])), mean_single_level: mean(pairs.map(p => p[1])),
    spearman: spearman(pairs.map(p => [p[0], p[1]])), single_level_ge_50: high.length,
    pressure_level_lt_10_when_single_ge_50: high.length >= THRESHOLDS_V2.minConsistencySupport ? ratio(high.filter(p => p[0] < 10).length, high.length) : null };
}

const nearestIndex = (times, target) => {
  let best = 0;
  times.forEach((t, i) => { if (Math.abs(Date.parse(t) - target) < Math.abs(Date.parse(times[best]) - target)) best = i; });
  return best;
};
const RAY_PROFILE = /^(temperature|relative_humidity|geopotential_height)_\d+hPa$/;

// V2.5.5.29 report v3: requests C / D of v3 objects (PRD: ref_docs/PRD/V2.5.5.29--光路剖面旁路采集方案.md §5, §7.3).
// The status comes from the payload (the index CSV keeps its V2.5.5.9 columns). Cloud contrast: ECMWF 0.25° (request C)
// minus the scoring model's single-level cloud (request B, best_match = ECMWF 9 km in China) at 400 / 550 km, hour nearest sunset.
function rayStats(items) {
  const v3 = items.filter(x => x.payload.bypass_schema_version >= 3);
  const request = id => {
    const status = v3.map(x => x.payload.requests[id].status);
    return { status: counts(status), ok_ratio: ratio(status.filter(s => s === 'OK').length, status.length) };
  };
  const nulls = {}, totals = {};
  let profileNullsWhenOk = 0;
  const pairs = { cloud_cover_low: [], cloud_cover_mid: [], cloud_cover_high: [] };
  for (const { payload } of v3) {
    const add = (name, series) => { totals[name] = (totals[name] || 0) + series.length; nulls[name] = (nulls[name] || 0) + series.filter(v => v == null).length; };
    for (const node of payload.ray_nodes) for (const [name, series] of Object.entries(node.variables)) add(name, series);
    for (const node of payload.ray_aod) add('aerosol_optical_depth', node.aerosol_optical_depth);
    if (payload.requests.C.status === 'OK') for (const node of payload.ray_nodes)
      for (const [name, series] of Object.entries(node.variables)) if (RAY_PROFILE.test(name)) profileNullsWhenOk += series.filter(v => v == null).length;
    if (payload.requests.B.status !== 'OK' || payload.requests.C.status !== 'OK') continue;
    const sunset = Date.parse(payload.sunset_time_utc);
    for (const far of payload.far_nodes) {
      const ray = payload.ray_nodes.find(n => n.distance_km === far.distance_km);
      if (!ray || !far.time_utc.length || !ray.time_utc.length) continue;
      const i = nearestIndex(far.time_utc, sunset), j = ray.time_utc.indexOf(far.time_utc[i]);
      if (j < 0) continue;
      for (const name of Object.keys(pairs)) {
        const a = far.variables[name]?.[i], b = ray.variables[name]?.[j];
        if (a != null && b != null) pairs[name].push([a, b]);
      }
    }
  }
  const mean = a => a.length ? round(a.reduce((s, v) => s + v, 0) / a.length, 1) : null;
  return { objects: v3.length, C: request('C'), D: request('D'), profile_nulls_when_c_ok: profileNullsWhenOk,
    variable_missing_ratio: Object.fromEntries(Object.keys(totals).sort(compare).map(name => [name, ratio(nulls[name], totals[name])])),
    cloud_025_vs_9km: Object.fromEntries(Object.entries(pairs).map(([name, p]) => [name, { n: p.length, mean_9km: mean(p.map(x => x[0])),
      mean_025: mean(p.map(x => x[1])), mean_diff: mean(p.map(x => x[1] - x[0])), mean_abs_diff: mean(p.map(x => Math.abs(x[1] - x[0]))) }])) };
}

/** rows: index rows; payloads: Map snapshot_id → payload for VALID rows. Output is deterministic. version: report version to build. */
export function buildQuality(rows, payloads, version = QUALITY_VERSION) {
  if (version === 1) return buildQualityV1(rows, payloads);
  if (version === 3) return buildQualityV3(rows, payloads);
  if (version !== 2) fail('BYPASS_QUALITY_VERSION_UNSUPPORTED');
  const v1 = buildQualityV1(rows, payloads);
  const expected = rows.filter(r => r.expected === 'EXPECTED'), valid = expected.filter(r => r.object_status === 'VALID');
  const items = valid.map(r => ({ row: r, payload: payloads.get(r.snapshot_id) }));
  const shadows = items.filter(x => x.payload.bypass_schema_version >= 2 && x.payload.satellite_shadow)
    .map(x => ({ ...x, shadow: x.payload.satellite_shadow }));
  const frames = frameStats(shadows), consistency = pressureLevelConsistency(items.map(x => x.payload));
  // V2.5.5.15 stops request A online (NOT_REQUESTED): its OK ratio is taken over the objects that sent it.
  const requestedA = valid.filter(r => r.request_a_status !== 'NOT_REQUESTED');
  const requestA = { status: v1.requests.A.status, ok_ratio: ratio(requestedA.filter(r => r.request_a_status === 'OK').length, requestedA.length),
    not_requested: valid.length - requestedA.length };
  const warnings = v1.warnings.filter(w => w.code !== 'REQUEST_A_OK_BELOW_95');
  if (requestA.ok_ratio != null && requestA.ok_ratio < THRESHOLDS.requestOk) warnings.unshift({ code: 'REQUEST_A_OK_BELOW_95', value: requestA.ok_ratio });
  if (frames.all_frames_ok_ratio != null && frames.all_frames_ok_ratio < THRESHOLDS_V2.shadowAllFramesOk)
    warnings.push({ code: 'SHADOW_ALL_FRAMES_OK_BELOW_80', value: frames.all_frames_ok_ratio });
  if (consistency.pressure_level_lt_10_when_single_ge_50 != null && consistency.pressure_level_lt_10_when_single_ge_50 > THRESHOLDS_V2.pressureLevelInconsistent)
    warnings.push({ code: 'PRESSURE_LEVEL_CLOUD_INCONSISTENT', value: consistency.pressure_level_lt_10_when_single_ge_50 });
  // The v1 satellite-vs-NWP rank correlation used pressure-level cloud, which does not represent the model's cloud.
  const { spearman_frac_cloud_vs_nwp_mid_high: _dropped, ...shadow } = v1.satellite_shadow;
  return { quality_version: 2, ...v1, status: warnings.length ? 'WARN' : 'PASS', thresholds: THRESHOLDS_V2, warnings,
    requests: { ...v1.requests, A: requestA, pressure_level_cloud_consistency: consistency },
    satellite_shadow: { ...shadow, frames, nwp_comparison: 'SEE_VALIDATE_RAW_SINGLE_LEVEL' } };
}

// v3 = v2 plus the ray section; v2 reports stay reproducible because buildQuality(…, 2) is unchanged.
function buildQualityV3(rows, payloads) {
  const v2 = buildQuality(rows, payloads, 2);
  const items = rows.filter(r => r.expected === 'EXPECTED' && r.object_status === 'VALID').map(r => ({ row: r, payload: payloads.get(r.snapshot_id) }));
  const ray = rayStats(items), warnings = [...v2.warnings];
  for (const id of ['C', 'D']) if (ray[id].ok_ratio != null && ray[id].ok_ratio < THRESHOLDS_V3.rayRequestOk) warnings.push({ code: `REQUEST_${id}_OK_BELOW_90`, value: ray[id].ok_ratio });
  if (ray.profile_nulls_when_c_ok > 0) warnings.push({ code: 'RAY_PROFILE_MISSING_WHEN_OK', value: ray.profile_nulls_when_c_ok });
  return { ...v2, quality_version: 3, status: warnings.length ? 'WARN' : 'PASS', thresholds: THRESHOLDS_V3, warnings, ray };
}

function buildQualityV1(rows, payloads) {
  const expected = rows.filter(r => r.expected === 'EXPECTED'), valid = expected.filter(r => r.object_status === 'VALID');
  const items = valid.map(r => ({ row: r, payload: payloads.get(r.snapshot_id) }));
  const v2 = items.filter(x => x.payload.bypass_schema_version >= 2);
  const shadows = v2.map(x => ({ ...x, shadow: x.payload.satellite_shadow })).filter(x => x.shadow);
  const requestOk = id => ratio(valid.filter(r => (id === 'A' ? r.request_a_status : r.request_b_status) === 'OK').length, valid.length);
  const shadowOkRatio = ratio(shadows.filter(x => x.shadow.status === 'OK').length, shadows.length);
  const ages = shadows.map(x => latestFrame(x.shadow)?.age_minutes);
  const pairs = [], cold = [], cloudy = [], clear = [];
  for (const x of shadows) {
    const frame = latestOkFrame(x.shadow);
    if (!frame) continue;
    const proxy = nwpMidHigh(x.payload);
    if (proxy != null) pairs.push([frame.summary.frac_cloud_v1, proxy]);
    const ref = { snapshot_id: x.row.snapshot_id, city: x.row.city, prediction_time_utc: x.row.prediction_time_utc,
      frame_time_utc: frame.time_utc, satellite: x.shadow.satellite, frac_cloud_v1: frame.summary.frac_cloud_v1,
      frac_cold_high: frame.summary.frac_cold_high, valid_sample_ratio: frame.valid_sample_ratio };
    if (x.shadow.frames.some(f => f.summary && f.summary.frac_cold_high > 0)) cold.push(ref);
    if (frame.summary.frac_cloud_v1 >= 0.3) cloudy.push(ref);
    if (frame.summary.frac_cloud_v1 === 0 && frame.valid_sample_ratio >= 0.95) clear.push(ref);
  }
  const byId = (a, b) => compare(a.snapshot_id, b.snapshot_id);
  cloudy.sort((a, b) => b.frac_cloud_v1 - a.frac_cloud_v1 || byId(a, b)); clear.sort(byId); cold.sort(byId);
  const warnings = [];
  const check = (code, value, ok) => { if (value != null && !ok(value)) warnings.push({ code, value }); };
  check('REQUEST_A_OK_BELOW_95', requestOk('A'), v => v >= THRESHOLDS.requestOk);
  check('REQUEST_B_OK_BELOW_95', requestOk('B'), v => v >= THRESHOLDS.requestOk);
  check('SHADOW_OK_BELOW_90', shadowOkRatio, v => v >= THRESHOLDS.shadowOk);
  check('FRAME_AGE_P90_ABOVE_120', distribution(ages)?.p90 ?? null, v => v <= THRESHOLDS.maxFrameAgeMinutes);
  check('OBJECT_SIZE_P90_ABOVE_150KB', distribution(valid.map(r => r.uncompressed_bytes))?.p90 ?? null, v => v <= THRESHOLDS.maxUncompressedBytes);
  const missing = expected.filter(r => r.object_status !== 'VALID');
  check('EXPECTED_OBJECTS_NOT_VALID', missing.length, v => v === 0);
  return {
    status: warnings.length ? 'WARN' : 'PASS', thresholds: THRESHOLDS, warnings,
    coverage: { snapshots: rows.length, expected: expected.length, not_expected: rows.length - expected.length,
      object_status: counts(expected.map(r => r.object_status)), valid_ratio: ratio(valid.length, expected.length),
      not_valid: missing.map(r => ({ snapshot_id: r.snapshot_id, city: r.city, event_date_local: r.event_date_local,
        scheduled_slot: r.scheduled_slot, object_status: r.object_status, error_code: r.error_code })).sort(byId) },
    by_date: breakdown(rows, 'event_date_local'), by_slot: breakdown(rows, 'scheduled_slot'), by_city: breakdown(rows, 'city'),
    requests: { schema_versions: counts(valid.map(r => r.bypass_schema_version)),
      A: { status: counts(valid.map(r => r.request_a_status)), ok_ratio: requestOk('A') },
      B: { status: counts(valid.map(r => r.request_b_status)), ok_ratio: requestOk('B') },
      rate_limited: valid.filter(r => r.request_a_status === 'RATE_LIMITED' || r.request_b_status === 'RATE_LIMITED').length,
      variable_missing_ratio: variableMissing(items.map(x => x.payload)),
      uncompressed_bytes: distribution(valid.map(r => r.uncompressed_bytes)), compressed_bytes: distribution(valid.map(r => r.compressed_bytes)) },
    satellite_shadow: { objects: shadows.length, v2_without_shadow: v2.length - shadows.length,
      status: counts(shadows.map(x => x.shadow.status)), reason_code: counts(shadows.map(x => x.shadow.reason_code)),
      ok_ratio: shadowOkRatio, latest_frame_age_minutes: distribution(ages),
      latest_frame_valid_sample_ratio: distribution(shadows.map(x => latestFrame(x.shadow)?.valid_sample_ratio)),
      frac_cloud_v1_nonzero_ratio: ratio(pairs.filter(p => p[0] > 0).length, pairs.length),
      spearman_frac_cloud_vs_nwp_mid_high: spearman(pairs), cold_cloud_cases: cold,
      worldview_candidates: { cloudy: cloudy.slice(0, 2), clear: clear.slice(0, 2) } }
  };
}

const pct = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
const dist = d => d ? `中位 ${d.p50}，P90 ${d.p90}，最大 ${d.max}（n=${d.n}）` : '—';
export function qualityMarkdown(quality, manifest) {
  const q = quality, sel = manifest.descriptor.selection;
  const lines = [`# 旁路对象质量周报`, '',
    `- 包：\`${manifest.bypass_dataset_id}\`；Event 日期 ${sel.event_date_from} 至 ${sel.event_date_to}；截止 ${manifest.descriptor.cutoff_utc}`,
    `- 结论：**${q.status}**${q.warnings.length ? '（' + q.warnings.map(w => w.code).join('、') + '）' : ''}`, '',
    '## 覆盖', '',
    `- Snapshot ${q.coverage.snapshots} 个，应有旁路对象 ${q.coverage.expected} 个，有效 ${pct(q.coverage.valid_ratio)}`,
    `- 对象状态：${Object.entries(q.coverage.object_status).map(([k, v]) => `${k}=${v}`).join('，') || '—'}`, ''];
  if (q.coverage.not_valid.length) {
    lines.push('| Snapshot | 城市 | 日期 | 时段 | 状态 | 错误码 |', '| --- | --- | --- | --- | --- | --- |');
    for (const r of q.coverage.not_valid.slice(0, 50)) lines.push(`| ${r.snapshot_id} | ${r.city} | ${r.event_date_local} | ${r.scheduled_slot ?? ''} | ${r.object_status} | ${r.error_code ?? ''} |`);
    lines.push('');
  }
  lines.push('## 旁路请求（V2.5.5.7）', '',
    `- 请求 A（33 节点）OK ${pct(q.requests.A.ok_ratio)}${q.quality_version >= 2 ? `（只统计发出请求 A 的对象；V2.5.5.15 起线上停用，未请求 ${q.requests.A.not_requested} 个）` : ''}；请求 B（远点）OK ${pct(q.requests.B.ok_ratio)}；限流 ${q.requests.rate_limited} 次`,
    `- 解压体积（字节）：${dist(q.requests.uncompressed_bytes)}`,
    `- 缺测率最高的变量：${Object.entries(q.requests.variable_missing_ratio).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${pct(v)}`).join('，') || '—'}`, '',
    '## 卫星影子（V2.5.5.8）', '',
    `- 对象 ${q.satellite_shadow.objects} 个；OK ${pct(q.satellite_shadow.ok_ratio)}；状态：${Object.entries(q.satellite_shadow.status).map(([k, v]) => `${k}=${v}`).join('，') || '—'}`,
    `- 最新帧帧龄（分钟）：${dist(q.satellite_shadow.latest_frame_age_minutes)}`,
    `- 最新帧有效采样比例：${dist(q.satellite_shadow.latest_frame_valid_sample_ratio)}`,
    ...(q.quality_version >= 2 ? [
      `- 帧级：三帧全部 OK ${pct(q.satellite_shadow.frames.all_frames_ok_ratio)}；最后一帧 OK ${pct(q.satellite_shadow.frames.latest_frame_ok_ratio)}；没有 OK 帧的对象 ${q.satellite_shadow.frames.objects_without_ok_frame} 个`,
      `- 各帧位置状态：${Object.entries(q.satellite_shadow.frames.status_by_position).map(([k, v]) => `第 ${k} 帧 ` + Object.entries(v).map(([s, n]) => `${s}=${n}`).join('/')).join('；') || '—'}`,
      `- 三帧全部 OK（按时段）：${Object.entries(q.satellite_shadow.frames.all_frames_ok_by_slot).map(([k, g]) => `${k} ${pct(g.ratio)}（n=${g.objects}）`).join('，') || '—'}`,
      `- frac_cloud_v1 非零比例 ${pct(q.satellite_shadow.frac_cloud_v1_nonzero_ratio)}；与 NWP 单层中高云的对照见 \`bypass:validate --raw\``
    ] : [
      `- frac_cloud_v1 非零比例 ${pct(q.satellite_shadow.frac_cloud_v1_nonzero_ratio)}；与 NWP 中高云的秩相关 ${q.satellite_shadow.spearman_frac_cloud_vs_nwp_mid_high ?? '—（样本不足 10）'}`
    ]),
    `- 冷云（≤ −30 °C）个例：${q.satellite_shadow.cold_cloud_cases.length} 个`, '',
    ...(q.quality_version >= 2 ? ['## 气压层云量一致性（远点）', '',
      `- 节点 ${q.requests.pressure_level_cloud_consistency.nodes} 个：气压层（500/300/250 hPa 最大值）平均 ${q.requests.pressure_level_cloud_consistency.mean_pressure_level ?? '—'}%，单层中高云平均 ${q.requests.pressure_level_cloud_consistency.mean_single_level ?? '—'}%，秩相关 ${q.requests.pressure_level_cloud_consistency.spearman ?? '—'}`,
      `- 单层中高云 ≥ 50% 的 ${q.requests.pressure_level_cloud_consistency.single_level_ge_50} 个节点中，气压层 < 10% 的比例 ${pct(q.requests.pressure_level_cloud_consistency.pressure_level_lt_10_when_single_ge_50)}。气压层云量不能当作云量使用（V2.5.5.13）`, ''] : []),
    ...(q.quality_version >= 3 ? ['## 光路剖面与上游 AOD（V2.5.5.29）', '',
      `- 版本 3 对象 ${q.ray.objects} 个；请求 C（ecmwf_ifs025）OK ${pct(q.ray.C.ok_ratio)}（${Object.entries(q.ray.C.status).map(([k, v]) => `${k}=${v}`).join('，') || '—'}）；请求 D（AOD）OK ${pct(q.ray.D.ok_ratio)}（${Object.entries(q.ray.D.status).map(([k, v]) => `${k}=${v}`).join('，') || '—'}）`,
      `- 请求 C 为 OK 时 925–200 hPa 温度、湿度、位势高度的缺测值 ${q.ray.profile_nulls_when_c_ok} 个`,
      `- 缺测率最高的变量：${Object.entries(q.ray.variable_missing_ratio).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${pct(v)}`).join('，') || '—'}`,
      `- 400 / 550 km 单层云量，0.25° 减 9 km（日落最近时刻，只报告）：${Object.entries(q.ray.cloud_025_vs_9km).map(([k, c]) => `${k} n=${c.n}，9 km ${c.mean_9km ?? '—'}%，0.25° ${c.mean_025 ?? '—'}%，平均差 ${c.mean_diff ?? '—'}，平均绝对差 ${c.mean_abs_diff ?? '—'}`).join('；')}`, ''] : []),
    '## Worldview 目视对照候选', '', '| 类型 | 城市 | 帧时刻 UTC | 卫星 | frac_cloud_v1 | Snapshot |', '| --- | --- | --- | --- | --- | --- |');
  for (const [kind, list] of [['有云', q.satellite_shadow.worldview_candidates.cloudy], ['晴空', q.satellite_shadow.worldview_candidates.clear]]) {
    for (const r of list) lines.push(`| ${kind} | ${r.city} | ${r.frame_time_utc} | ${r.satellite} | ${r.frac_cloud_v1} | ${r.snapshot_id} |`);
  }
  return lines.join('\r\n') + '\r\n';
}
