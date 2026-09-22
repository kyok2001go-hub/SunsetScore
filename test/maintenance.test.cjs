const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');

let modules;
function api() {
  return modules ||= Promise.all([
    'maintenance/maintenance-policy',
    'maintenance/lib/lease',
    'maintenance/lib/scan',
    'maintenance/lib/plan',
    'maintenance/lib/render',
    'maintenance/lib/args',
    'maintenance/lib/verify',
    'maintenance/lineage',
    'maintenance/prune',
    'dataset/lib/common'
  ].map(name => import(`../tools/${name}.mjs`))).then(list => Object.assign({}, ...list));
}

const ID = {
  rawA: 'raw_v1_20260907_20260914_aaaaaaaaaaaa',
  rawB: 'raw_v1_20260901_20260907_bbbbbbbbbbbb',
  gtA: 'gt_v3_aaaaaaaaaaaa_111111111111',
  gtB: 'gt_v3_bbbbbbbbbbbb_222222222222',
  modelA: 'model_v2_aaaaaaaaaaaa_111111111111_333333333333',
  evalV1: 'baseline_v1_333333333333_444444444444',
  evalV2: 'baseline_v2_333333333333_555555555555',
  sensV1: 'sensitivity_v1_333333333333_666666666666',
  sensV2: 'sensitivity_v2_333333333333_777777777777',
  optV1: 'optimization_v1_333333333333_888888888888'
};

