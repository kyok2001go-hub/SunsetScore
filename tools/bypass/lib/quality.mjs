// V2.5.5.9 weekly bypass quality report (label-free). Thresholds come from the V2.5.5.7 / V2.5.5.8 PRD section 6;
// a missed threshold is WARN, never a failure. PRD: ref_docs/PRD/V2.5.5.9--旁路对象导出与质量巡检方案.md §3.5
import { compare } from '../../dataset/lib/common.mjs';

export const THRESHOLDS = Object.freeze({ requestOk: 0.95, shadowOk: 0.9, maxFrameAgeMinutes: 120, maxUncompressedBytes: 150 * 1024 });

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

/** rows: index rows; payloads: Map snapshot_id → payload for VALID rows. Output is deterministic. */
export function buildQuality(rows, payloads) {
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
    `- 请求 A（33 节点）OK ${pct(q.requests.A.ok_ratio)}；请求 B（远点）OK ${pct(q.requests.B.ok_ratio)}；限流 ${q.requests.rate_limited} 次`,
    `- 解压体积（字节）：${dist(q.requests.uncompressed_bytes)}`,
    `- 缺测率最高的变量：${Object.entries(q.requests.variable_missing_ratio).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${pct(v)}`).join('，') || '—'}`, '',
    '## 卫星影子（V2.5.5.8）', '',
    `- 对象 ${q.satellite_shadow.objects} 个；OK ${pct(q.satellite_shadow.ok_ratio)}；状态：${Object.entries(q.satellite_shadow.status).map(([k, v]) => `${k}=${v}`).join('，') || '—'}`,
    `- 最新帧帧龄（分钟）：${dist(q.satellite_shadow.latest_frame_age_minutes)}`,
    `- 最新帧有效采样比例：${dist(q.satellite_shadow.latest_frame_valid_sample_ratio)}`,
    `- frac_cloud_v1 非零比例 ${pct(q.satellite_shadow.frac_cloud_v1_nonzero_ratio)}；与 NWP 中高云的秩相关 ${q.satellite_shadow.spearman_frac_cloud_vs_nwp_mid_high ?? '—（样本不足 10）'}`,
    `- 冷云（≤ −30 °C）个例：${q.satellite_shadow.cold_cloud_cases.length} 个`, '',
    '## Worldview 目视对照候选', '', '| 类型 | 城市 | 帧时刻 UTC | 卫星 | frac_cloud_v1 | Snapshot |', '| --- | --- | --- | --- | --- | --- |');
  for (const [kind, list] of [['有云', q.satellite_shadow.worldview_candidates.cloudy], ['晴空', q.satellite_shadow.worldview_candidates.clear]]) {
    for (const r of list) lines.push(`| ${kind} | ${r.city} | ${r.frame_time_utc} | ${r.satellite} | ${r.frac_cloud_v1} | ${r.snapshot_id} |`);
  }
  return lines.join('\r\n') + '\r\n';
}
