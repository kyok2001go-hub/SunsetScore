import path from 'node:path';
import { canonicalJson, compare, hash, readSafe, safePath, within } from '../dataset/lib/common.mjs';
import { inspectGovernancePackage, inspectGovernanceSnapshot, publishGovernancePackage } from '../experiment-runtime/lib/package.mjs';
import { outside } from '../tuning/lib/input.mjs';
import { withGovernanceLeases } from '../experiment-runtime/lib/lease.mjs';
import { protectExternalReferences } from '../experiment-runtime/lib/references.mjs';
import { recordLedger } from '../validation/lib/disclosure.mjs';
import { teamConfirmationPayloads } from './team-confirmation.mjs';
import { artifactDatasetRoot, assert, day, equal, FIXED_MAPPING, fixtureUsage, intersects, keys, LABELS,
  member, members, sha, snapshot, sourceRef, text, utc } from '../formal/contracts.mjs';

export const SEMANTIC_POLICY = Object.freeze({ semantic_policy_version: 1,
  task: 'SUNSET_AESTHETIC_FIVE_LEVEL', fixed_mapping: FIXED_MAPPING,
  independent_human_reviewers: 2, unassessable: 'NOT_AN_ORDINAL',
  single_reviewer_usage: 'PREPARATION_ONLY', excellent_support: 'SOFT_WARNING',
  acceptance: 'FROZEN_REVIEW_CRITERIA_AND_ACTUAL_HUMAN_CONCLUSION' });
export const REVIEW_CRITERIA = Object.freeze(['RUBRIC_COMPLETE', 'MAPPING_REVIEWED',
  'NO_MAJOR_UNRESOLVED_AMBIGUITY', 'EVIDENCE_SCOPE_REVIEWED', 'LIMITATIONS_REVIEWED']);
const ID_FIELDS = { metric_rubric: 'rubric_id', metric_pilot: 'pilot_id',
  metric_review_plan: 'review_plan_id', semantic_evidence: 'semantic_evidence_id' };
export const ROOTS = { metric_rubric: 'rubrics', metric_pilot: 'pilots', metric_review_plan: 'review_plans', semantic_evidence: '' };
const dateAt = (at, timezone) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  return ['year', 'month', 'day'].map(name => parts.find(p => p.type === name).value).join('-');
};
const schemaFor = kind => ({ semantic_schema_version: 1, package_kind: kind,
  labels: LABELS, unassessable: 'UNASSESSABLE', policy_sha256: hash(canonicalJson(SEMANTIC_POLICY)) });

export function checkRubric(spec) {
  keys(spec, ['rubric_specification_version', 'task', 'levels', 'observation_window',
    'evidence_selection_rule', 'event_aggregation_rule', 'unassessable_conditions', 'evidence_quality_rule']);
  assert(spec.rubric_specification_version === 1 && spec.task === SEMANTIC_POLICY.task, 'RUBRIC_TASK_INVALID');
  assert(Array.isArray(spec.levels) && spec.levels.length === 5, 'RUBRIC_LEVELS_INVALID');
  spec.levels.forEach((level, i) => {
    keys(level, ['label', 'ordinal', 'definition', 'boundary', 'example_refs']);
    assert(level.label === LABELS[i] && level.ordinal === i && text(level.definition) && text(level.boundary) &&
      Array.isArray(level.example_refs) && level.example_refs.every(sha), 'RUBRIC_LEVEL_INVALID');
  });
  keys(spec.observation_window, ['reference', 'before_minutes', 'after_minutes']);
  assert(spec.observation_window.reference === 'LOCAL_SUNSET' &&
    ['before_minutes', 'after_minutes'].every(k => Number.isInteger(spec.observation_window[k]) &&
      spec.observation_window[k] >= 0 && spec.observation_window[k] <= 1440), 'OBSERVATION_WINDOW_INVALID');
  assert(text(spec.evidence_selection_rule) && text(spec.event_aggregation_rule) && text(spec.evidence_quality_rule) &&
    Array.isArray(spec.unassessable_conditions) && spec.unassessable_conditions.length > 0 &&
    spec.unassessable_conditions.every(text), 'RUBRIC_RULES_INCOMPLETE');
  return spec;
}

