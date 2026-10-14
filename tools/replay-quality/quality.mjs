#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, compare, errorCode, fail, hash, isMain, readSafe, safeId } from '../dataset/lib/common.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import { datasetSchema } from '../dataset/dataset-schema.mjs';
import { validateReplayPayload } from '../../server/replay-schema.js';
import { fingerprintSourcePackage } from '../optimization/lib/input.mjs';
import { publishGovernancePackage, inspectGovernancePackage } from '../experiment-runtime/lib/package.mjs';
import { verifyBundle, nodeProcess, fingerprintExecutionRoot } from '../experiment-runtime/lib/bundle.mjs';
import { outside } from '../tuning/lib/input.mjs';
import { withGovernanceLeases } from '../experiment-runtime/lib/lease.mjs';
import { protectExternalReferences } from '../experiment-runtime/lib/references.mjs';
import { validateDataset } from '../dataset/validate-dataset.mjs';

export const QUALITY_COMPUTATION_CONTRACT_REVISION = 1;
export function assertCaptureBuild(row, replay, plan) {
  if (row.engine_build_sha !== plan.deployments.pages.commit ||
      replay.identity.engine_build_sha !== plan.deployments.pages.commit) fail('QUALITY_ENGINE_BUILD_MISMATCH');
}
async function assertQualityRuntime(runtime) {
  const source = (await readSafe(path.join(runtime.source, 'tools/replay-quality/quality.mjs'))).toString('utf8');
  if (!source.includes('export const QUALITY_COMPUTATION_CONTRACT_REVISION = 1;')) fail('QUALITY_RUNTIME_TOOL_PROTOCOL_UNSUPPORTED');
}