async function tempDataset(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-maintenance-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes one fixture package whose descriptor hash is genuinely derived, as the scanner requires. */
async function writePackage(m, datasetRoot, relativeRoot, id, manifest) {
  const directory = path.join(datasetRoot, relativeRoot, id);
  await fs.mkdir(directory, { recursive: true });
  const descriptor = manifest.descriptor || { fixture_id: id };
  const full = { ...manifest, descriptor, descriptor_sha256: m.hash(m.canonicalJson(descriptor)) };
  const text = m.canonicalJson(full);
  await fs.writeFile(path.join(directory, 'manifest.json'), text, 'utf8');
  return { directory, manifest: full, manifestSha256: m.hash(text) };
}

/**
 * Mirrors the real layout: two Raw/GT branches, one shared Model, Evaluation V1/V2, and a
 * Tuning V2 package whose validation disclosure evidence points back at Evaluation V1.
 */
async function buildFixture(m, datasetRoot) {
  const rawA = await writePackage(m, datasetRoot, 'exports', ID.rawA, {
    offline_dataset_schema_version: 1, dataset_id: ID.rawA
  });
  const rawB = await writePackage(m, datasetRoot, 'exports', ID.rawB, {
    offline_dataset_schema_version: 1, dataset_id: ID.rawB
  });
  const gtA = await writePackage(m, datasetRoot, 'ground_truth/exports', ID.gtA, {
    ground_truth_schema_version: 3, gt_policy_version: 2, ground_truth_id: ID.gtA,
    source_dataset_id: ID.rawA, source_dataset_manifest_sha256: rawA.manifestSha256
  });
  const gtB = await writePackage(m, datasetRoot, 'ground_truth/exports', ID.gtB, {
    ground_truth_schema_version: 3, gt_policy_version: 2, ground_truth_id: ID.gtB,
    source_dataset_id: ID.rawB, source_dataset_manifest_sha256: rawB.manifestSha256
  });
  const modelA = await writePackage(m, datasetRoot, 'model/exports', ID.modelA, {
    model_dataset_schema_version: 2, model_dataset_policy_version: 3, model_dataset_id: ID.modelA,
    source_dataset_id: ID.rawA, source_dataset_manifest_sha256: rawA.manifestSha256,
    ground_truth_id: ID.gtA, ground_truth_manifest_sha256: gtA.manifestSha256
  });
  const evalV1 = await writePackage(m, datasetRoot, 'evaluation/exports', ID.evalV1, {
    evaluation_schema_version: 1, evaluation_policy_version: 1, evaluation_id: ID.evalV1,
    model_dataset_id: ID.modelA, model_dataset_manifest_sha256: modelA.manifestSha256
  });
  const evalV2 = await writePackage(m, datasetRoot, 'evaluation/exports', ID.evalV2, {
    evaluation_schema_version: 2, evaluation_policy_version: 2, evaluation_id: ID.evalV2,
    model_dataset_id: ID.modelA, model_dataset_manifest_sha256: modelA.manifestSha256
  });
  const sensV1 = await writePackage(m, datasetRoot, 'tuning/exports', ID.sensV1, {
    tuning_schema_version: 1, tuning_policy_version: 1, sensitivity_id: ID.sensV1,
    model_dataset_id: ID.modelA, model_dataset_manifest_sha256: modelA.manifestSha256,
    evaluation_id: ID.evalV1, evaluation_manifest_sha256: evalV1.manifestSha256,
    source_dataset_id: ID.rawA, ground_truth_id: ID.gtA
  });
  const sensV2 = await writePackage(m, datasetRoot, 'tuning/exports', ID.sensV2, {
    tuning_schema_version: 2, tuning_policy_version: 2, sensitivity_id: ID.sensV2,
    model_dataset_id: ID.modelA, model_dataset_manifest_sha256: modelA.manifestSha256,
    evaluation_id: ID.evalV2, evaluation_manifest_sha256: evalV2.manifestSha256,
    source_dataset_id: ID.rawA, ground_truth_id: ID.gtA,
    validation_disclosure_evidence_id: ID.evalV1,
    validation_disclosure_evidence_sha256: evalV1.manifestSha256
  });
  const optV1 = await writePackage(m, datasetRoot, 'optimization/exports', ID.optV1, {
    optimization_schema_version: 1, optimization_policy_version: 1, optimization_id: ID.optV1,
    model_dataset_id: ID.modelA, model_dataset_manifest_sha256: modelA.manifestSha256,
    evaluation_id: ID.evalV2, evaluation_manifest_sha256: evalV2.manifestSha256,
    sensitivity_id: ID.sensV2, sensitivity_manifest_sha256: sensV2.manifestSha256,
    source_dataset_id: ID.rawA, ground_truth_id: ID.gtA,
    validation_disclosure_evidence_id: ID.evalV1,
    validation_disclosure_evidence_sha256: evalV1.manifestSha256
  });
  return { rawA, rawB, gtA, gtB, modelA, evalV1, evalV2, sensV1, sensV2, optV1 };
}

const exists = async file => fs.access(file).then(() => true, () => false);

test('Lineage scan finds one node per published package and no diagnostics on a sound graph', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  const graph = await m.scanDataset({ datasetRoot: root });
  assert.equal(graph.nodes.length, 10);
  assert.deepEqual(graph.diagnostics, []);
  assert.deepEqual(
    Object.fromEntries([1, 2, 3, 4, 5, 6].map(phase => [phase, graph.nodes.filter(n => n.phase === phase).length])),
    { 1: 2, 2: 2, 3: 1, 4: 2, 5: 2, 6: 1 });
  for (const node of graph.nodes) {
    assert.equal(node.declared_id, node.id);
    assert.equal(node.status, 'OK');
    assert.match(node.manifest_sha256, /^[a-f0-9]{64}$/);
    assert.ok(node.absolute_path.startsWith(root));
  }
  assert.ok(graph.edges.every(edge => edge.parent_phase < edge.child_phase));
});

test('Package verification dispatch recognizes Phase 6 Optimization', async () => {
  const m = await api();
  const result = await m.verifyPackages([{
    id: ID.optV1,
    phase: 6,
    phase_key: 'optimization',
    status: 'BROKEN',
    absolute_path: null
  }]);
  assert.deepEqual(result, [{ id: ID.optV1, phase: 6, status: 'SKIPPED', error_code: null }]);
});