function checkIndex(index, assets) {
  keys(index, ['evidence_index_schema_version', 'selection_rule', 'scope', 'samples']);
  assert(index.evidence_index_schema_version === 1 && text(index.selection_rule), 'EVIDENCE_INDEX_INVALID');
  keys(index.scope, ['locations', 'date_from', 'date_to', 'source_kinds', 'limitations']);
  const scope = index.scope; day(scope.date_from); day(scope.date_to);
  assert(scope.date_from <= scope.date_to && Array.isArray(scope.locations) && scope.locations.length > 0 &&
    scope.locations.every(text) && new Set(scope.locations).size === scope.locations.length &&
    Array.isArray(scope.source_kinds) && scope.source_kinds.length > 0 && scope.source_kinds.every(text) &&
    Array.isArray(scope.limitations) && scope.limitations.every(text), 'EVIDENCE_SCOPE_INVALID');
  assert(Array.isArray(index.samples) && index.samples.length > 0, 'SEMANTIC_SAMPLES_EMPTY');
  const seen = new Set();
  for (const row of index.samples) {
    keys(row, ['sample_key', 'event_id', 'location_key', 'event_date_local', 'timezone', 'sunset_at_utc',
      'observed_at_utc', 'source_kind', 'evidence_sha256', 'evidence_permission_attested']);
    const identity = member(row); assert(!seen.has(row.sample_key) &&
      row.sample_key === `sample_${hash(canonicalJson(identity)).slice(0, 20)}`, 'SAMPLE_KEY_INVALID'); seen.add(row.sample_key);
    assert(scope.locations.includes(row.location_key) && scope.source_kinds.includes(row.source_kind) &&
      row.event_date_local >= scope.date_from && row.event_date_local <= scope.date_to &&
      row.evidence_permission_attested === true && sha(row.evidence_sha256), 'EVIDENCE_SOURCE_INVALID');
    utc(row.observed_at_utc); const sunset = utc(row.sunset_at_utc);
    assert(text(row.timezone) && dateAt(sunset, row.timezone) === row.event_date_local, 'EVIDENCE_TIMEZONE_INVALID');
    const asset = assets[row.evidence_sha256];
    keys(asset, ['encoding', 'content', 'content_type']);
    assert(asset.encoding === 'base64' && text(asset.content_type) && typeof asset.content === 'string' &&
      Buffer.from(asset.content, 'base64').toString('base64') === asset.content &&
      hash(Buffer.from(asset.content, 'base64')) === row.evidence_sha256, 'EVIDENCE_ASSET_HASH_INVALID');
  }
  assert(members(index.samples).length === index.samples.length, 'DUPLICATE_SEMANTIC_EVENT');
  equal(Object.keys(assets).sort(compare), [...new Set(index.samples.map(x => x.evidence_sha256))].sort(compare), 'EVIDENCE_ASSET_INVENTORY');
  equal(index.samples, [...index.samples].sort((a, b) => compare(a.sample_key, b.sample_key)), 'SAMPLE_ORDER_INVALID');
  return index;
}

/** Import only a declared evidence index and assets, never Model predictions or split files. */
export async function importIndex(filename) {
  const root = path.dirname(await safePath(filename)), supplied = JSON.parse(await readSafe(filename));
  keys(supplied, ['evidence_index_schema_version', 'selection_rule', 'scope', 'samples']);
  assert(Array.isArray(supplied.samples), 'EVIDENCE_INDEX_INVALID');
  const assets = {}, samples = [];
  for (const row of supplied.samples) {
    keys(row, ['event_id', 'location_key', 'event_date_local', 'timezone', 'sunset_at_utc', 'observed_at_utc',
      'source_kind', 'evidence_sha256', 'evidence_permission_attested', 'asset_path', 'content_type']);
    assert(typeof row.asset_path === 'string' && !path.isAbsolute(row.asset_path) &&
      !row.asset_path.split(/[\\/]/).includes('..'), 'EVIDENCE_ASSET_PATH_INVALID');
    const assetPath = await safePath(path.join(root, row.asset_path)); assert(within(root, assetPath), 'EVIDENCE_ASSET_PATH_INVALID');
    const bytes = await readSafe(assetPath); assert(hash(bytes) === row.evidence_sha256, 'EVIDENCE_ASSET_HASH_INVALID');
    assets[row.evidence_sha256] = { encoding: 'base64', content: bytes.toString('base64'), content_type: row.content_type };
    const { asset_path, content_type, ...metadata } = row;
    samples.push({ sample_key: `sample_${hash(canonicalJson(member(row))).slice(0, 20)}`, ...metadata });
  }
  const index = { ...supplied, samples: samples.sort((a, b) => compare(a.sample_key, b.sample_key)) };
  checkIndex(index, assets); return { index, assets };
}

