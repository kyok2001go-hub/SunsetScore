const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeFormalFixture } = require('./validation-fixture.cjs');

test('runtime bundle preserves raw bytes, relocates, deduplicates and rejects tampering', async () => {
  const { freezeRuntime, verifyBundle, auditImports, allowedSource } = await import('../tools/experiment-runtime/lib/bundle.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-runtime-'));
  try {
    const output = path.join(temp, 'dataset/experiment_runtime');
    const frozen = await freezeRuntime({ output });
    const first = await verifyBundle(frozen.directory, { requireEnvironment: true });
    assert.equal(first.descriptor.result_usage, 'DEVELOPMENT_ONLY');
    assert.equal((await freezeRuntime({ output })).status, 'DEDUPLICATED');
    const relocated = path.join(temp, 'moved', first.runtime_bundle_id);
    await fs.cp(frozen.directory, relocated, { recursive: true });
    assert.equal((await verifyBundle(relocated)).runtime_bundle_sha256, first.runtime_bundle_sha256);
    const file = path.join(relocated, 'source/js/config.js');
    const bytes = await fs.readFile(file);
    await fs.writeFile(file, bytes.toString('utf8').replace(/\r?\n/g, '\n') + '\n');
    await assert.rejects(verifyBundle(relocated), { code: 'RUNTIME_BUNDLE_FILE_MISMATCH' });
    assert.equal(allowedSource('tools/../../.env.js'), false);
    assert.equal(allowedSource('node_modules/x.js'), false);
    assert.throws(() => auditImports(['tools/x.mjs'], { 'tools/x.mjs': Buffer.from("import './missing.mjs';") }), { code: 'RUNTIME_IMPORT_NOT_ARCHIVED' });
    assert.throws(() => auditImports(['tools/x.mjs'], { 'tools/x.mjs': Buffer.from("import 'unknown';") }), { code: 'RUNTIME_UNKNOWN_DEPENDENCY' });
    // Read-only archived verification must protect a result in another dataset root
    // for the whole child execution, including bundle verification and receipt handling.
    const { executeBundleCli } = await import('../tools/experiment-runtime/lib/execute.mjs');
    const { inspectMaintenanceState, withMaintenanceWindow } = await import('../tools/maintenance/lib/lease.mjs');
    const { buildValidationResult } = await import('../tools/validation/lib/build.mjs');
    const { packageManifest, publishValidation } = await import('../tools/validation/lib/package.mjs');
    const fixture = await makeFormalFixture('mixed');
    const built = await buildValidationResult({ plan: fixture.plan, input: fixture.input,
      runReplay: fixture.runReplay, testFixtureFormal: true });
    const resultRoot = path.join(temp, 'other-dataset');
    const published = await publishValidation({ output: path.join(resultRoot, 'validation'), files: built.files,
      manifest: packageManifest(built.files, fixture.planId), sourceCheck: async () => {} });
    const pending = executeBundleCli(frozen.directory, path.resolve('tools/validation/validate-validation.mjs'), [published.directory]);
    // Observe the lease; use real maintenance exclusion rather than a mocked lock call.
    let held = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await inspectMaintenanceState(resultRoot)).active_leases.length) { held = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(held, 'cross-root result lease was not held');
    await assert.rejects(withMaintenanceWindow(async () => {}, { datasetRoot: resultRoot }), { code: 'DATASET_BUILD_ACTIVE' });
    const verified = await pending;
    assert.equal(verified.validation_scope, 'PACKAGE_INTERNAL');
    assert.equal(verified.execution_receipt_id, undefined);
    assert.equal((await inspectMaintenanceState(resultRoot)).active_leases.length, 0);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('bundle CLI resolves caller-relative sources and requires explicit host outputs', async () => {
  const { bundleArgs } = await import('../tools/experiment-runtime/lib/execute.mjs');
  const args = bundleArgs(['--raw', 'dataset/exports/r1', '--mode', 'development', '--runtime-bundle', 'b1', '--report-dir', 'reports'], 'run', 'validation');
  assert.equal(args[1], path.resolve('dataset/exports/r1'));
  assert.ok(!args.includes('--runtime-bundle'));
  assert.ok(!args.includes('--report-dir'));
  assert.ok(path.isAbsolute(args[args.indexOf('--output') + 1]));
});

test('execution source identity uses each package own ID even when upstream IDs are present', async () => {
  const { sourceManifestIdentity } = await import('../tools/experiment-runtime/lib/execute.mjs');
  const manifest = { dataset_id: 'raw1', ground_truth_id: 'gt1', model_dataset_id: 'model1',
    evaluation_id: 'baseline1', sensitivity_id: 'sensitivity1', optimization_id: 'optimization1' };
  for (const [key, expected] of Object.entries({ raw: 'raw1', gt: 'gt1', model: 'model1', baseline: 'baseline1',
    sensitivity: 'sensitivity1', optimization: 'optimization1' })) {
    assert.deepEqual(sourceManifestIdentity(key, manifest, 'a'.repeat(64)), { id: expected, manifest_sha256: 'a'.repeat(64) });
  }
  assert.throws(() => sourceManifestIdentity('baseline', { model_dataset_id: 'model1' }, 'a'.repeat(64)),
    { code: 'RUNTIME_SOURCE_IDENTITY_MISSING' });
});

test('every deterministic result file and manifest participates in prepublication comparison', async () => {
  const { compareRecompute } = await import('../tools/validation/lib/recompute.mjs');
  const { buildValidationResult } = await import('../tools/validation/lib/build.mjs');
  const { packageManifest, publishValidation } = await import('../tools/validation/lib/package.mjs');
  const fixture = await makeFormalFixture('mixed');
  const built = await buildValidationResult({ plan: fixture.plan, input: fixture.input,
    runReplay: fixture.runReplay, testFixtureFormal: true });
  const manifest = packageManifest(built.files, fixture.planId);
  assert.equal(compareRecompute(built.files, manifest, { files: built.files, manifest }).status, 'PASS');
  for (const name of Object.keys(built.files)) {
    assert.throws(() => compareRecompute(built.files, manifest, { files: { ...built.files, [name]: built.files[name] + ' ' }, manifest }),
      { code: 'VALIDATION_RECOMPUTE_MISMATCH' });
  }
  assert.throws(() => compareRecompute(built.files, manifest, { files: built.files, manifest: { ...manifest, changed: true } }), { code: 'VALIDATION_RECOMPUTE_MISMATCH' });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-gate-'));
  try {
    await assert.rejects(publishValidation({ output: temp, files: built.files, manifest,
      sourceCheck: async () => {}, prepublish: async () => { throw Object.assign(Error('mismatch'), { code: 'VALIDATION_RECOMPUTE_MISMATCH' }); } }), { code: 'VALIDATION_RECOMPUTE_MISMATCH' });
    await assert.rejects(fs.stat(path.join(temp, 'exports', manifest.validation_id)), { code: 'ENOENT' });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('Plan activity excludes Run/Verify without occupying the global append lock', async () => {
  const { withPlanLock, recordLedger, readLedger } = await import('../tools/validation/lib/disclosure.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-activity-'));
  try {
    await withPlanLock(temp, 'p1', async () => {
      await assert.rejects(withPlanLock(temp, 'p1', async () => {}), { code: 'VALIDATION_ACCESS_BUSY' });
      await withPlanLock(temp, 'p2', () => recordLedger(temp, { action: 'VERIFY_RECOMPUTE_STARTED', plan_id: 'p2' }));
      await recordLedger(temp, { action: 'PREPUBLISH_RECOMPUTE_STARTED', plan_id: 'p1' });
    });
    assert.equal((await readLedger(temp)).rows.length, 2);
    await withPlanLock(temp, 'p1', () => recordLedger(temp, { action: 'PREPUBLISH_RECOMPUTE_FAILED', plan_id: 'p1' }));
    assert.equal((await readLedger(temp)).rows.length, 3);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

function qualityFixture() {
  return { quality_plan_schema_version: 1,
    deployments: { pages: { deployment_id: 'pages1', commit: 'a'.repeat(40), effective_at_utc: '2026-10-11T00:00:00Z' },
      scheduler: { deployment_id: 'scheduler1', commit: 'b'.repeat(40), effective_at_utc: '2026-10-11T00:00:00Z' } },
    capture_dates_shanghai: ['2026-10-13', '2026-10-14', '2026-10-15'], cutoff_utc: '2026-10-16T00:00:00Z',
    locations: [{ location_key: 'hk', timezone: 'Asia/Hong_Kong' }], slots: ['1213', '1613', '1720'] };
}
test('quality scope is prospective, preserves the expected denominator and pending scenes', async () => {
  const { qualityPlan, summarizeQuality, assertCaptureBuild, qualityScenarios } = await import('../tools/replay-quality/quality.mjs');
  const runtime = { runtime_bundle_id: 'r1', runtime_bundle_sha256: 'a'.repeat(64), descriptor: { engine_runtime_sha256: 'b'.repeat(64) } };
  const plan = qualityPlan(qualityFixture(), runtime, '2026-10-12T00:00:00Z');
  assert.doesNotThrow(() => assertCaptureBuild({ engine_build_sha: 'a'.repeat(40) },
    { identity: { engine_build_sha: 'a'.repeat(40) } }, plan));
  assert.throws(() => assertCaptureBuild({ engine_build_sha: 'b'.repeat(40) },
    { identity: { engine_build_sha: 'b'.repeat(40) } }, plan), { code: 'QUALITY_ENGINE_BUILD_MISMATCH' });
  const sameOffset = { context: { timezone: 'Asia/Hong_Kong', utc_offset_seconds: 28800 },
    nwp: { nodes: [{ timezone: 'Asia/Shanghai', utc_offset_seconds: 28800 }] } };
  assert.ok(!qualityScenarios({}, sameOffset).includes('CROSS_TIMEZONE_NWP'));
  sameOffset.nwp.nodes[0].utc_offset_seconds = 21600;
  assert.ok(qualityScenarios({}, sameOffset).includes('CROSS_TIMEZONE_NWP'));
  const captures = plan.expected_captures.map((row, i) => ({ ...row, status: 'READY', snapshot_ids: ['s' + i] }));
  const observations = plan.expected_captures.map((row, i) => ({ ...row, snapshot_id: 's' + i, status: 'PASS', scenarios: ['HK_METADATA'] }));
  const inventory = { capture_inventory_schema_version: 1, captures };
  const result = summarizeQuality(plan, inventory, observations);
  assert.equal(result.expected_capture_count, 9);
  assert.equal(result.status, 'COVERAGE_PENDING');
  assert.deepEqual(result.pending_scenarios, ['MINUTE_PRECIP_AVAILABLE', 'CROSS_TIMEZONE_NWP']);
  observations[0].scenarios.push('MINUTE_PRECIP_AVAILABLE', 'CROSS_TIMEZONE_NWP');
  assert.equal(summarizeQuality(plan, inventory, observations).status, 'PASS');
  captures[0] = { ...captures[0], status: 'UPLOAD_FAILED', snapshot_ids: [] };
  const failed = summarizeQuality(plan, inventory, observations.slice(1));
  assert.equal(failed.status, 'FAIL');
  assert.equal(failed.expected_capture_count, 9);
  assert.equal(failed.gaps.length, 1);
  assert.throws(() => summarizeQuality(plan, { ...inventory, captures: captures.slice(1) }, observations.slice(1)), { code: 'QUALITY_CAPTURE_DENOMINATOR_INCOMPLETE' });
  assert.throws(() => qualityPlan(qualityFixture(), runtime, '2026-10-14T00:00:00Z'), { code: 'QUALITY_PLAN_NOT_PROSPECTIVE' });
  assert.throws(() => qualityPlan({ ...qualityFixture(), gt_labels: [] }, runtime, '2026-10-12T00:00:00Z'), { code: 'QUALITY_PLAN_INVALID' });
});

test('external governance references block single-root prune and bundles have real lineage nodes', async () => {
  const { protectExternalReferences } = await import('../tools/experiment-runtime/lib/references.mjs');
  const { scanDataset } = await import('../tools/maintenance/lib/scan.mjs');
  const { PHASES, dependenciesOf } = await import('../tools/maintenance/maintenance-policy.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-external-'));
  try {
    const root = path.join(temp, 'dataset');
    await protectExternalReferences([root], path.join(temp, 'elsewhere'));
    assert.ok((await scanDataset({ datasetRoot: root })).diagnostics.some(row => row.code === 'EXTERNAL_GOVERNANCE_CLOSURE_UNAVAILABLE'));
    const phase = PHASES.find(row => row.key === 'replay_quality_report');
    assert.deepEqual(dependenciesOf(phase, { runtime_bundle_id: 'r1', runtime_bundle_manifest_sha256: 'a'.repeat(64),
      source_dataset_id: 'raw1', source_dataset_manifest_sha256: 'b'.repeat(64),
      replay_quality_plan_id: 'p1', replay_quality_plan_manifest_sha256: 'c'.repeat(64) }).map(row => row.id), ['r1', 'p1', 'raw1']);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('publication recovery requires a real prepublish proof and survives the completion/recovery gap', async () => {
  const { completePublicationRecovery, recordLedger, readLedger } = await import('../tools/validation/lib/disclosure.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-recover-'));
  const entry = { plan_id: 'p1', result_id: 'r1', attempt_id: 'attempt1', mode: 'DEVELOPMENT_VALIDATION' };
  const sha = 'a'.repeat(64);
  try {
    await assert.rejects(completePublicationRecovery(temp, entry, sha), { reason_code: 'PREPUBLISH_RECEIPT_MISSING' });
    await recordLedger(temp, { ...entry, action: 'RUN_STARTED' });
    await recordLedger(temp, { ...entry, action: 'PREPUBLISH_RECOMPUTE_STARTED' });
    await recordLedger(temp, { ...entry, action: 'PREPUBLISH_RECOMPUTE_COMPLETED', descriptor_sha256: sha,
      comparison: { status: 'PASS', descriptor_sha256: sha } });
    // Simulate termination between completing the published package and recording recovery.
    await recordLedger(temp, { ...entry, action: 'RUN_COMPLETED', recovered: true });
    assert.equal((await completePublicationRecovery(temp, entry, sha)).status, 'ALREADY_COMPLETED');
    await completePublicationRecovery(temp, entry, sha);
    const ledger = await readLedger(temp);
    assert.equal(ledger.rows.filter(row => row.action === 'RUN_COMPLETED').length, 1);
    assert.equal(ledger.rows.filter(row => row.action === 'PUBLISH_RECOVERED').length, 1);
    assert.equal(ledger.rows.filter(row => row.action === 'FIRST_ACCESS_RESERVED').length, 0);
    await assert.rejects(recordLedger(temp, { action: 'BAD', sequence: 99 }), { reason_code: 'LEDGER_RESERVED_FIELD' });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('governance operations hold shared leases on every canonical input/output root', async () => {
  const { withGovernanceLeases } = await import('../tools/experiment-runtime/lib/lease.mjs');
  const { withMaintenanceWindow, inspectMaintenanceState } = await import('../tools/maintenance/lib/lease.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-multi-root-'));
  const roots = [path.join(temp, 'a'), path.join(temp, 'b')];
  try {
    await withGovernanceLeases('test', [roots[1], roots[0], roots[0]], async () => {
      for (const root of roots) {
        assert.equal((await inspectMaintenanceState(root)).active_leases.length, 1);
        await assert.rejects(withMaintenanceWindow(async () => {}, { datasetRoot: root }), { code: 'DATASET_BUILD_ACTIVE' });
      }
    });
    for (const root of roots) assert.equal((await inspectMaintenanceState(root)).active_leases.length, 0);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