test('Cascade closure follows declared sources and the validation disclosure evidence', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  const graph = await m.scanDataset({ datasetRoot: root });

  const evalV1 = [...m.descendantsOf(graph, ID.evalV1)].sort();
  assert.deepEqual(evalV1, [ID.evalV1, ID.sensV1, ID.sensV2, ID.optV1].sort());
  assert.ok(!evalV1.includes(ID.evalV2));

  const evalV2 = [...m.descendantsOf(graph, ID.evalV2)].sort();
  assert.deepEqual(evalV2, [ID.evalV2, ID.sensV2, ID.optV1].sort());
  assert.ok(!evalV2.includes(ID.sensV1));

  const rawA = [...m.descendantsOf(graph, ID.rawA)].sort();
  assert.deepEqual(rawA,
    [ID.rawA, ID.gtA, ID.modelA, ID.evalV1, ID.evalV2, ID.sensV1, ID.sensV2, ID.optV1].sort());
  assert.ok(!rawA.includes(ID.rawB));
  assert.ok(!rawA.includes(ID.gtB));

  const single = [...m.descendantsOf(graph, ID.sensV1)].sort();
  assert.deepEqual(single, [ID.sensV1]);

  assert.deepEqual([...m.descendantsOf(graph, ID.sensV2)].sort(), [ID.sensV2, ID.optV1].sort());
  assert.deepEqual([...m.descendantsOf(graph, ID.optV1)], [ID.optV1]);
});

test('Mermaid graph keeps one labelled node per package and honours --focus', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);

  const full = await m.datasetLineage({ datasetRoot: root, format: 'mermaid' });
  for (const id of Object.values(ID)) assert.ok(full.payload.includes(`["${id}"]`), id);
  assert.ok(full.payload.includes('-.->|EVIDENCE|'));
  // The default drawing uses only plain node and edge statements so any renderer can draw it.
  assert.ok(!full.payload.includes('subgraph'));
  assert.ok(full.payload.includes('%% Phase 1 Raw Dataset'));

  const grouped = await m.datasetLineage({ datasetRoot: root, format: 'mermaid', group: true });
  assert.ok(grouped.payload.includes('subgraph P1["Phase 1 Raw Dataset"]'));
  assert.ok(grouped.payload.includes('-.->|EVIDENCE|'));

  const focused = await m.datasetLineage({ datasetRoot: root, format: 'mermaid', focus: ID.evalV1 });
  assert.ok(focused.payload.includes(ID.sensV2));
  assert.ok(focused.payload.includes(ID.modelA));
  assert.ok(!focused.payload.includes(ID.gtB));
  assert.ok(!focused.payload.includes(ID.rawB));
});

test('The drawing keeps direct relationships only while cascade reachability is preserved', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  const graph = await m.scanDataset({ datasetRoot: root });
  const reduced = m.reduceEdgesForDrawing(graph.edges);

  assert.equal(graph.edges.length, 21);
  assert.equal(reduced.length, 9);
  // Phase 1 and Phase 2 no longer draw straight into Phase 5.
  assert.ok(!reduced.some(edge => edge.kind === 'REFERENCE'));
  assert.ok(!reduced.some(edge => edge.parent_phase === 1 && edge.child_phase === 5));
  assert.ok(!reduced.some(edge => edge.parent_phase === 2 && edge.child_phase === 5));
  // The validation disclosure evidence is a direct relationship and must survive.
  assert.ok(reduced.some(edge => edge.kind === 'EVIDENCE' &&
    edge.parent_id === ID.evalV1 && edge.child_id === ID.sensV2));
  assert.ok(reduced.some(edge => edge.kind === 'SOURCE' &&
    edge.parent_id === ID.sensV2 && edge.child_id === ID.optV1));

  // Every dependent set is unchanged, so the compact drawing still explains cascades.
  const reducedGraph = { edges: reduced };
  for (const node of graph.nodes) {
    assert.deepEqual(
      [...m.descendantsOf(reducedGraph, node.id)].sort(),
      [...m.descendantsOf(graph, node.id)].sort(),
      node.id);
  }
});

test('Lineage omits transitive edges from the drawing and keeps every edge in JSON', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);

  const mermaid = await m.datasetLineage({ datasetRoot: root, format: 'mermaid' });
  assert.ok(!mermaid.payload.includes('|REFERENCE|'));
  assert.ok(mermaid.payload.includes('|EVIDENCE|'));

  const parsed = JSON.parse((await m.datasetLineage({ datasetRoot: root, format: 'json' })).payload);
  assert.equal(parsed.edges.length, 21);
  assert.equal(parsed.display_edges.length, 9);
  assert.deepEqual(parsed.drawing, { edge_count: 21, drawn_edge_count: 9, hidden_edge_count: 12 });
  assert.ok(parsed.edges.some(edge => edge.kind === 'REFERENCE'));
  assert.ok(!parsed.display_edges.some(edge => edge.kind === 'REFERENCE'));

  const text = await m.datasetLineage({ datasetRoot: root, format: 'text' });
  assert.ok(text.payload.includes('Transitive edges left out of the drawing (12)'));
});