function checkAnnotations(document, index, rubric) {
  keys(document, ['annotation_schema_version', 'reviewer', 'submitted_at_utc', 'blind_declaration', 'annotations']);
  keys(document.reviewer, ['reviewer_id', 'kind']);
  assert(document.annotation_schema_version === 1 && text(document.reviewer.reviewer_id) &&
    ['HUMAN', 'AI_ASSISTANT'].includes(document.reviewer.kind), 'REVIEWER_INVALID'); utc(document.submitted_at_utc);
  keys(document.blind_declaration, ['prediction_hidden', 'candidate_hidden', 'prior_annotation_hidden']);
  assert(Object.values(document.blind_declaration).every(x => typeof x === 'boolean'), 'BLIND_DECLARATION_INVALID');
  assert(Array.isArray(document.annotations), 'ANNOTATIONS_INVALID');
  const seen = new Set();
  for (const row of document.annotations) {
    keys(row, ['sample_key', 'rating', 'reason']);
    assert(text(row.reason) && !seen.has(row.sample_key) && index.samples.some(x => x.sample_key === row.sample_key) &&
      [...LABELS, 'UNASSESSABLE'].includes(row.rating), 'ANNOTATION_IDENTITY_INVALID'); seen.add(row.sample_key);
    const sample = index.samples.find(x => x.sample_key === row.sample_key), window = rubric.observation_window;
    const delta = (Date.parse(sample.observed_at_utc) - Date.parse(sample.sunset_at_utc)) / 60000;
    assert(row.rating === 'UNASSESSABLE' || (delta >= -window.before_minutes && delta <= window.after_minutes), 'OBSERVATION_OUTSIDE_WINDOW');
  }
  equal([...seen].sort(compare), index.samples.map(x => x.sample_key).sort(compare), 'ANNOTATION_COVERAGE_INCOMPLETE');
  equal(document.annotations, [...document.annotations].sort((a, b) => compare(a.sample_key, b.sample_key)), 'ANNOTATION_ORDER_INVALID');
  return document;
}

function pilotSummary(document, index) {
  const byLevel = Object.fromEntries([...LABELS, 'UNASSESSABLE'].map(label => [label, document.annotations.filter(x => x.rating === label).length]));
  const n = byLevel.excellent;
  return { status: 'PILOT_SINGLE_REVIEWER', metric_readiness: 'WAITING_INDEPENDENT_REVIEW',
    sample_count: index.samples.length, by_level: byLevel, result_usage: 'PREPARATION_ONLY',
    limitations: [...index.scope.limitations, ...(n < 5 ? ['EXCELLENT_PERFORMANCE_NOT_ESTABLISHED'] : [])] };
}

export function rubricPayloads(spec, options = {}) {
  checkRubric(spec);
  return { 'schema.json': schemaFor('metric_rubric'), 'policy.json': SEMANTIC_POLICY,
    'rubric.json': spec, 'mapping_contract.json': FIXED_MAPPING,
    'summary.json': { status: 'DRAFT', result_usage: fixtureUsage(options) || 'PREPARATION_ONLY', metric_readiness: 'NOT_ATTESTED' } };
}
export function pilotPayloads(rubricPacket, imported, document, options = {}) {
  inspectMetricSnapshot(rubricPacket); assert(rubricPacket.manifest.id_field === 'rubric_id', 'RUBRIC_REQUIRED');
  checkIndex(imported.index, imported.assets); const rubric = rubricPacket.files['rubric.json'];
  checkAnnotations(document, imported.index, rubric);
  assert(document.reviewer.kind === 'HUMAN', 'PILOT_HUMAN_REQUIRED');
  return { 'schema.json': schemaFor('metric_pilot'), 'policy.json': SEMANTIC_POLICY,
    'rubric_source.json': snapshot(rubricPacket), 'evidence_index.json': imported.index, 'assets.json': imported.assets,
    'annotations.json': document, 'summary.json': { ...pilotSummary(document, imported.index),
      result_usage: fixtureUsage(options) || 'PREPARATION_ONLY' } };
}

