import path from 'node:path';
import { appendFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { canonicalJson, compare, fail, hash, readSafe, safePath, within } from '../../dataset/lib/common.mjs';
import { silentProgress } from '../../progress.mjs';
import {
  MAINTENANCE_SCHEMA_VERSION, PHASES, TOOL_VERSION, phaseByNumber
} from '../maintenance-policy.mjs';
import {
  advisoryDiagnostics, blockingDiagnostics, childrenOf, descendantsOf, graphFingerprint,
  nodeById, relativePath, scanDataset
} from './scan.mjs';
import { quarantineRoot, withMaintenanceWindow } from './lease.mjs';

const ORDERED_PHASES = [...PHASES].sort((a, b) => b.phase - a.phase);

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function compareNodesAscending(a, b) {
  return a.phase - b.phase || compare(a.id, b.id);
}

function compareNodesDescending(a, b) {
  return b.phase - a.phase || compare(a.id, b.id);
}

/** Breadth-first walk over dependent packages, keeping the edge that first reached each node. */
function reachabilityReasons(graph, targetId) {
  const reasons = new Map([[targetId, [{ kind: 'TARGET' }]]]);
  const queue = [targetId];
  while (queue.length) {
    const current = queue.shift();
    for (const child of childrenOf(graph, current)) {
      if (!reasons.has(child)) {
        reasons.set(child, []);
        queue.push(child);
      }
      const edge = graph.edges.find(item =>
        item.parent_id === current && item.child_id === child);
      reasons.get(child).push({ via: current, kind: edge.kind, id_field: edge.id_field });
    }
  }
  return reasons;
}

export function isInsidePublishedRoot(datasetRoot, file) {
  return PHASES.some(phase => within(path.join(datasetRoot, phase.relativeRoot), file));
}

/**
 * Read-only prune plan. The closure follows every dependent edge, including the Tuning V2
 * validation disclosure evidence, so a branch that merely references the selected package is
 * still removed while unrelated branches and shared upstreams are left untouched.
 */
export function buildPrunePlan({ graph, targetId, datasetRoot, createdAt }) {
  const target = nodeById(graph, targetId);
  if (!target) fail('MAINTENANCE_TARGET_MISSING', { target_id: targetId });
  const closure = descendantsOf(graph, targetId);
  const nodes = graph.nodes.filter(node => closure.has(node.id)).sort(compareNodesAscending);
  const edges = graph.edges
    .filter(edge => closure.has(edge.parent_id) && closure.has(edge.child_id))
    .sort((a, b) => compare(a.parent_id, b.parent_id) || compare(a.child_id, b.child_id) || compare(a.kind, b.kind));
  const reasons = reachabilityReasons(graph, targetId);

  const blockers = [];
  for (const item of blockingDiagnostics(graph, closure)) {
    blockers.push({ code: item.code, node_id: item.node_id, related_id: item.related_id, detail: item.detail });
  }
  for (const node of nodes) {
    if (node.status !== 'OK') blockers.push({ code: 'NODE_INVALID', node_id: node.id, related_id: null, detail: null });
    if (node.phase < target.phase) {
      blockers.push({ code: 'BACKWARD_DEPENDENCY', node_id: node.id, related_id: null,
        detail: { target_phase: target.phase, dependent_phase: node.phase } });
    }
  }
  const advisories = advisoryDiagnostics(graph, closure).map(item =>
    ({ code: item.code, node_id: item.node_id, related_id: item.related_id, detail: item.detail }));

  const plan = {
    maintenance_schema_version: MAINTENANCE_SCHEMA_VERSION,
    tool_version: TOOL_VERSION,
    status: blockers.length ? 'BLOCKED' : 'READY',
    created_at_utc: createdAt || new Date().toISOString(),
    dataset_root: graph.dataset_root,
    maintenance_root: graph.maintenance_root,
    roots: graph.roots,
    graph_sha256: graphFingerprint(graph),
    target: {
      phase: target.phase, phase_key: target.phase_key, id: target.id,
      relative_path: target.relative_path, absolute_path: target.absolute_path,
      manifest_sha256: target.manifest_sha256, descriptor_sha256: target.descriptor_sha256
    },
    targets: nodes.map(node => ({
      phase: node.phase, phase_key: node.phase_key, id: node.id,
      relative_path: node.relative_path, absolute_path: node.absolute_path,
      manifest_sha256: node.manifest_sha256, descriptor_sha256: node.descriptor_sha256,
      file_count: node.file_count, bytes: node.bytes,
      reasons: (reasons.get(node.id) || []).map(reason => reason.kind === 'TARGET'
        ? { kind: 'TARGET' } : { kind: reason.kind, via: reason.via, id_field: reason.id_field })
    })).sort(compareNodesAscending),
    execution_order: nodes.slice().sort(compareNodesDescending).map(node => ({ phase: node.phase, id: node.id })),
    edges,
    blockers,
    advisories
  };
  return { ...plan, plan_sha256: planDigest(plan) };
}

export function planDigest(plan) {
  const { plan_sha256, ...rest } = plan;
  return hash(canonicalJson(rest));
}

export async function writePlan(planPath, plan, options = {}) {
  const resolved = await safePath(planPath);
  if (isInsidePublishedRoot(plan.dataset_root, resolved)) {
    fail('MAINTENANCE_UNSAFE_PATH', { reason_code: 'PLAN_INSIDE_PUBLISHED_ROOT', detail: resolved });
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  try {
    await writeFile(resolved, canonicalJson(plan), { encoding: 'utf8', flag: options.overwrite ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') fail('MAINTENANCE_PLAN_EXISTS', { detail: resolved });
    throw error;
  }
  return resolved;
}

export async function readPlan(planPath) {
  const resolved = await safePath(planPath);
  const bytes = await readSafe(resolved);
  let plan;
  try {
    plan = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('MAINTENANCE_PLAN_INVALID', { reason_code: 'JSON_PARSE_FAILED' });
  }
  if (plan.maintenance_schema_version !== MAINTENANCE_SCHEMA_VERSION) {
    fail('MAINTENANCE_PLAN_INVALID', { reason_code: 'UNSUPPORTED_MAINTENANCE_SCHEMA' });
  }
  if (planDigest(plan) !== plan.plan_sha256) {
    fail('MAINTENANCE_PLAN_INVALID', { reason_code: 'PLAN_DIGEST_MISMATCH' });
  }
  return { plan, absolutePath: resolved };
}

async function readLog(logPath) {
  let text = '';
  try {
    text = (await readFile(logPath)).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  const state = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail('MAINTENANCE_PLAN_INVALID', { reason_code: 'OPERATION_LOG_NOT_READABLE' });
    }
    state.set(record.id, record.status);
  }
  return state;
}

function logRecord(target, status) {
  return canonicalJson({
    at_utc: new Date().toISOString(), phase: target.phase, id: target.id,
    manifest_sha256: target.manifest_sha256, status
  }) + '\n';
}

async function verifyPackage(directory, target, code) {
  await safePath(directory);
  const info = await lstat(directory);
  if (!info.isDirectory()) fail(code, { target_id: target.id, reason_code: 'NOT_A_DIRECTORY' });
  if (path.basename(directory) !== target.id) {
    fail(code, { target_id: target.id, reason_code: 'DIRECTORY_NAME_MISMATCH' });
  }
  const bytes = await readSafe(path.join(directory, 'manifest.json'));
  if (hash(bytes) !== target.manifest_sha256) {
    fail(code, { target_id: target.id, reason_code: 'MANIFEST_HASH_MISMATCH' });
  }
}

export function targetPaths(datasetRoot, target) {
  const phase = phaseByNumber(target.phase);
  const exportsRoot = path.join(datasetRoot, phase.relativeRoot);
  const source = path.join(exportsRoot, target.id);
  if (!within(exportsRoot, source) || path.resolve(path.dirname(source)) !== path.resolve(exportsRoot)) {
    fail('MAINTENANCE_UNSAFE_PATH', { target_id: target.id, reason_code: 'TARGET_OUTSIDE_EXPORTS' });
  }
  return { exportsRoot, source };
}

/**
 * Plan -> re-verify -> quarantine move -> delete. Each package is moved atomically inside the
 * same filesystem first, so the published root only ever shows a package as present or absent;
 * only after the move is the quarantine copy deleted.
 */
export async function applyPrunePlan(options) {
  const progress = options.progress || silentProgress;
  const { plan, absolutePath } = await readPlan(options.planPath);
  if (options.resume && !(await exists(path.join(quarantineRoot(plan.dataset_root), plan.plan_sha256)))) {
    fail('MAINTENANCE_PLAN_INVALID', { reason_code: 'NOTHING_TO_RESUME' });
  }
  if (plan.status !== 'READY') fail('MAINTENANCE_PLAN_BLOCKED', { blockers: plan.blockers.length });
  if (options.datasetRoot && path.resolve(options.datasetRoot) !== path.resolve(plan.dataset_root)) {
    fail('MAINTENANCE_PLAN_DATASET_MISMATCH', { plan: plan.dataset_root, requested: path.resolve(options.datasetRoot) });
  }
  const datasetRoot = path.resolve(plan.dataset_root);
  const quarantine = path.join(quarantineRoot(datasetRoot), plan.plan_sha256);
  const logPath = path.join(quarantine, 'operations.log.jsonl');
  const results = [];

  await withMaintenanceWindow(async () => {
    // A resume starts from a graph the previous run already changed, so it proves per-target
    // state instead of the whole-graph fingerprint. A fresh apply still requires an exact match.
    progress.stage('复核计划对应的数据图');
    const graph = await scanDataset({ datasetRoot, progress });
    if (!options.resume) {
      if (graphFingerprint(graph) !== plan.graph_sha256) {
        fail('MAINTENANCE_PLAN_STALE', { reason_code: 'GRAPH_CHANGED' });
      }
      for (const target of plan.targets) {
        const node = nodeById(graph, target.id);
        if (!node || node.manifest_sha256 !== target.manifest_sha256) {
          fail('MAINTENANCE_PLAN_STALE', { target_id: target.id, reason_code: 'TARGET_CHANGED' });
        }
      }
    }

    await mkdir(quarantine, { recursive: true });
    const log = await readLog(logPath);
    progress.stage('按 Phase 5 → Phase 1 顺序清理');
    for (const target of plan.targets.slice().sort(compareNodesDescending)) {
      const { source } = targetPaths(datasetRoot, target);
      const destination = path.join(quarantine, `phase${target.phase}`, target.id);
      const recorded = log.get(target.id) || null;
      const sourceExists = await exists(source);
      const destinationExists = await exists(destination);
      if (recorded === 'DELETED' && !sourceExists && !destinationExists) {
        results.push({ phase: target.phase, id: target.id, status: 'DELETED', skipped: true });
        continue;
      }
      if (sourceExists && destinationExists) {
        fail('MAINTENANCE_QUARANTINE_CONFLICT', { target_id: target.id });
      }
      if (!sourceExists && !destinationExists) {
        // A MOVED record with neither copy left means the delete finished but its log line did
        // not; anything else is an unexplained disappearance and stops the run.
        if (recorded !== 'MOVED') fail('MAINTENANCE_TARGET_MISSING', { target_id: target.id });
        await appendFile(logPath, logRecord(target, 'DELETED'));
        log.set(target.id, 'DELETED');
        results.push({ phase: target.phase, id: target.id, status: 'DELETED', skipped: true });
        continue;
      }
      if (destinationExists) {
        await verifyPackage(destination, target, 'MAINTENANCE_TARGET_CHANGED');
        if (!log.has(target.id)) {
          await appendFile(logPath, logRecord(target, 'MOVED'));
          log.set(target.id, 'MOVED');
        }
      } else {
        await verifyPackage(source, target, 'MAINTENANCE_TARGET_CHANGED');
        await mkdir(path.dirname(destination), { recursive: true });
        await rename(source, destination);
        await appendFile(logPath, logRecord(target, 'MOVED'));
        log.set(target.id, 'MOVED');
      }
      progress.update(`${target.phase}/${target.id}`);
      await rm(destination, { recursive: true, force: true });
      await appendFile(logPath, logRecord(target, 'DELETED'));
      log.set(target.id, 'DELETED');
      results.push({ phase: target.phase, id: target.id, status: 'DELETED', skipped: false });
    }
  }, { datasetRoot });

  return {
    status: 'PRUNED',
    plan: absolutePath,
    plan_sha256: plan.plan_sha256,
    dataset_root: datasetRoot,
    quarantine,
    operation_log: logPath,
    deleted_count: results.filter(item => item.status === 'DELETED').length,
    results
  };
}

export function planSummary(plan) {
  const byPhase = {};
  for (const target of plan.targets) byPhase[target.phase] = (byPhase[target.phase] || 0) + 1;
  return {
    phase_counts: byPhase,
    total_bytes: plan.targets.reduce((sum, target) => sum + (target.bytes || 0), 0),
    total_files: plan.targets.reduce((sum, target) => sum + (target.file_count || 0), 0),
    evidence_edges: plan.edges.filter(edge => edge.kind === 'EVIDENCE')
      .map(edge => `${edge.parent_id} -> ${edge.child_id}: VALIDATION ${edge.kind}`)
  };
}