test('Prune plan for Evaluation V1 includes the dependent Phase 6 package', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  const planPath = path.join(root, 'maintenance/plans/eval-v1.json');
  const result = await m.datasetPrune({
    mode: 'plan', datasetRoot: root, phase: 4, id: ID.evalV1, planPath
  });
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.targets.map(item => item.id).sort(),
    [ID.evalV1, ID.sensV1, ID.sensV2, ID.optV1].sort());
  assert.deepEqual(result.execution_order, [
    { phase: 6, id: ID.optV1 },
    { phase: 5, id: ID.sensV1 }, { phase: 5, id: ID.sensV2 }, { phase: 4, id: ID.evalV1 }
  ]);
  assert.deepEqual(result.summary.evidence_edges, [
    `${ID.evalV1} -> ${ID.optV1}: VALIDATION EVIDENCE`,
    `${ID.evalV1} -> ${ID.sensV2}: VALIDATION EVIDENCE`
  ]);
  assert.deepEqual(result.blockers, []);
  const written = JSON.parse(await fs.readFile(planPath, 'utf8'));
  assert.equal(written.plan_sha256, result.plan_sha256);
  assert.equal(m.planDigest(written), written.plan_sha256);
});

test('A Phase 6 prune target selects only that Optimization package', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  const result = await m.datasetPrune({
    mode: 'plan', datasetRoot: root, phase: 6, id: ID.optV1,
    planPath: path.join(root, 'maintenance/plans/optimization.json')
  });
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.targets.map(item => item.id), [ID.optV1]);
  assert.deepEqual(result.execution_order, [{ phase: 6, id: ID.optV1 }]);
});

test('Prune plan refuses a phase that does not own the id and a missing id', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  await assert.rejects(
    () => m.datasetPrune({ mode: 'plan', datasetRoot: root, phase: 3, id: ID.evalV1, planPath: path.join(root, 'p1.json') }),
    error => error.code === 'MAINTENANCE_TARGET_MISSING' && error.reason_code === 'PHASE_MISMATCH');
  await assert.rejects(
    () => m.datasetPrune({ mode: 'plan', datasetRoot: root, phase: 1, id: 'raw_v1_missing', planPath: path.join(root, 'p2.json') }),
    error => error.code === 'MAINTENANCE_TARGET_MISSING');
});

test('Broken lineage is diagnosed and blocks the affected plan', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);

  const missing = await tempDataset(t);
  await buildFixture(m, missing);
  await fs.rm(path.join(missing, 'exports', ID.rawA), { recursive: true });
  const missingGraph = await m.scanDataset({ datasetRoot: missing });
  assert.ok(missingGraph.diagnostics.some(item => item.code === 'PARENT_MISSING' && item.node_id === ID.gtA));
  const blocked = await m.datasetPrune({
    mode: 'plan', datasetRoot: missing, phase: 2, id: ID.gtA, planPath: path.join(missing, 'plan.json')
  });
  assert.equal(blocked.status, 'BLOCKED');
  assert.ok(blocked.blockers.some(item => item.code === 'PARENT_MISSING'));

  const wrongHash = await tempDataset(t);
  const fixture = await buildFixture(m, wrongHash);
  const manifestPath = path.join(wrongHash, 'model/exports', ID.modelA, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.ground_truth_manifest_sha256 = 'f'.repeat(64);
  await fs.writeFile(manifestPath, m.canonicalJson(manifest), 'utf8');
  const hashGraph = await m.scanDataset({ datasetRoot: wrongHash });
  assert.ok(hashGraph.diagnostics.some(item => item.code === 'PARENT_HASH_MISMATCH' && item.node_id === ID.modelA));
  const hashPlan = await m.datasetPrune({
    mode: 'plan', datasetRoot: wrongHash, phase: 3, id: ID.modelA, planPath: path.join(wrongHash, 'plan.json')
  });
  assert.equal(hashPlan.status, 'BLOCKED');
  assert.ok(fixture.modelA);
});