const dateAt = (instant, zone) => new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(instant));
const check = (ok, code) => { if (!ok) fail(code); };
export function qualityPlan(config, runtime, frozenAt = new Date().toISOString()) {
  check(config?.quality_plan_schema_version === 1 &&
    Object.keys(config).every(key => ['quality_plan_schema_version', 'deployments', 'capture_dates_shanghai',
      'locations', 'slots', 'cutoff_utc'].includes(key)), 'QUALITY_PLAN_INVALID');
  check(config.deployments && ['pages', 'scheduler'].every(key => {
    const value = config.deployments[key];
    return value && typeof value.deployment_id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value.deployment_id) &&
      /^[a-f0-9]{40}$/.test(value.commit || '') && Number.isFinite(Date.parse(value.effective_at_utc)) &&
      Object.keys(value).every(name => ['deployment_id', 'commit', 'effective_at_utc'].includes(name));
  }) && Object.keys(config.deployments).length === 2, 'QUALITY_DEPLOYMENT_EVIDENCE_REQUIRED');
  const dates = config.capture_dates_shanghai;
  check(Array.isArray(dates) && dates.length >= 3 && dates.every((date, i) =>
    /^\d{4}-\d{2}-\d{2}$/.test(date) && dateAt(date + 'T12:00:00Z', 'UTC') === date &&
    (!i || Date.parse(date) - Date.parse(dates[i - 1]) === 86400000)), 'QUALITY_CONSECUTIVE_DATES_REQUIRED');
  check(canonicalJson(config.slots) === canonicalJson(['1213', '1613', '1720']), 'QUALITY_SLOT_CONTRACT');
  check(Array.isArray(config.locations) && config.locations.length > 0 &&
    new Set(config.locations.map(row => row.location_key)).size === config.locations.length &&
    config.locations.every(row => typeof row.location_key === 'string' && row.location_key.length <= 180 &&
      typeof row.timezone === 'string' && Object.keys(row).every(key => ['location_key', 'timezone'].includes(key))), 'QUALITY_LOCATIONS_INVALID');
  const lower = Math.max(...Object.values(config.deployments).map(value => Date.parse(value.effective_at_utc)));
  const cutoff = Date.parse(config.cutoff_utc);
  check(Number.isFinite(cutoff), 'QUALITY_CUTOFF_INVALID');
  const expected = [];
  for (const date of dates) for (const slot of config.slots) {
    const time = new Date(`${date}T${slot.slice(0, 2)}:${slot.slice(2)}:00+08:00`).toISOString();
    check(Date.parse(time) > lower && Date.parse(time) <= cutoff, 'QUALITY_DEPLOYMENT_WINDOW_INVALID');
    check(Number.isFinite(Date.parse(frozenAt)) && Date.parse(time) > Date.parse(frozenAt), 'QUALITY_PLAN_NOT_PROSPECTIVE');
    for (const location of config.locations) expected.push({ location_key: location.location_key,
      timezone: location.timezone, capture_date_shanghai: date,
      capture_date_local: dateAt(time, location.timezone), scheduled_slot: slot, scheduled_time_utc: time });
  }
  return { ...config, quality_computation_contract_revision: QUALITY_COMPUTATION_CONTRACT_REVISION,
    frozen_at_utc: frozenAt, expected_captures: expected,
    selection_rule: 'ALL_EXPORTED_READY_IN_PREDECLARED_SCHEDULE_CELLS',
    reference_contract: 'REPLAY_REFERENCE_V1_UNCHANGED',
    runtime_bundle_id: runtime.runtime_bundle_id, runtime_bundle_sha256: runtime.runtime_bundle_sha256,
    engine_runtime_sha256: runtime.descriptor.engine_runtime_sha256,
    result_usage: 'REPLAY_ENGINEERING_ONLY', test_evaluated: false };
}
export async function planQuality({ specification, runtimeBundle, output }) {
  const out = await outside(output, [runtimeBundle, specification]);
  return withGovernanceLeases('replay_quality_plan', [path.dirname(out),
    path.dirname(path.dirname(path.dirname(runtimeBundle)))], async () => {
    const checked = await verifyBundle(runtimeBundle, { requireEnvironment: true });
    await assertQualityRuntime(checked);
    const specBytes = await readSafe(specification);
    const plan = qualityPlan(JSON.parse(specBytes), checked);
    await protectExternalReferences([path.dirname(path.dirname(path.dirname(runtimeBundle)))], out);
    return publishGovernancePackage({ output: path.join(out, 'plans'), kind: 'replay_quality_plan',
      idField: 'replay_quality_plan_id', payloads: { 'quality_plan.json': plan },
      links: { runtime_bundle_id: checked.runtime_bundle_id, runtime_bundle_manifest_sha256: checked.manifest_sha256 },
      sourceCheck: async () => {
        await verifyBundle(runtimeBundle, { requireEnvironment: true });
        check(hash(await readSafe(specification)) === hash(specBytes), 'QUALITY_SPECIFICATION_CHANGED');
      } });
  });
}
export async function inspectQuality(directory) {
  const inspected = await inspectGovernancePackage(directory);
  const plan = inspected.files['quality_plan.json'];
  check(Boolean(plan), 'QUALITY_PLAN_INVALID');
  const minimalRuntime = { runtime_bundle_id: plan.runtime_bundle_id, runtime_bundle_sha256: plan.runtime_bundle_sha256,
    descriptor: { engine_runtime_sha256: plan.engine_runtime_sha256 } };
  const config = Object.fromEntries(['quality_plan_schema_version', 'deployments', 'capture_dates_shanghai', 'locations', 'slots', 'cutoff_utc']
    .map(key => [key, plan[key]]));
  check(canonicalJson(qualityPlan(config, minimalRuntime, plan.frozen_at_utc)) === canonicalJson(plan), 'QUALITY_PLAN_INVALID');
  if (inspected.manifest.id_field === 'replay_quality_report_id') {
    const summary = inspected.files['summary.json'];
    const expected = { ...summarizeQuality(plan, inspected.files['captures.json'], inspected.files['observations.json']),
      independent_runs: 2, capture_inventory_sha256: summary.capture_inventory_sha256,
      capture_inventory_content_sha256: hash(canonicalJson(inspected.files['captures.json'])) };
    check(canonicalJson(summary) === canonicalJson(expected), 'QUALITY_DERIVED_SUMMARY_MISMATCH');
  } else check(inspected.manifest.id_field === 'replay_quality_plan_id', 'QUALITY_PACKAGE_KIND_INVALID');
  return inspected;
}
const cellKey = row => `${row.location_key}|${row.capture_date_shanghai}|${row.scheduled_slot}`;
export function qualityScenarios(row, replay) {
  const result = [];
  if (replay.minute_precip?.available === true) result.push('MINUTE_PRECIP_AVAILABLE');
  if (replay.nwp?.nodes?.some(node => node.utc_offset_seconds !== replay.context.utc_offset_seconds)) result.push('CROSS_TIMEZONE_NWP');
  if (row.timezone === 'Asia/Hong_Kong' && row.country === '中国' && row.admin1 === '香港特别行政区') result.push('HK_METADATA');
  return result.sort();
}
export function summarizeQuality(plan, captureInventory, observations) {
  check(captureInventory.capture_inventory_schema_version === 1 && Array.isArray(captureInventory.captures), 'QUALITY_CAPTURE_INVENTORY_INVALID');
  const expected = new Map(plan.expected_captures.map(row => [cellKey(row), row]));
  const captures = new Map();
  for (const row of captureInventory.captures) {
    const key = cellKey(row);
    check(expected.has(key) && !captures.has(key) && ['READY', 'MISSING', 'UPLOAD_FAILED', 'REPLAY_MISSING', 'FAILED', 'UNKNOWN'].includes(row.status) &&
      Array.isArray(row.snapshot_ids) && row.snapshot_ids.every(id => typeof id === 'string') &&
      new Set(row.snapshot_ids).size === row.snapshot_ids.length &&
      (!['MISSING', 'UPLOAD_FAILED', 'FAILED'].includes(row.status) || row.snapshot_ids.length === 0), 'QUALITY_CAPTURE_INVENTORY_INVALID');
    captures.set(key, row);
  }
  check(captures.size === expected.size, 'QUALITY_CAPTURE_DENOMINATOR_INCOMPLETE');
  const gaps = [], statusCounts = {}, scenarios = new Set();
  for (const [key, capture] of captures) {
    statusCounts[capture.status] = (statusCounts[capture.status] || 0) + 1;
    const rows = observations.filter(row => cellKey(row) === key);
    check(rows.every(row => capture.snapshot_ids.includes(row.snapshot_id)), 'QUALITY_UNDECLARED_CAPTURE');
    if (capture.status !== 'READY' || !rows.length || rows.length !== capture.snapshot_ids.length) {
      gaps.push({ ...expected.get(key), capture_status: capture.status, exported_ready_count: rows.length,
        recorded_snapshot_count: capture.snapshot_ids.length });
    }
    rows.forEach(row => row.scenarios.forEach(name => scenarios.add(name)));
  }
  const failures = observations.filter(row => row.status !== 'PASS');
  const pending = ['MINUTE_PRECIP_AVAILABLE', 'CROSS_TIMEZONE_NWP', 'HK_METADATA'].filter(name => !scenarios.has(name));
  return { status: failures.length || gaps.length ? 'FAIL' : pending.length ? 'COVERAGE_PENDING' : 'PASS',
    expected_capture_count: expected.size, capture_status_counts: statusCounts,
    exported_ready_count: observations.length, reference_pass_count: observations.length - failures.length,
    reference_failure_count: failures.length, gaps, pending_scenarios: pending,
    scenarios: [...scenarios].sort(), result_usage: 'REPLAY_ENGINEERING_ONLY', test_evaluated: false };
}
/** Computation reads only Snapshot/Replay; GT and candidate effects are unreachable. */
export async function computeQuality({ raw, plan, root, runReplay }) {
  const manifest = JSON.parse(await readSafe(path.join(raw, 'manifest.json')));
  const bytes = await readSafe(path.join(raw, 'raw/prediction_snapshots.csv'));
  check(hash(bytes) === manifest.files['raw/prediction_snapshots.csv']?.sha256, 'QUALITY_RAW_HASH_MISMATCH');
  const rows = readCsv(datasetSchema().tables.prediction_snapshots, bytes);
  const cells = new Map(plan.expected_captures.map(row => [cellKey(row), row]));
  const selected = rows.filter(row => row.snapshot_source === 'github_schedule' &&
    cells.has(cellKey({ ...row, capture_date_shanghai: dateAt(row.prediction_time_utc, 'Asia/Shanghai') })));
  const runner = runReplay || (await import('../replay/replay-runner.mjs')).runReplay;
  const result = [];
  for (const row of selected.sort((a, b) => compare(a.id, b.id))) {
    const date = dateAt(row.prediction_time_utc, 'Asia/Shanghai');
    const cell = cells.get(cellKey({ ...row, capture_date_shanghai: date }));
    check(row.timezone === cell.timezone && Date.parse(row.prediction_time_utc) <= Date.parse(plan.cutoff_utc) &&
      Date.parse(row.prediction_time_utc) > Math.max(...Object.values(plan.deployments).map(value => Date.parse(value.effective_at_utc))), 'QUALITY_CAPTURE_WINDOW_MISMATCH');
    const item = { snapshot_id: row.id, location_key: row.location_key, capture_date_shanghai: date,
      event_date_local: row.event_date_local, scheduled_slot: row.scheduled_slot, scenarios: [],
      status: 'FAIL', error_code: null, reference: null };
    try {
      safeId(row.id);
      const replayBytes = await readSafe(path.join(raw, 'replay', row.id + '.json'));
      check(hash(replayBytes) === row.replay_sha256, 'QUALITY_REPLAY_HASH_MISMATCH');
      const replay = await validateReplayPayload(JSON.parse(replayBytes), row);
      assertCaptureBuild(row, replay, plan);
      item.scenarios = qualityScenarios(row, replay);
      const report = await runner(replay, { reference: row, engineRoot: root });
      item.reference = { pass: report.pass, actual: report.actual, deltas: report.deltas,
        comparison_errors: report.comparison_errors || [] };
      item.status = report.pass ? 'PASS' : 'FAIL';
      if (!report.pass) item.error_code = 'REFERENCE_MISMATCH';
    } catch (error) {
      if (['ENOMEM', 'ENOSPC', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)) fail('QUALITY_TRANSIENT_EXECUTION_FAILURE');
      item.error_code = errorCode(error);
    }
    result.push(item);
  }
  return result;
}
export async function runQuality({ raw, plan: directory, runtimeBundle, captureInventory, output }) {
  const out = await outside(output, [raw, directory, runtimeBundle, captureInventory]);
  const roots = [path.dirname(path.dirname(raw)), path.dirname(out), path.dirname(path.dirname(path.dirname(runtimeBundle))),
    path.dirname(path.dirname(path.dirname(path.dirname(directory))))];
  // Canonical root order; no write while waiting on another root.
  roots.sort(); for (let i = roots.length - 1; i > 0; i--) if (roots[i] === roots[i - 1]) roots.splice(i, 1);
  async function operation() {
    const inspected = await inspectQuality(directory), plan = inspected.files['quality_plan.json'];
    check(inspected.manifest.id_field === 'replay_quality_plan_id', 'QUALITY_PLAN_INVALID');
    const runtime = await verifyBundle(runtimeBundle, { requireEnvironment: true });
    await assertQualityRuntime(runtime);
    check(runtime.runtime_bundle_id === plan.runtime_bundle_id && runtime.runtime_bundle_sha256 === plan.runtime_bundle_sha256, 'QUALITY_RUNTIME_MISMATCH');
    const expectedPlan = qualityPlan(Object.fromEntries(['quality_plan_schema_version', 'deployments', 'capture_dates_shanghai', 'locations', 'slots', 'cutoff_utc']
      .map(key => [key, plan[key]])), runtime, plan.frozen_at_utc);
    check(canonicalJson(expectedPlan) === canonicalJson(plan), 'QUALITY_PLAN_INVALID');
    const before = await fingerprintSourcePackage(raw);
    const governanceFingerprint = await fingerprintExecutionRoot();
    const rawValidation = await validateDataset(raw);
    check(rawValidation.report?.status === 'PASS', 'QUALITY_RAW_PACKAGE_INVALID');
    const inventoryBytes = await readSafe(captureInventory), capture = JSON.parse(inventoryBytes);
    const planHash = hash(await readSafe(path.join(directory, 'manifest.json')));
    const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
    const args = [raw, directory, runtime.source];
    const first = JSON.parse(await nodeProcess(worker, args));
    const second = JSON.parse(await nodeProcess(worker, args));
    check(canonicalJson(first) === canonicalJson(second), 'QUALITY_RECOMPUTE_MISMATCH');
    const summary = summarizeQuality(plan, capture, first);
    const manifest = JSON.parse(await readSafe(path.join(raw, 'manifest.json')));
    const links = { replay_quality_plan_id: inspected.manifest.replay_quality_plan_id,
      replay_quality_plan_manifest_sha256: planHash, source_dataset_id: manifest.dataset_id,
      source_dataset_manifest_sha256: before['manifest.json'], runtime_bundle_id: runtime.runtime_bundle_id,
      runtime_bundle_manifest_sha256: runtime.manifest_sha256,
      quality_governance_sha256: hash(canonicalJson(governanceFingerprint)) };
    await protectExternalReferences(roots, out);
    const published = await publishGovernancePackage({ output: out, kind: 'replay_quality_report',
      idField: 'replay_quality_report_id', links,
      payloads: { 'quality_plan.json': plan, 'summary.json': { ...summary, independent_runs: 2,
        capture_inventory_sha256: hash(inventoryBytes), capture_inventory_content_sha256: hash(canonicalJson(capture)) },
        'captures.json': capture, 'observations.json': first },
      sourceCheck: async () => {
        check(canonicalJson(await fingerprintSourcePackage(raw)) === canonicalJson(before), 'QUALITY_SOURCE_CHANGED');
        check(hash(await readSafe(captureInventory)) === hash(inventoryBytes) &&
          hash(await readSafe(path.join(directory, 'manifest.json'))) === planHash, 'QUALITY_SOURCE_CHANGED');
        await inspectGovernancePackage(directory); await verifyBundle(runtimeBundle, { requireEnvironment: true });
        check(canonicalJson(await fingerprintExecutionRoot()) === canonicalJson(governanceFingerprint), 'QUALITY_GOVERNANCE_CHANGED');
      } });
    return { ...published, quality_status: summary.status, expected_capture_count: summary.expected_capture_count,
      exported_ready_count: summary.exported_ready_count, pending_scenarios: summary.pending_scenarios };
  }
  return withGovernanceLeases('replay_quality', roots, operation);
}
export async function qualityCli(args) {
  const command = args.shift();
  if (command === 'verify' && args.length === 1) return inspectQuality(path.resolve(args[0]));
  if (!['plan', 'run'].includes(command)) fail('INVALID_ARGUMENTS');
  const options = {}, mapping = { '--specification': 'specification', '--runtime-bundle': 'runtimeBundle',
    '--output': 'output', '--raw': 'raw', '--plan': 'plan', '--capture-inventory': 'captureInventory' };
  for (let i = 0; i < args.length; i += 2) {
    const key = mapping[args[i]], value = args[i + 1];
    if (!key || options[key] || !value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    options[key] = path.resolve(value);
  }
  const needed = command === 'plan' ? ['specification', 'runtimeBundle', 'output'] : ['raw', 'plan', 'runtimeBundle', 'captureInventory', 'output'];
  if (needed.some(key => !options[key]) || Object.keys(options).some(key => !needed.includes(key))) fail('INVALID_ARGUMENTS');
  return command === 'plan' ? planQuality(options) : runQuality(options);
}
if (isMain(import.meta.url)) {
  try { console.log(canonicalJson(await qualityCli(process.argv.slice(2)))); }
  catch (error) { console.log(canonicalJson({ status: 'FAIL', error_code: errorCode(error) })); process.exitCode = 1; }
}
