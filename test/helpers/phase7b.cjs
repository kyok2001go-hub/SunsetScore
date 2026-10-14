const fs = require('node:fs/promises');
const path = require('node:path');
const appRoot = path.resolve(__dirname, '../..');

async function modules() {
  const common = await import('../../tools/dataset/lib/common.mjs');
  const contract = await import('../../tools/formal/contracts.mjs');
  const metric = await import('../../tools/metric-semantics/semantics.mjs');
  return { ...common, ...contract, ...metric };
}
async function importedSamples(prefix, dayValue, count = 4) {
  const { canonicalJson, hash } = await modules();
  const assets = {}, samples = [];
  for (let i = 0; i < count; i++) {
    const id = { event_id: `${prefix}_${i}`, location_key: `location_${i}`, event_date_local: dayValue };
    // Synthetic source is permanently TEST_FIXTURE_ONLY; it is not a real image/human statement.
    const bytes = Buffer.from(`TEST_FIXTURE_ONLY ${prefix} evidence ${i}`), digest = hash(bytes);
    assets[digest] = { encoding: 'base64', content: bytes.toString('base64'), content_type: 'text/plain' };
    samples.push({ sample_key: `sample_${hash(canonicalJson(id)).slice(0, 20)}`, ...id, timezone: 'Asia/Shanghai',
      sunset_at_utc: `${dayValue}T09:30:00Z`, observed_at_utc: `${dayValue}T09:15:00Z`,
      source_kind: 'rednote_manual', evidence_sha256: digest, evidence_permission_attested: true });
  }
  samples.sort((a, b) => a.sample_key < b.sample_key ? -1 : a.sample_key > b.sample_key ? 1 : 0);
  return { assets, index: { evidence_index_schema_version: 1, selection_rule: 'Frozen synthetic selection, never real qualification.',
    scope: { locations: Array.from({ length: count }, (_, i) => `location_${i}`), date_from: dayValue, date_to: dayValue,
      source_kinds: ['rednote_manual'], limitations: ['TEST_FIXTURE_ONLY'] }, samples } };
}
function annotations(imported, reviewerId, at) {
  return { annotation_schema_version: 1, reviewer: { reviewer_id: reviewerId, kind: 'HUMAN' }, submitted_at_utc: at,
    blind_declaration: { prediction_hidden: true, candidate_hidden: true, prior_annotation_hidden: true },
    annotations: imported.index.samples.map((x, i) => ({ sample_key: x.sample_key,
      rating: ['poor', 'fair', 'good', 'very_good'][i % 4], reason: 'Synthetic fixture label, not an actual human review.' })) };
}
async function metricFixture(root, options = {}) {
  const m = await modules(), test = { testFixture: m.TEST_FIXTURE }, output = path.join(root, 'metric_semantics');
  const accessLedger = path.join(root, 'validation/access-ledger');
  const pilotInput = await importedSamples('pilot', '2025-01-01');
  const spec = JSON.parse(await fs.readFile(path.join(appRoot, 'tools/metric-semantics/templates/rubric.specification.json')));
  const publish = (kind, bodies, directories = []) => m.publishMetric(kind, bodies, { output, accessLedger, sourceDirectories: directories });
  const draft = await publish('metric_rubric', m.rubricPayloads(spec, test));
  const draftPacket = await m.inspectMetricPackage(draft.directory);
  const firstPilot = annotations(pilotInput, 'fixture_first_human', '2025-01-02T00:00:00Z');
  const pilot = await publish('metric_pilot', m.pilotPayloads(draftPacket, pilotInput, firstPilot, test), [draft.directory]);
  const revised = structuredClone(spec);
  revised.levels.forEach((level, i) => { if (i < 4) level.example_refs = [Object.keys(pilotInput.assets)[i]]; });
  const rubric = await publish('metric_rubric', m.rubricPayloads(revised, test));
  const rubricPacket = await m.inspectMetricPackage(rubric.directory), pilotPacket = await m.inspectMetricPackage(pilot.directory);
  const reviewInput = await importedSamples('independent_review', '2025-01-03');
  const first = annotations(reviewInput, 'fixture_first_human', '2025-01-04T00:00:00Z');
  const specification = { review_plan_schema_version: 1, frozen_at_utc: '2025-01-05T00:00:00Z',
    acceptance_rules: { acceptance_rules_version: 1, criteria: m.REVIEW_CRITERIA, rationale: 'Frozen qualitative fixture criteria.',
      maximum_disagreement_rate: null, maximum_unassessable_rate: null },
    independence_declaration: { review_not_used_for_rubric_adjustment: true, selection_not_based_on_candidate_errors: true } };
  const review = await publish('metric_review_plan', m.reviewPlanPayloads({ rubric: rubricPacket, pilot: pilotPacket,
    imported: reviewInput, firstAnnotations: first, specification }, test), [rubric.directory, pilot.directory]);
  const plan = await m.inspectMetricPackage(review.directory);
  const second = annotations(reviewInput, 'fixture_second_human', '2025-01-06T00:00:00Z');
  const conclusion = { review_conclusion_schema_version: 1, review_plan_id: plan.manifest.review_plan_id,
    reviewer_id: 'fixture_second_human', reviewed_at_utc: '2025-01-07T00:00:00Z',
    criteria: Object.fromEntries(m.REVIEW_CRITERIA.map(x => [x, { pass: true, reason: 'Synthetic fixture conclusion.' }])), adjudications: [],
    scope_accepted: true, application_scope: { locations: ['location_0', 'location_1', 'location_2', 'location_3'],
      date_from: '2025-01-01', date_to: '2027-12-31', source_kinds: ['rednote_manual', 'user', 'rednote_agent'], limitations: ['TEST_FIXTURE_ONLY'] },
    mapping_accepted: true, limitations: ['TEST_FIXTURE_ONLY'], remarks: 'Synthetic fixture, not a real declaration.' };
  if (options.applicationScope) conclusion.application_scope = options.applicationScope;
  const semantic = await publish('semantic_evidence', m.reviewPayloads(plan, second, conclusion, test), [review.directory]);
  return { ...m, test, output, accessLedger, draft, pilot, rubric, review, semantic, rubricPacket, pilotPacket,
    reviewInput, pilotInput, first, second, specification, conclusion, plan };
}
module.exports = { modules, importedSamples, annotations, metricFixture };