test('Directory, version and descriptor inconsistencies are reported', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);

  const renamed = path.join(root, 'exports/raw_v1_renamed_aaaaaaaaaaaa');
  await fs.rename(path.join(root, 'exports', ID.rawB), renamed);
  const graph = await m.scanDataset({ datasetRoot: root });
  assert.ok(graph.diagnostics.some(item => item.code === 'DIRECTORY_ID_MISMATCH'));

  const versioned = await tempDataset(t);
  await buildFixture(m, versioned);
  const evalPath = path.join(versioned, 'evaluation/exports', ID.evalV2, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(evalPath, 'utf8'));
  manifest.evaluation_schema_version = 9;
  await fs.writeFile(evalPath, m.canonicalJson(manifest), 'utf8');
  const versionGraph = await m.scanDataset({ datasetRoot: versioned });
  assert.ok(versionGraph.diagnostics.some(item =>
    item.code === 'UNSUPPORTED_LINEAGE' && item.node_id === ID.evalV2));
});

test('Apply removes the closure and never touches unrelated branches', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  const planPath = path.join(root, 'maintenance/plans/eval-v1.json');
  await m.datasetPrune({ mode: 'plan', datasetRoot: root, phase: 4, id: ID.evalV1, planPath });

  const result = await m.datasetPrune({ mode: 'apply', datasetRoot: root, planPath });
  assert.equal(result.status, 'PRUNED');
  assert.equal(result.deleted_count, 4);
  for (const id of [ID.evalV1, ID.sensV1, ID.sensV2, ID.optV1]) {
    assert.equal(await exists(path.join(root, 'evaluation/exports', id)), false, id);
    assert.equal(await exists(path.join(root, 'tuning/exports', id)), false, id);
    assert.equal(await exists(path.join(root, 'optimization/exports', id)), false, id);
  }
  for (const id of [ID.rawA, ID.rawB, ID.gtA, ID.gtB, ID.modelA, ID.evalV2]) {
    assert.ok(await exists(path.join(root, 'evaluation/exports', id)) ||
      await exists(path.join(root, 'exports', id)) ||
      await exists(path.join(root, 'ground_truth/exports', id)) ||
      await exists(path.join(root, 'model/exports', id)), id);
  }
  const log = (await fs.readFile(result.operation_log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.filter(entry => entry.status === 'DELETED').length, 4);
  assert.equal(await exists(path.join(root, 'maintenance/quarantine', result.plan_sha256, 'phase4', ID.evalV1)), false);
});

test('Resume finishes a run interrupted after the quarantine move', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  const planPath = path.join(root, 'maintenance/plans/eval-v1.json');
  const plan = await m.datasetPrune({ mode: 'plan', datasetRoot: root, phase: 4, id: ID.evalV1, planPath });

  // Simulate a kill between the atomic rename and its log line.
  const quarantine = path.join(root, 'maintenance/quarantine', plan.plan_sha256, 'phase5', ID.sensV1);
  await fs.mkdir(path.dirname(quarantine), { recursive: true });
  await fs.rename(path.join(root, 'tuning/exports', ID.sensV1), quarantine);

  const result = await m.datasetPrune({ mode: 'resume', datasetRoot: root, planPath });
  assert.equal(result.deleted_count, 4);
  assert.equal(await exists(path.join(root, 'tuning/exports', ID.sensV1)), false);
  assert.equal(await exists(path.join(root, 'tuning/exports', ID.sensV2)), false);
  assert.equal(await exists(path.join(root, 'evaluation/exports', ID.evalV1)), false);
  assert.equal(await exists(path.join(root, 'evaluation/exports', ID.evalV2)), true);
  assert.equal(await exists(path.join(root, 'optimization/exports', ID.optV1)), false);
  assert.equal(await exists(quarantine), false);
});

