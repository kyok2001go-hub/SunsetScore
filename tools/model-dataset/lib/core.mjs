import { compare, canonicalJson, fail, safeId, unique } from '../../dataset/lib/common.mjs';
import { validDate, canonicalUtc } from '../../dataset/dataset-schema.mjs';
import { RAW_FIELDS } from '../model-dataset-schema.mjs';
import { POLICY } from '../model-dataset-policy.mjs';
import { splitEvents, dateSplit } from '../split-events.mjs';
import { distribution, statistics } from './statistics.mjs';

export const equal = (a, b, reason = 'CONTENT_MISMATCH') => {
  if (canonicalJson(a) !== canonicalJson(b)) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: reason });
};
export function selection(value = null) {
  if (value === null) return { model_versions: null };
  if (typeof value !== 'string') fail('INVALID_ARGUMENTS');
  const values = value.split(',').map(x => x.trim());
  const normalized = unique(values);
  if (values.some(x => !x) || normalized.length > POLICY.model_filter.max_items) fail('INVALID_ARGUMENTS');
  return { model_versions: normalized };
}
export function assertSelection(s) {
  if (!s || Object.keys(s).length !== 1 || !Object.hasOwn(s, 'model_versions')) fail('INVALID_ARGUMENTS');
  if (s.model_versions === null) return;
  if (!Array.isArray(s.model_versions) || !s.model_versions.length || s.model_versions.some(v => typeof v !== 'string' || v.includes(','))) fail('INVALID_ARGUMENTS');
  equal(s, selection(s.model_versions.join(',')), 'SELECTION_INVALID');
}
export const eventOrder = (a, b) => compare(a.event_date_local, b.event_date_local) || compare(a.event_id, b.event_id);
export const sampleOrder = (a, b) => eventOrder(a, b) || a.prediction_time_epoch - b.prediction_time_epoch || compare(a.snapshot_id, b.snapshot_id);
export function bucket(lead) {
  if (!Number.isFinite(lead)) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'INVALID_LEAD' });
  const index = POLICY.lead_boundaries.findIndex(n => lead < n);
  return POLICY.lead_buckets[index === -1 ? POLICY.lead_buckets.length - 1 : index];
}
export function eligibility(row, selected) {
  if (selected.model_versions && !selected.model_versions.includes(row.model_version)) return ['EXCLUDED', null, 'MODEL_VERSION_FILTERED'];
  if (row.gt_status === 'DISPUTED') return ['EXCLUDED', null, 'DISPUTED_GT'];
  if (row.gt_status === 'UNLABELED') return ['EXCLUDED', null, 'UNLABELED'];
  if (row.gt_status === 'WEAK') return ['DIAGNOSTIC', 'WEAK_GT', null];
  if (row.lead_time_minutes < 0) return ['DIAGNOSTIC', 'POST_SUNSET', null];
  return ['PRIMARY', null, null];
}
const gtNames = ['gt_label', 'gt_ordinal', 'gt_confidence', 'gt_status'];
const pick = (row, keys) => Object.fromEntries(keys.map(k => [k, row[k]]));
import { silentProgress } from '../../progress.mjs';
export function derive(events, snapshots, gtRows, replayRows, selected = selection(), inputSummary = { raw: { ERROR: 0, WARNING: 0, INFO: 0 }, gt: { status: 'PASS', validation_scope: 'SOURCE_LINKED' } }, version = 2, progress = silentProgress) {
  progress.stage(`关联样本：${events.length} 个 Event，${snapshots.length} 条 Snapshot`);
  assertSelection(selected);
  const map = (rows, key) => {
    const result = new Map();
    for (const r of rows) { safeId(r[key]); if (result.has(r[key])) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'DUPLICATE_ID' }); result.set(r[key], r); }
    return result;
  };
  const eventMap = map(events, 'event_id'), gtMap = map(gtRows, 'event_id'), replayMap = map(replayRows, 'snapshot_id');
  map(snapshots, 'id');
  equal([...eventMap.keys()].sort(compare), [...gtMap.keys()].sort(compare), 'GT_EVENT_SET');
  equal(snapshots.map(r => r.id).sort(compare), [...replayMap.keys()].sort(compare), 'REPLAY_SET');
  const eventRows = [...eventMap.values()].map(e => {
    const g = gtMap.get(e.event_id);
    if (version === 2 && g.gt_basis !== undefined && !POLICY.basis_order.includes(g.gt_basis)) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'GT_BASIS_INVALID' });
    if (!validDate(e.event_date_local) || typeof e.city !== 'string' || !e.city || !POLICY.statuses.includes(g.gt_status) ||
      !Number.isFinite(g.gt_confidence) || g.gt_confidence < 0 || g.gt_confidence > 1 ||
      (g.gt_status === 'UNLABELED' ? g.gt_label !== null || g.gt_ordinal !== null || g.gt_confidence !== 0 :
        !POLICY.labels.includes(g.gt_label) || POLICY.labels.indexOf(g.gt_label) !== g.gt_ordinal)) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'GT_FIELDS_INVALID' });
    return { event_id: e.event_id, event_date_local: e.event_date_local, city: e.city, ...pick(g, gtNames), ...(version === 2 ? { gt_basis: g.gt_basis ?? POLICY.legacy_gt_basis } : {}),
      primary_snapshot_count: 0, diagnostic_snapshot_count: 0, excluded_snapshot_count: 0,
      eligibility: 'EXCLUDED', exclusion_reason: null, split: null };
  }).sort(eventOrder);
  const grouped = new Map(eventRows.map(e => [e.event_id, []]));
  let matched = 0;
  const rows = snapshots.map((s, index) => {
    const g = gtMap.get(s.event_id), replay = replayMap.get(s.id), event = eventMap.get(s.event_id);
    if (!g || !event || !replay || replay.event_id !== s.event_id || !canonicalUtc(s.sunset_time_utc) ||
      s.event_date_local !== event.event_date_local || !Number.isSafeInteger(s.prediction_time_epoch) ||
      Date.parse(s.prediction_time_utc) !== s.prediction_time_epoch || Date.parse(s.submitted_at_utc) !== s.submitted_at_epoch ||
      s.lead_time_minutes !== (Date.parse(s.sunset_time_utc) - s.prediction_time_epoch) / 60000 ||
      replay.local_path !== `replay/${s.id}.json`) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'JOIN_OR_LEAD_INVALID' });
    if (!selected.model_versions || selected.model_versions.includes(s.model_version)) matched++;
    const r = { ...Object.fromEntries(RAW_FIELDS.map(f => [f.name, s[f.name === 'snapshot_id' ? 'id' : f.name]])),
      lead_time_bucket: bucket(s.lead_time_minutes), engine_build_sha: replay.engine_build_sha, config_hash: replay.config_hash,
      replay_path: replay.local_path, ...pick(g, gtNames), ...(version === 2 ? { gt_basis: g.gt_basis ?? POLICY.legacy_gt_basis } : {}), eligibility: null, split: null, gt_weight: g.gt_confidence,
      event_normalized_weight: 0, diagnostic_reason: null, exclusion_reason: null };
    [r.eligibility, r.diagnostic_reason, r.exclusion_reason] = eligibility(r, selected);
    grouped.get(r.event_id).push(r);
    progress.update(`Snapshot ${index + 1}/${snapshots.length}`, index + 1 === snapshots.length);
    return r;
  }).sort(sampleOrder);
  progress.stage('计算 Event 资格及归一化权重');
  for (const e of eventRows) {
    const group = grouped.get(e.event_id);
    if (!group.length) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'EVENT_WITHOUT_SNAPSHOT' });
    for (const r of group) e[`${r.eligibility.toLowerCase()}_snapshot_count`]++;
    e.eligibility = POLICY.event_priority.find(k => e[`${k.toLowerCase()}_snapshot_count`] > 0);
    if (e.eligibility === 'EXCLUDED') e.exclusion_reason = POLICY.exclusion_reasons.find(k => group.some(r => r.exclusion_reason === k));
    for (const r of group) if (r.eligibility === 'PRIMARY') r.event_normalized_weight = r.gt_confidence / e.primary_snapshot_count;
  }
  const primaryEvents = eventRows.filter(e => e.eligibility === 'PRIMARY');
  progress.stage(`按日期划分训练/验证/测试集：${primaryEvents.length} 个 PRIMARY Event`);
  const planned = splitEvents(primaryEvents, (done, total) => progress.update(`日期边界搜索 ${done}/${total}`, done === total));
  if (planned.selected_split) for (const e of primaryEvents) {
    e.split = dateSplit(e.event_date_local, planned.selected_split);
    for (const r of grouped.get(e.event_id)) if (r.eligibility === 'PRIMARY') r.split = e.split;
    const sorted = grouped.get(e.event_id).filter(r => r.eligibility === 'PRIMARY').sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
    if (Math.abs(sorted.reduce((sum, r) => sum + r.event_normalized_weight, 0) - e.gt_confidence) > POLICY.numeric.weight_tolerance * Math.max(1, sorted.length)) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'WEIGHT_SUM' });
  }
  const counts = { events: eventRows.length, samples: rows.length, model_filter_matched_samples: matched };
  for (const k of POLICY.eligibility) {
    counts[`${k.toLowerCase()}_events`] = eventRows.filter(e => e.eligibility === k).length;
    counts[`${k.toLowerCase()}_samples`] = rows.filter(e => e.eligibility === k).length;
  }
  for (const k of POLICY.splits) counts[`${k.toLowerCase()}_samples`] = rows.filter(e => e.split === k).length;
  if (selected.model_versions && !matched) planned.blockers.push('MODEL_FILTER_MATCHED_NO_SNAPSHOTS');
  const plan = { ...planned, counts, selection: selected, primary_gt_label: distribution(primaryEvents, 'gt_label', [...POLICY.labels, null]), primary_gt_status: distribution(primaryEvents, 'gt_status', POLICY.statuses) };
  progress.stage('汇总划分计划与统计');
  const stats = statistics(eventRows, rows, counts, inputSummary, version);
  return { version, events: eventRows, rows, plan, counts, statistics: stats, balance: stats.splits };
}