function checkRules(rules) {
  keys(rules, ['acceptance_rules_version', 'criteria', 'rationale', 'maximum_disagreement_rate', 'maximum_unassessable_rate']);
  assert(rules.acceptance_rules_version === 1 && text(rules.rationale), 'ACCEPTANCE_RULES_MISSING');
  equal(rules.criteria, REVIEW_CRITERIA, 'ACCEPTANCE_CRITERIA_INVALID');
  for (const key of ['maximum_disagreement_rate', 'maximum_unassessable_rate']) {
    assert(rules[key] === null || (Number.isFinite(rules[key]) && rules[key] >= 0 && rules[key] <= 1), 'ACCEPTANCE_THRESHOLD_INVALID');
  } return rules;
}
export function reviewPlanPayloads({ rubric, pilot, imported, firstAnnotations, specification }, options = {}) {
  inspectMetricSnapshot(rubric); inspectMetricSnapshot(pilot);
  assert(rubric.manifest.id_field === 'rubric_id' && pilot.manifest.id_field === 'pilot_id', 'REVIEW_SOURCES_INVALID');
  checkIndex(imported.index, imported.assets); checkAnnotations(firstAnnotations, imported.index, rubric.files['rubric.json']);
  assert(!intersects(members(imported.index.samples), members(pilot.files['evidence_index.json'].samples)).length, 'PILOT_REVIEW_OVERLAP');
  assert(!Object.keys(imported.assets).some(key => Object.hasOwn(pilot.files['assets.json'], key)), 'PILOT_REVIEW_EVIDENCE_OVERLAP');
  const rubricSpec = rubric.files['rubric.json'];
  assert(rubricSpec.levels.filter(x => x.ordinal !== 4).every(x => x.example_refs.length > 0) &&
    rubricSpec.levels.every(x => x.example_refs.every(key => Object.hasOwn(pilot.files['assets.json'], key) || Object.hasOwn(imported.assets, key))), 'RUBRIC_EXAMPLES_INCOMPLETE');
  assert(firstAnnotations.reviewer.kind === 'HUMAN' && Object.values(firstAnnotations.blind_declaration).every(x => x), 'FIRST_BLIND_REVIEW_REQUIRED');
  keys(specification, ['review_plan_schema_version', 'frozen_at_utc', 'acceptance_rules', 'independence_declaration']);
  assert(specification.review_plan_schema_version === 1, 'REVIEW_PLAN_VERSION_INVALID');
  assert(utc(firstAnnotations.submitted_at_utc) <= utc(specification.frozen_at_utc), 'REVIEW_PLAN_TIMELINE_INVALID');
  checkRules(specification.acceptance_rules);
  keys(specification.independence_declaration, ['review_not_used_for_rubric_adjustment', 'selection_not_based_on_candidate_errors']);
  assert(Object.values(specification.independence_declaration).every(x => x === true), 'REVIEW_INDEPENDENCE_NOT_ATTESTED');
  const template = { annotation_schema_version: 1, reviewer: { reviewer_id: '<真实第二人ID>', kind: 'HUMAN' },
    submitted_at_utc: '<实际UTC提交时间>', blind_declaration: { prediction_hidden: false, candidate_hidden: false, prior_annotation_hidden: false },
    annotations: imported.index.samples.map(row => ({ sample_key: row.sample_key, rating: null, reason: '' })) };
  return { 'schema.json': schemaFor('metric_review_plan'), 'policy.json': SEMANTIC_POLICY,
    'rubric_source.json': snapshot(rubric), 'pilot_source.json': snapshot(pilot),
    'review_plan.json': specification, 'evidence_index.json': imported.index, 'assets.json': imported.assets,
    'first_annotations.json': firstAnnotations, 'blind_template.json': template,
    'blind_evidence.json': { task: SEMANTIC_POLICY.task, rubric: rubric.files['rubric.json'],
      samples: imported.index.samples.map(row => ({ sample_key: row.sample_key, evidence_sha256: row.evidence_sha256,
        source_kind: row.source_kind, minutes_relative_to_sunset:
          (Date.parse(row.observed_at_utc) - Date.parse(row.sunset_at_utc)) / 60000 })),
      assets: { ...imported.assets, ...Object.fromEntries(rubricSpec.levels.flatMap(x => x.example_refs)
        .map(key => [key, pilot.files['assets.json'][key] || imported.assets[key]])) } },
    'summary.json': { status: 'WAITING_INDEPENDENT_REVIEW', metric_readiness: 'WAITING_INDEPENDENT_REVIEW',
      result_usage: fixtureUsage(options) || 'PREPARATION_ONLY', sample_count: imported.index.samples.length } };
}