test('Apply refuses a plan whose graph changed after it was written', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  const planPath = path.join(root, 'maintenance/plans/eval-v1.json');
  await m.datasetPrune({ mode: 'plan', datasetRoot: root, phase: 4, id: ID.evalV1, planPath });

  const manifestPath = path.join(root, 'evaluation/exports', ID.evalV1, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.descriptor = { tampered: true };
  manifest.descriptor_sha256 = m.hash(m.canonicalJson(manifest.descriptor));
  await fs.writeFile(manifestPath, m.canonicalJson(manifest), 'utf8');

  await assert.rejects(
    () => m.datasetPrune({ mode: 'apply', datasetRoot: root, planPath }),
    error => error.code === 'MAINTENANCE_PLAN_STALE');
  assert.ok(await exists(path.join(root, 'evaluation/exports', ID.evalV1)));
});

test('Reports and plans can never be written inside a published package root', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  await assert.rejects(
    () => m.datasetLineage({ datasetRoot: root, format: 'json', out: path.join(root, 'exports/report.json') }),
    error => error.code === 'MAINTENANCE_UNSAFE_PATH' && error.reason_code === 'OUTPUT_INSIDE_PUBLISHED_ROOT');
  await assert.rejects(
    () => m.datasetPrune({
      mode: 'plan', datasetRoot: root, phase: 4, id: ID.evalV1,
      planPath: path.join(root, 'evaluation/exports/plan.json')
    }),
    error => error.code === 'MAINTENANCE_UNSAFE_PATH' && error.reason_code === 'PLAN_INSIDE_PUBLISHED_ROOT');
});

test('Maintenance gate and build leases are mutually exclusive in both directions', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await fs.mkdir(path.join(root, 'exports'), { recursive: true });

  await m.withBuildLease('raw', async () => {
    await assert.rejects(
      () => m.withMaintenanceWindow(async () => {}, { datasetRoot: root }),
      error => error.code === 'DATASET_BUILD_ACTIVE');
  }, { datasetRoot: root });
  assert.deepEqual((await m.inspectMaintenanceState(root)).active_leases, []);

  await m.withMaintenanceWindow(async () => {
    await assert.rejects(
      () => m.withBuildLease('raw', async () => {}, { datasetRoot: root }),
      error => error.code === 'DATASET_MAINTENANCE_ACTIVE');
  }, { datasetRoot: root });
  const state = await m.inspectMaintenanceState(root);
  assert.equal(state.gate_active, false);
  assert.equal(state.status, 'IDLE');

  // Concurrent leases are allowed; only the exclusive window is closed to them.
  await Promise.all([
    m.withBuildLease('raw', async () => {}, { datasetRoot: root }),
    m.withBuildLease('model', async () => {}, { datasetRoot: root })
  ]);
  assert.deepEqual((await m.inspectMaintenanceState(root)).active_leases, []);
});

test('A locked published package blocks the plan that would remove it', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  await fs.mkdir(path.join(root, 'evaluation/exports', `${ID.evalV1}.lock`));
  const plan = await m.datasetPrune({
    mode: 'plan', datasetRoot: root, phase: 4, id: ID.evalV1, planPath: path.join(root, 'plan.json')
  });
  assert.equal(plan.status, 'BLOCKED');
  assert.ok(plan.blockers.some(item => item.code === 'PACKAGE_LOCK_PRESENT' && item.node_id === ID.evalV1));
});

test('A build lease is scoped to its own output root, not the repository dataset', async t => {
  const m = await api();
  const root = await tempDataset(t);
  const modelOutput = path.join(root, 'dataset/model');
  const rawOutput = path.join(root, 'dataset');
  assert.equal(m.datasetRootForPhaseOutput('model', modelOutput), path.join(root, 'dataset'));
  assert.equal(m.datasetRootForPhaseOutput('raw', rawOutput), path.join(root, 'dataset'));
  assert.equal(m.datasetRootForPhaseOutput('evaluation', path.join(root, 'dataset/evaluation')),
    path.join(root, 'dataset'));
  assert.equal(m.datasetRootForPhaseOutput('optimization', path.join(root, 'dataset/optimization')),
    path.join(root, 'dataset'));

  const datasetRoot = m.datasetRootForPhaseOutput('model', modelOutput);
  await m.withBuildLease('model', async () => {
    const state = await m.inspectMaintenanceState(datasetRoot);
    assert.equal(state.active_leases.length, 1);
    assert.equal(state.lease_details[0].phase, 'model');
  }, { datasetRoot });
  assert.equal((await m.inspectMaintenanceState(datasetRoot)).status, 'IDLE');
  assert.equal(await exists(path.join(datasetRoot, 'maintenance/leases')), true);
});

