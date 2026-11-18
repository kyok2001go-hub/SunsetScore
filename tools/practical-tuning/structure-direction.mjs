// V2.5.5.24 necessary-condition structure and direction fixes (Practical Tuning Schema/Policy 18): frozen plan and pure evaluation.
// PRD: ref_docs/PRD/V2.5.5.24--必要条件结构与方向纠正评估方案.md
// Three candidate families, each a single default-off engine key selected inside the training folds together with its own grade
// lines and compared with a lines-only recalibration (L0):
//   A canvasLightAccess.gamma — sky-canvas and illumination contributions × (corridor opening / 100)^gamma;
//   B gradientDirection       — NEUTRAL / REVERSED use of the far-minus-near cloud gradient (structure score, bonus, trend);
//   C viewOcclusion.alpha     — sky-canvas and illumination contributions × (1 − alpha × local low cloud / 100).
// Selection, cross-validation, AUC, Brier, cross-period checks and gates G1–G5 reuse the Policy 17 functions unchanged.
// A combination is evaluated only when at least two families pass; at most one recommendation goes to H4.
import { fail } from '../dataset/lib/common.mjs';
import { primaryLast, aucEvaluator, bootstrapInterval } from './p0-diagnostics.mjs';
import { grade, foldsOf } from './horizon-potential.mjs';
import { HP2_POLICY, selectLines, summarize2 } from './horizon-potential-v2.mjs';
import { selectMember, compareCv, aucDelta, brierCv, crossPeriod, gatesOf } from './penalty-weights.mjs';

const freeze = value => Object.freeze(value);
export const SD_POLICY = freeze({
  practical_tuning_schema_version: 18, practical_tuning_policy_version: 18, search_space: 'structure-direction',
  usage: 'PERSONAL_PROJECT_DIAGNOSTICS', evaluation_scope: 'REUSED_DEVELOPMENT_DATA',
  pools: HP2_POLICY.pools, h3_first_date: HP2_POLICY.h3_first_date, live_parity_model_versions: HP2_POLICY.live_parity_model_versions,
  baseline: 'RELEASE_LINE_2.5.5.19',
  baseline_reference: freeze({ run_id: 'practical_tuning_v15_462a4c08949a2e9bba34', key: 'HA_f0.7_k5',
    signature_sha256: 'ae1ded3b0eceb491c1d7fd54679befd5f5239cc8c12730250038fc78de730f1c' }),
  grids: freeze({ A: freeze([0, 0.5, 1, 2]), B: freeze([null, 'NEUTRAL', 'REVERSED']), C: freeze([0, 0.3, 0.6, 0.9]) }),
  // Line rule, recall scope, review table, folds, bootstrap, AUC tolerance and floors: identical to Policy 15 / 17.
  lines: HP2_POLICY.lines, review: HP2_POLICY.review, brier: HP2_POLICY.brier, folds: HP2_POLICY.folds,
  bootstrap: HP2_POLICY.bootstrap, auc_drop_tolerance: HP2_POLICY.auc_drop_tolerance, low_potential_below: HP2_POLICY.low_potential_below,
  report_subgroups: freeze({ corridor_opening_below: 80, gradient_abs_at_least: 30, local_low_at_least: 50 }),
  max_combination_members: 32,
  decision_rules_version: 1
});
export const FAMILIES = freeze(['A', 'B', 'C']);

// ---------- member keys and configs ----------
// A member is { A: gamma, B: direction|null, C: alpha }; the current setting of every family is { A: 0, B: null, C: 0 }.
export const CURRENT = freeze({ A: 0, B: null, C: 0 });
const partKey = { A: g => g === 0 ? null : `A_g${g}`, B: d => d == null ? null : `B_${d}`, C: a => a === 0 ? null : `C_a${a}` };
export const memberKey = m => { const parts = FAMILIES.map(f => partKey[f](m[f] ?? CURRENT[f])).filter(Boolean); return parts.length ? parts.join('+') : 'C0'; };
export function parseMemberKey(key) {
  const m = { ...CURRENT };
  if (key === 'C0') return m;
  for (const part of key.split('+')) {
    let x;
    if ((x = /^A_g([\d.]+)$/.exec(part))) m.A = Number(x[1]);
    else if ((x = /^B_(NEUTRAL|REVERSED)$/.exec(part))) m.B = x[1];
    else if ((x = /^C_a([\d.]+)$/.exec(part))) m.C = Number(x[1]);
    else fail('SD_BAD_MEMBER_KEY', { detail: key });
  }
  return m;
}
/** Scoring config: only the configured keys are added; the current setting of a family leaves its key absent. */
export function candidateConfig(base, member) {
  const config = structuredClone(base), m = { ...CURRENT, ...member };
  if (m.A !== 0) config.canvasLightAccess = { gamma: m.A };
  if (m.B != null) config.gradientDirection = m.B;
  if (m.C !== 0) config.viewOcclusion = { alpha: m.C };
  return config;
}
/** Neutral config used for the C0 trace: both multiplicative keys present at their identity values (factor exactly 1). */
export const neutralConfig = base => ({ ...structuredClone(base), canvasLightAccess: { gamma: 0 }, viewOcclusion: { alpha: 0 } });
/** Family members with the current setting (C0) first, so a tie in training loss keeps the current value. */
export const familyKeys = (family, policy = SD_POLICY) => ['C0', ...policy.grids[family].map(v => memberKey({ [family]: v })).filter(k => k !== 'C0')];