export function reviewPayloads(plan, second, conclusion, options = {}) {
  inspectMetricSnapshot(plan); assert(plan.manifest.id_field === 'review_plan_id', 'REVIEW_PLAN_REQUIRED');
  const index = plan.files['evidence_index.json'], first = plan.files['first_annotations.json'];
  const rubric = plan.files['rubric_source.json'].files['rubric.json']; checkAnnotations(second, index, rubric);
  assert(second.reviewer.kind === 'HUMAN' && second.reviewer.reviewer_id !== first.reviewer.reviewer_id &&
    Object.values(second.blind_declaration).every(x => x), 'INDEPENDENT_SECOND_HUMAN_REQUIRED');
  const frozen = utc(plan.files['review_plan.json'].frozen_at_utc);
  assert(frozen <= utc(second.submitted_at_utc), 'SECOND_REVIEW_BEFORE_PLAN');
  keys(conclusion, ['review_conclusion_schema_version', 'review_plan_id', 'reviewer_id', 'reviewed_at_utc',
    'criteria', 'adjudications', 'scope_accepted', 'application_scope', 'mapping_accepted', 'limitations', 'remarks']);
  keys(conclusion.application_scope, ['locations', 'date_from', 'date_to', 'source_kinds', 'limitations']);
  day(conclusion.application_scope.date_from); day(conclusion.application_scope.date_to);
  assert(conclusion.application_scope.date_from <= conclusion.application_scope.date_to &&
    ['locations', 'source_kinds'].every(key => Array.isArray(conclusion.application_scope[key]) &&
      conclusion.application_scope[key].length > 0 && conclusion.application_scope[key].every(text)) &&
    Array.isArray(conclusion.application_scope.limitations) && conclusion.application_scope.limitations.every(text), 'APPLICATION_SCOPE_INVALID');
  assert(conclusion.review_conclusion_schema_version === 1 && conclusion.review_plan_id === plan.manifest.review_plan_id &&
    [first.reviewer.reviewer_id, second.reviewer.reviewer_id].includes(conclusion.reviewer_id) &&
    utc(conclusion.reviewed_at_utc) >= utc(second.submitted_at_utc) && text(conclusion.remarks) &&
    typeof conclusion.scope_accepted === 'boolean' && typeof conclusion.mapping_accepted === 'boolean' &&
    Array.isArray(conclusion.limitations) && conclusion.limitations.every(text), 'REVIEW_CONCLUSION_INVALID');
  equal(Object.keys(conclusion.criteria).sort(compare), [...REVIEW_CRITERIA].sort(compare), 'REVIEW_CRITERIA_INCOMPLETE');
  for (const value of Object.values(conclusion.criteria)) {
    keys(value, ['pass', 'reason']); assert(typeof value.pass === 'boolean' && text(value.reason), 'REVIEW_CRITERION_INVALID');
  }
  const secondById = new Map(second.annotations.map(x => [x.sample_key, x]));
  const differences = first.annotations.filter(x => x.rating !== secondById.get(x.sample_key).rating).map(x => ({
    sample_key: x.sample_key, first_rating: x.rating, second_rating: secondById.get(x.sample_key).rating }));
  assert(Array.isArray(conclusion.adjudications), 'ADJUDICATIONS_INVALID');
  equal(conclusion.adjudications.map(x => x.sample_key).sort(compare), differences.map(x => x.sample_key).sort(compare), 'ADJUDICATION_COVERAGE_INCOMPLETE');
  for (const value of conclusion.adjudications) {
    keys(value, ['sample_key', 'final_rating', 'reason', 'major_ambiguity_resolved']);
    assert([...LABELS, 'UNASSESSABLE'].includes(value.final_rating) && text(value.reason) &&
      typeof value.major_ambiguity_resolved === 'boolean', 'ADJUDICATION_INVALID');
  }
  const adjudications = new Map(conclusion.adjudications.map(x => [x.sample_key, x]));
  const final = first.annotations.map(x => ({ sample_key: x.sample_key, rating: adjudications.get(x.sample_key)?.final_rating || x.rating }));
  const rules = plan.files['review_plan.json'].acceptance_rules, n = final.length;
  const unassessable = final.filter(x => x.rating === 'UNASSESSABLE').length;
  const byLevel = Object.fromEntries(LABELS.map(label => [label, final.filter(x => x.rating === label).length]));
  const reasons = [];
  if (!conclusion.mapping_accepted) reasons.push('MAPPING_REVIEW_FAILED');
  if (!conclusion.scope_accepted || Object.values(conclusion.criteria).some(x => !x.pass)) reasons.push('SEMANTIC_REVIEW_FAILED');
  if (conclusion.adjudications.some(x => !x.major_ambiguity_resolved)) reasons.push('MAJOR_AMBIGUITY_UNRESOLVED');
  if (rules.maximum_disagreement_rate !== null && differences.length / n > rules.maximum_disagreement_rate) reasons.push('DISAGREEMENT_LIMIT_EXCEEDED');
  if (rules.maximum_unassessable_rate !== null && unassessable / n > rules.maximum_unassessable_rate) reasons.push('UNASSESSABLE_LIMIT_EXCEEDED');
  const insufficient = n === unassessable;
  const status = insufficient ? 'INSUFFICIENT_EVIDENCE' : reasons.length ? 'REVIEWED_FAIL' : 'REVIEWED_PASS';
  const summary = { status, metric_readiness: status === 'REVIEWED_PASS' ? 'READY' : 'NOT_READY',
    result_usage: fixtureUsage(options) || (status === 'REVIEWED_PASS' ? 'FORMAL' : 'PREPARATION_ONLY'),
    reasons, sample_count: n, disagreement_count: differences.length, disagreement_rate: differences.length / n,
    agreement_rate: (n - differences.length) / n, unassessable_rate: unassessable / n,
    disagreement_types: Object.fromEntries([...new Set(differences.map(x => `${x.first_rating}->${x.second_rating}`))].sort(compare)
      .map(type => [type, differences.filter(x => `${x.first_rating}->${x.second_rating}` === type).length])),
    unassessable_count: unassessable, by_level: byLevel, final_annotations: final,
    limitations: [...new Set([...index.scope.limitations, ...conclusion.limitations,
      ...(byLevel.excellent < 5 ? ['EXCELLENT_PERFORMANCE_NOT_ESTABLISHED'] : [])])].sort(compare) };
  const mapping = { ...FIXED_MAPPING, rubric: sourceRef(plan.files['rubric_source.json']),
    review_plan: sourceRef(plan), scope: conclusion.application_scope, limitations: [...summary.limitations, ...conclusion.application_scope.limitations] };
  return { 'schema.json': schemaFor('semantic_evidence'), 'policy.json': SEMANTIC_POLICY,
    'review_plan_source.json': snapshot(plan), 'second_annotations.json': second,
    'review_conclusion.json': conclusion, 'differences.json': differences,
    'mapping_contract.json': mapping, 'summary.json': summary };
}