test('Prune takes a bare package id and detects the phase from the manifest', async t => {
  const m = await api();
  const parsed = m.parsePruneArgs([ID.evalV1]);
  assert.equal(parsed.mode, 'auto');
  assert.equal(parsed.id, ID.evalV1);
  assert.equal(parsed.phase, null);
  assert.equal(parsed.dryRun, false);
  assert.equal(m.parsePruneArgs([ID.evalV1, '--dry-run']).dryRun, true);
  assert.equal(m.parsePruneArgs(['--id', ID.evalV1]).id, ID.evalV1);
  assert.equal(m.parsePruneArgs([ID.evalV1, '--phase', '4']).phase, 4);
  assert.equal(m.parsePruneArgs([ID.optV1, '--phase', '6']).phase, 6);
  assert.throws(() => m.parsePruneArgs([ID.evalV1, ID.sensV1]),
    error => error.reason_code === 'ONE_ID_AT_A_TIME');
  assert.throws(() => m.parsePruneArgs([ID.evalV1, '--phase', '9']),
    error => error.reason_code === 'PHASE_OUT_OF_RANGE');
  assert.throws(() => m.parsePruneArgs([]), error => error.reason_code === 'ID_REQUIRED');
});

test('Bare id prune previews, then deletes the closure in one command', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);

  const preview = await m.datasetPrune({ mode: 'auto', datasetRoot: root, id: ID.evalV1, dryRun: true });
  assert.equal(preview.status, 'PLANNED');
  assert.deepEqual(preview.targets.map(item => item.id).sort(),
    [ID.evalV1, ID.sensV1, ID.sensV2, ID.optV1].sort());
  for (const id of [ID.evalV1, ID.sensV1, ID.sensV2, ID.optV1]) {
    assert.ok(await exists(path.join(root, 'evaluation/exports', id)) ||
      await exists(path.join(root, 'tuning/exports', id)) ||
      await exists(path.join(root, 'optimization/exports', id)), `preview must not delete ${id}`);
  }

  const result = await m.datasetPrune({ mode: 'auto', datasetRoot: root, id: ID.evalV1 });
  assert.equal(result.status, 'PRUNED');
  assert.equal(result.deleted_count, 4);
  assert.equal(await exists(path.join(root, 'evaluation/exports', ID.evalV1)), false);
  assert.equal(await exists(path.join(root, 'tuning/exports', ID.sensV1)), false);
  assert.equal(await exists(path.join(root, 'tuning/exports', ID.sensV2)), false);
  assert.equal(await exists(path.join(root, 'optimization/exports', ID.optV1)), false);
  assert.equal(await exists(path.join(root, 'evaluation/exports', ID.evalV2)), true);
  assert.equal(await exists(path.join(root, 'model/exports', ID.modelA)), true);
  // The auto plan file is a durable record of what the one command did.
  assert.ok(await exists(path.join(root, 'maintenance/plans', `${ID.evalV1}.json`)));
  assert.equal(result.summary.phase_counts['5'], 2);
  assert.equal(result.summary.phase_counts['6'], 1);
});

test('Bare id prune still refuses an unknown id and a mismatched phase', async t => {
  const m = await api();
  const root = await tempDataset(t);
  await buildFixture(m, root);
  await assert.rejects(
    () => m.datasetPrune({ mode: 'auto', datasetRoot: root, id: 'baseline_v1_missing', dryRun: true }),
    error => error.code === 'MAINTENANCE_TARGET_MISSING');
  await assert.rejects(
    () => m.datasetPrune({ mode: 'auto', datasetRoot: root, id: ID.evalV1, phase: 3, dryRun: true }),
    error => error.code === 'MAINTENANCE_TARGET_MISSING' && error.reason_code === 'PHASE_MISMATCH');
  await assert.rejects(
    () => m.datasetPrune({ mode: 'auto', datasetRoot: root, id: ID.gtA, phase: 1, dryRun: true }),
    error => error.reason_code === 'PHASE_MISMATCH');
});