// ---------- evaluation (Policy 17 functions on Policy 18 members) ----------
const q = v => Number.isFinite(v) ? Number(v.toFixed(6)) : null;
const chooser = (keys, policy) => trainRows => { const x = selectMember(trainRows, keys, policy); if (!x) fail('SD_NO_FEASIBLE_LINES'); return x.key; };
function crossValidateFixed(rows, k, keyOfFold, policy) {
  const folds = [], assign = new Map();
  foldsOf(rows, k).forEach((fold, i) => {
    const held = new Set(fold), train = rows.filter(r => !held.has(r.event_date_local)), key = keyOfFold(train, i);
    const l0 = selectLines(train, 'C0', policy), x = selectLines(train, key, policy);
    if (!l0 || !x) fail('SD_NO_FEASIBLE_LINES');
    folds.push({ dates: [fold[0], fold.at(-1)], L0_lines: l0.lines, member: key, member_lines: x.lines });
    for (const d of fold) assign.set(d, { L0: l0.lines, key, lines: x.lines });
  });
  const list = rows.map(r => { const a = assign.get(r.event_date_local);
    return { ...r, ordL0: grade(r.scores.C0, a.L0), ordX: grade(r.scores[a.key], a.lines), scoreX: r.scores[a.key], keyX: a.key }; });
  return { folds, list };
}
const crossValidate = (rows, k, keys, policy) => crossValidateFixed(rows, k, train => chooser(keys, policy)(train), policy);
export function breakdowns(cv, policy = SD_POLICY) {
  const list = cv.list, s = policy.report_subgroups;
  const miss = (x, f) => x.filter(r => r.gt_ordinal >= 2 && r[f] <= 1).length, fa = (x, f) => x.filter(r => r.gt_ordinal <= 1 && r[f] >= 2).length;
  const pair = x => ({ snapshots: x.length, gt_ge2_snapshots: x.filter(r => r.gt_ordinal >= 2).length, gt_ge3_snapshots: x.filter(r => r.gt_ordinal >= 3).length,
    L0: { ...summarize2(x, r => r.ordL0), false_alarm_snapshots: fa(x, 'ordL0'), missed_ge2_snapshots: miss(x, 'ordL0') },
    candidate: { ...summarize2(x, r => r.ordX), false_alarm_snapshots: fa(x, 'ordX'), missed_ge2_snapshots: miss(x, 'ordX') },
    mean_score_change: x.length ? q(x.reduce((a, r) => a + (r.scoreX - r.scores.C0), 0) / x.length) : null });
  const by = fn => Object.fromEntries([...new Set(list.map(fn))].sort().map(k => [k, pair(list.filter(r => fn(r) === k))]));
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  return { by_pool: by(r => r.pool), by_slot: by(r => r.slot),
    corridor_opening_below: pair(list.filter(r => fin(r.corridor_opening) && r.corridor_opening < s.corridor_opening_below)),
    gradient_at_most_minus: pair(list.filter(r => fin(r.gradient) && r.gradient <= -s.gradient_abs_at_least)),
    gradient_at_least: pair(list.filter(r => fin(r.gradient) && r.gradient >= s.gradient_abs_at_least)),
    local_low_at_least: pair(list.filter(r => fin(r.local_low) && r.local_low >= s.local_low_at_least)) };
}
function assess(rows, cv5, cv11, brierChooser, periodKeys, label, current, policy, extra = {}) {
  const A = { cv5: { folds: cv5.folds, ...compareCv(cv5, label + '5', policy) }, cv11: { folds: cv11.folds, ...compareCv(cv11, label + '11', policy) },
    auc: aucDelta(cv5, label, policy), brier: { cv5: brierCv(rows, 5, brierChooser(5, cv5), label + '5', policy), cv11: brierCv(rows, 11, brierChooser(11, cv11), label + '11', policy) },
    cross_period: [crossPeriod(rows, ['DEV'], ['H1', 'H2'], periodKeys(0), policy), crossPeriod(rows, ['H1', 'H2'], ['DEV'], periodKeys(1), policy)], ...extra };
  const { gates, paths } = gatesOf(A, policy), worth = Object.values(gates).every(Boolean);
  const linesHelp = A.cv5.reference.product_loss < current.product_loss;
  return { ...A, gates, G1_paths: paths, decision: worth ? 'WORTH_H4' : !gates.G1_better_than_L0 && linesHelp ? 'LINES_SUFFICIENT' : 'NO_GAIN',
    chosen_members: { cv5: cv5.folds.map(f => f.member), cv11: cv11.folds.map(f => f.member) }, report: breakdowns(cv5, policy) };
}
/** One family: members selected in the training folds; cross-validation, AUC, Brier, cross-period, gates and decision. */
export function evaluateFamily(rows, family, current, policy = SD_POLICY) {
  const keys = familyKeys(family, policy), cv5 = crossValidate(rows, 5, keys, policy), cv11 = crossValidate(rows, 11, keys, policy);
  return assess(rows, cv5, cv11, () => chooser(keys, policy), () => keys, family, current, policy, { full_data_choice: selectMember(rows, keys, policy) });
}
export function evaluateFamilies(rows, policy = SD_POLICY) {
  const current = summarize2(rows, r => grade(r.scores.C0, policy.lines.current));
  return { current, ...Object.fromEntries(FAMILIES.map(f => [f, evaluateFamily(rows, f, current, policy)])) };
}
export const passing = families => FAMILIES.filter(f => families[f].decision === 'WORTH_H4');
export const needsCombination = families => passing(families).length >= 2;
const combine = (families, members, pick) => memberKey(Object.fromEntries(members.map(f => [f, parseMemberKey(pick(families[f]))[f]])));
/** Combination members: in every fold / cross-period direction / full data, the tuple of the passing families' own choices. */
export function combinationMembers(families) {
  const members = passing(families), keys = new Set();
  for (const k of ['cv5', 'cv11']) families[members[0]][k].folds.forEach((_, i) => keys.add(combine(families, members, F => F[k].folds[i].member)));
  [0, 1].forEach(i => { if (members.every(f => families[f].cross_period[i].feasible)) keys.add(combine(families, members, F => F.cross_period[i].member)); });
  if (members.every(f => families[f].full_data_choice)) keys.add(combine(families, members, F => F.full_data_choice.key));
  return [...keys].filter(k => k !== 'C0');
}
export function evaluateCombination(rows, families, current, policy = SD_POLICY) {
  const members = passing(families);
  const foldKey = k => (train, i) => combine(families, members, F => F[`cv${k}`].folds[i].member);
  const cv5 = crossValidateFixed(rows, 5, foldKey(5), policy), cv11 = crossValidateFixed(rows, 11, foldKey(11), policy);
  const periodKey = i => [combine(families, members, F => F.cross_period[i].member ?? 'C0')];
  const out = assess(rows, cv5, cv11, (k, cv) => (trainRows, i) => cv.folds[i].member, periodKey, 'X', current, policy, { members });
  return { ...out, decision: out.decision === 'WORTH_H4' ? 'WORTH_H4' : 'NO_GAIN' };
}
/** Final decision. combinationRows (rows carrying the combination members' scores) is required only when two or more families pass. */
export function evaluateAll(rows, policy = SD_POLICY, families = evaluateFamilies(rows, policy), combinationRows = null) {
  let combination = null;
  if (needsCombination(families)) {
    if (!combinationRows) fail('SD_COMBINATION_ROWS_MISSING');
    combination = evaluateCombination(combinationRows, families, families.current, policy);
  }
  const worth = passing(families);
  const best = worth.length ? worth.reduce((a, b) => families[b].cv5.candidate.product_loss < families[a].cv5.candidate.product_loss ? b : a) : null;
  const recommended = combination && combination.decision === 'WORTH_H4' && combination.cv5.candidate.product_loss < families[best].cv5.candidate.product_loss
    ? combination.members.join('+') : best;
  // Report only: every member at the current lines, and every member's ranking without lines.
  const pl = primaryLast(rows), w = pl.map(r => r.gt_confidence);
  const aucOf = (key, t) => q(aucEvaluator(pl.map(r => r.scores[key]), pl.map(r => r.gt_ordinal >= t))(w));
  const allKeys = [...new Set(FAMILIES.flatMap(f => familyKeys(f, policy)))];
  const atCurrent = Object.fromEntries(allKeys.map(k => [k, { ...summarize2(rows, r => grade(r.scores[k], policy.lines.current)), auc_ge2: aucOf(k, 2), auc_ge3: aucOf(k, 3) }]));
  const decision = recommended ? 'WORTH_H4' : FAMILIES.some(f => families[f].decision === 'LINES_SUFFICIENT') ? 'LINES_SUFFICIENT' : 'NO_GAIN';
  return { current_lines_C0: families.current, ...Object.fromEntries(FAMILIES.map(f => [f, families[f]])), combination, recommended, decision,
    report_only: { members_at_current_lines: atCurrent, full_data_lines: { L0: selectLines(rows, 'C0', policy)?.lines ?? null } },
    rules_version: policy.decision_rules_version, requires_owner_confirmation: true, role: 'DEVELOPMENT_EVIDENCE_ONLY_NO_RELEASE' };
}