export function inspectMetricSnapshot(input) {
  const packet = inspectGovernanceSnapshot(input), kind = packet.manifest.descriptor.package_kind, f = packet.files;
  assert(Object.hasOwn(ID_FIELDS, kind), 'METRIC_KIND_INVALID');
  // Recompute bodies without trusting caller supplied READY, counts or adjudication summaries.
  let expected;
  if (kind === 'metric_rubric') expected = rubricPayloads(f['rubric.json']);
  if (kind === 'metric_pilot') expected = pilotPayloads(f['rubric_source.json'], { index: f['evidence_index.json'], assets: f['assets.json'] }, f['annotations.json']);
  if (kind === 'metric_review_plan') expected = reviewPlanPayloads({ rubric: f['rubric_source.json'], pilot: f['pilot_source.json'],
    imported: { index: f['evidence_index.json'], assets: f['assets.json'] }, firstAnnotations: f['first_annotations.json'], specification: f['review_plan.json'] });
  if (kind === 'semantic_evidence') expected = f['schema.json']?.semantic_schema_version === 2
    ? teamConfirmationPayloads(f['team_confirmation.json'], f['team_sources.json'])
    : reviewPayloads(f['review_plan_source.json'], f['second_annotations.json'], f['review_conclusion.json']);
  if (f['summary.json']?.result_usage === 'TEST_FIXTURE_ONLY') expected['summary.json'].result_usage = 'TEST_FIXTURE_ONLY';
  equal(f, expected, 'METRIC_DERIVED_CONTENT_MISMATCH');
  const expectedLinks = metricLinks(kind, f);
  const { governance_schema_version, package_kind, files, ...links } = packet.manifest.descriptor;
  equal(links, expectedLinks, 'METRIC_SOURCE_LINKS_MISMATCH');
  return packet;
}
function metricLinks(kind, payloads) {
  if (kind === 'semantic_evidence' && payloads['schema.json']?.semantic_schema_version === 2)
    return { source_ids: payloads['team_confirmation.json'].source_ids, result_usage: payloads['summary.json'].result_usage };
  const links = {};
  for (const [file, name] of [['rubric_source.json', 'rubric'], ['pilot_source.json', 'pilot'], ['review_plan_source.json', 'review_plan']]) {
    if (payloads[file]) { const source = sourceRef(payloads[file]); links[`${name}_id`] = source.id; links[`${name}_manifest_sha256`] = source.manifest_sha256; }
  }
  return { ...links, result_usage: payloads['summary.json'].result_usage };
}
export function semanticPreparationMembers(packet) {
  inspectMetricSnapshot(packet);
  if (packet.files['schema.json'].semantic_schema_version === 2) return [];
  const plan = packet.files['review_plan_source.json'];
  return [...plan.files['evidence_index.json'].samples, ...plan.files['pilot_source.json'].files['evidence_index.json'].samples];
}
export async function inspectMetricPackage(directory) {
  const result = inspectMetricSnapshot(await inspectGovernancePackage(directory));
  assert(path.basename(path.resolve(directory)) === result.manifest[result.manifest.id_field], 'METRIC_DIRECTORY_ID_MISMATCH');
  return result;
}
export async function publishMetric(kind, payloads, { output = path.resolve('dataset/metric_semantics'), sourceDirectories = [], accessLedger = path.resolve('dataset/validation/access-ledger') } = {}) {
  const destination = await outside(path.join(output, ROOTS[kind]), sourceDirectories);
  return withGovernanceLeases(kind, [path.dirname(output), path.resolve(accessLedger, '../..'), ...sourceDirectories.map(artifactDatasetRoot)], async () => {
    const before = await Promise.all(sourceDirectories.map(inspectMetricPackage));
    const sourceCheck = async () => {
      const after = await Promise.all(sourceDirectories.map(inspectMetricPackage));
      equal(before.map(sourceRef), after.map(sourceRef), 'METRIC_SOURCE_CHANGED');
    };
    const index = payloads['evidence_index.json'] || payloads['review_plan_source.json']?.files['evidence_index.json'];
    if (index) await recordLedger(accessLedger, { action: 'SEMANTIC_USE_REGISTERED', usage: kind,
      source_payload_sha256: hash(canonicalJson(payloads)), members: members(index.samples) });
    await protectExternalReferences(sourceDirectories.map(artifactDatasetRoot), destination);
    const result = await publishGovernancePackage({ output: destination, kind, idField: ID_FIELDS[kind], payloads,
      links: metricLinks(kind, payloads), sourceCheck,
      validateStaging: async dir => inspectMetricSnapshot(await inspectGovernancePackage(dir)) });
    await inspectMetricPackage(result.directory); return result;
  });
}
