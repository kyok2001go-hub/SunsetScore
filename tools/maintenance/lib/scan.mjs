import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { canonicalJson, compare, errorCode, hash, readSafe, safePath } from '../../dataset/lib/common.mjs';
import { silentProgress } from '../../progress.mjs';
import {
  ADVISORY_DIAGNOSTIC_CODES, DEFAULT_DATASET_ROOT, PHASES,
  dependenciesOf, isSupportedVersion, supportedVersionLabel
} from '../maintenance-policy.mjs';
import { inspectMaintenanceState, maintenanceRoot } from './lease.mjs';

const LOCK_SUFFIX = '.lock';

export const relativePath = (datasetRoot, absolute) =>
  path.relative(datasetRoot, absolute).split(path.sep).join('/');

export function diagnostic(code, { nodeId = null, relatedId = null, detail = null } = {}) {
  return {
    code,
    severity: ADVISORY_DIAGNOSTIC_CODES.includes(code) ? 'ADVISORY' : 'ERROR',
    node_id: nodeId, related_id: relatedId, detail
  };
}

async function measure(directory) {
  let bytes = 0;
  let files = 0;
  const stack = [''];
  while (stack.length) {
    const prefix = stack.pop();
    const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      const absolute = path.join(directory, relative);
      if (entry.isSymbolicLink()) {
        return { files, bytes, unsafe: relativePath(directory, absolute) };
      }
      if (entry.isDirectory()) {
        stack.push(relative);
        continue;
      }
      if (!entry.isFile()) return { files, bytes, unsafe: relativePath(directory, absolute) };
      files += 1;
      bytes += (await lstat(absolute)).size;
    }
  }
  return { files, bytes, unsafe: null };
}

function invalidNode(phase, id, relative) {
  return {
    phase: phase.phase, phase_key: phase.key, phase_label: phase.label, id, declared_id: null,
    relative_path: relative, absolute_path: null, manifest_sha256: null, descriptor_sha256: null,
    schema_version: null, policy_version: null, file_count: 0, bytes: 0, status: 'INVALID'
  };
}

async function scanPhase(phase, { datasetRoot, diagnostics, progress }) {
  const root = await safePath(path.join(datasetRoot, phase.relativeRoot));
  const nodes = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return nodes;
    throw error;
  }
  for (const entry of entries.slice().sort((a, b) => compare(a.name, b.name))) {
    const relative = `${phase.relativeRoot}/${entry.name}`;
    if (entry.name.startsWith('.')) {
      diagnostics.push(diagnostic('IGNORED_ENTRY', { detail: relative }));
      continue;
    }
    if (entry.name.endsWith(LOCK_SUFFIX)) {
      diagnostics.push(diagnostic('PACKAGE_LOCK_PRESENT', {
        nodeId: entry.name.slice(0, -LOCK_SUFFIX.length), detail: relative
      }));
      continue;
    }
    if (entry.isSymbolicLink()) {
      diagnostics.push(diagnostic('UNSAFE_PATH', { nodeId: entry.name, detail: relative }));
      continue;
    }
    if (!entry.isDirectory()) {
      diagnostics.push(diagnostic('UNEXPECTED_FILE', { detail: relative }));
      continue;
    }
    const absolute = path.join(root, entry.name);
    let bytes;
    try {
      bytes = await readSafe(path.join(absolute, 'manifest.json'));
    } catch (error) {
      diagnostics.push(diagnostic('MANIFEST_UNREADABLE', { nodeId: entry.name, detail: errorCode(error) }));
      nodes.push(invalidNode(phase, entry.name, relative));
      continue;
    }
    const text = bytes.toString('utf8');
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      diagnostics.push(diagnostic('MANIFEST_INVALID', { nodeId: entry.name, detail: 'JSON_PARSE_FAILED' }));
      nodes.push(invalidNode(phase, entry.name, relative));
      continue;
    }
    if (canonicalJson(manifest) !== text) {
      diagnostics.push(diagnostic('MANIFEST_NOT_CANONICAL', { nodeId: entry.name }));
    }
    const declaredId = manifest[phase.idField] ?? null;
    if (declaredId !== entry.name) {
      diagnostics.push(diagnostic('DIRECTORY_ID_MISMATCH', {
        nodeId: entry.name, detail: { field: phase.idField, declared: declaredId }
      }));
    }
    const schemaVersion = manifest[phase.schemaField] ?? null;
    const policyVersion = phase.policyField ? (manifest[phase.policyField] ?? null) : null;
    if (!isSupportedVersion(phase, schemaVersion, policyVersion)) {
      diagnostics.push(diagnostic('UNSUPPORTED_LINEAGE', {
        nodeId: entry.name,
        detail: { schema_version: schemaVersion, policy_version: policyVersion, supported: supportedVersionLabel(phase) }
      }));
    }
    const descriptorSha256 = manifest.descriptor_sha256 ?? null;
    if (typeof descriptorSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptorSha256)) {
      diagnostics.push(diagnostic('DESCRIPTOR_INVALID', { nodeId: entry.name }));
    } else if (hash(canonicalJson(manifest.descriptor)) !== descriptorSha256) {
      diagnostics.push(diagnostic('DESCRIPTOR_MISMATCH', { nodeId: entry.name }));
    }
    const size = await measure(absolute);
    if (size.unsafe) {
      diagnostics.push(diagnostic('UNSAFE_PATH', { nodeId: entry.name, detail: size.unsafe }));
    }
    let dependencies = [];
    try {
      dependencies = dependenciesOf(phase, manifest);
    } catch (error) {
      diagnostics.push(diagnostic('MANIFEST_INVALID', { nodeId: entry.name, detail: errorCode(error) }));
    }
    progress.update(`${relative}`);
    nodes.push({
      phase: phase.phase, phase_key: phase.key, phase_label: phase.label,
      id: entry.name, declared_id: declaredId,
      relative_path: relative, absolute_path: absolute,
      manifest_sha256: hash(bytes), descriptor_sha256: descriptorSha256,
      schema_version: schemaVersion, policy_version: policyVersion,
      file_count: size.files, bytes: size.bytes,
      status: size.unsafe ? 'INVALID' : 'OK',
      _dependencies: dependencies
    });
  }
  return nodes;
}

function compareNodes(a, b) {
  return a.phase - b.phase || compare(a.id, b.id);
}

function compareEdges(a, b) {
  return compare(a.parent_id, b.parent_id) || compare(a.child_id, b.child_id) || compare(a.kind, b.kind);
}

function reachableThrough(edges, from, to) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.parent_id)) adjacency.set(edge.parent_id, []);
    adjacency.get(edge.parent_id).push(edge.child_id);
  }
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    for (const next of adjacency.get(queue.shift()) || []) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/**
 * Transitive reduction of the drawn edges only.
 *
 * Phase 1-5 run in order, so an edge whose target is already reachable through other packages
 * adds a line without adding information: Tuning restates its Raw / GT sources, and the Model
 * edge that already carries them. Each candidate is tested against the edges kept so far, so
 * reachability is preserved exactly and the compact drawing still answers "what dies with what".
 *
 * This is presentation only. `graph.edges` stays complete for the JSON listing and every prune
 * plan, so cascade removal never depends on what the drawing chose to show.
 */
export function reduceEdgesForDrawing(edges) {
  const ordered = edges.slice().sort(compareEdges);
  const working = new Set(ordered);
  const kept = [];
  for (const edge of ordered) {
    working.delete(edge);
    if (reachableThrough(working, edge.parent_id, edge.child_id)) continue;
    kept.push(edge);
    working.add(edge);
  }
  return kept.sort(compareEdges);
}

/**
 * Enumerates the five published package roots and derives the dependency edges from manifest
 * fields only. Directory names are never used to guess a parent, and a 12 character hash prefix
 * is never treated as proof of lineage.
 */
export async function scanDataset(options = {}) {
  const progress = options.progress || silentProgress;
  const datasetRoot = await safePath(options.datasetRoot || DEFAULT_DATASET_ROOT);
  const diagnostics = [];
  const roots = [];
  const nodes = [];
  progress.stage('扫描五阶段发布目录');
  for (const phase of PHASES) {
    roots.push({
      phase: phase.phase, key: phase.key, label: phase.label,
      relative_root: phase.relativeRoot, absolute_path: path.join(datasetRoot, phase.relativeRoot)
    });
    nodes.push(...await scanPhase(phase, { datasetRoot, diagnostics, progress }));
  }

  const byId = new Map();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      diagnostics.push(diagnostic('DUPLICATE_ID', {
        nodeId: node.id, detail: { existing_phase: byId.get(node.id).phase, duplicate_phase: node.phase }
      }));
      continue;
    }
    byId.set(node.id, node);
  }

  const edges = [];
  for (const node of nodes.slice().sort(compareNodes)) {
    for (const dependency of node._dependencies || []) {
      const parent = byId.get(dependency.id);
      if (!parent) {
        diagnostics.push(diagnostic('PARENT_MISSING', {
          nodeId: node.id, relatedId: dependency.id, detail: dependency.idField
        }));
        continue;
      }
      if (parent.phase >= node.phase) {
        diagnostics.push(diagnostic('PHASE_ORDER_INVALID', {
          nodeId: node.id, relatedId: parent.id,
          detail: { field: dependency.idField, parent_phase: parent.phase, child_phase: node.phase }
        }));
      }
      if (dependency.expectedManifestSha256 !== null && dependency.expectedManifestSha256 !== parent.manifest_sha256) {
        diagnostics.push(diagnostic('PARENT_HASH_MISMATCH', {
          nodeId: node.id, relatedId: parent.id, detail: dependency.idField
        }));
      }
      edges.push({
        parent_id: parent.id, child_id: node.id, kind: dependency.kind,
        id_field: dependency.idField, expected_manifest_sha256: dependency.expectedManifestSha256,
        parent_phase: parent.phase, child_phase: node.phase
      });
    }
    // Tuning repeats Raw / GT without hashes; the Model dependency is the authority for them.
    if (node.phase_key === 'sensitivity') crossCheckTuning(node, byId, diagnostics);
  }

  const maintenance = await inspectMaintenanceState(datasetRoot);
  const graph = {
    dataset_root: datasetRoot,
    maintenance_root: maintenanceRoot(datasetRoot),
    roots,
    nodes: nodes.map(stripInternals).sort(compareNodes),
    edges: dedupeEdges(edges).sort(compareEdges),
    diagnostics: diagnostics.slice().sort(compareDiagnostics),
    maintenance
  };
  progress.stage('依赖图构建完成');
  return graph;
}

function crossCheckTuning(node, byId, diagnostics) {
  const dependencies = node._dependencies || [];
  const find = field => dependencies.find(item => item.idField === field);
  const model = find('model_dataset_id');
  const raw = find('source_dataset_id');
  const gt = find('ground_truth_id');
  if (!model) return;
  const modelNode = byId.get(model.id);
  if (!modelNode) return;
  const modelDependencies = modelNode._dependencies || [];
  const modelRaw = modelDependencies.find(item => item.idField === 'source_dataset_id');
  const modelGt = modelDependencies.find(item => item.idField === 'ground_truth_id');
  if (raw && modelRaw && modelRaw.id !== raw.id) {
    diagnostics.push(diagnostic('REFERENCE_INCONSISTENT', {
      nodeId: node.id, relatedId: raw.id, detail: { field: 'source_dataset_id', expected: modelRaw.id }
    }));
  }
  if (gt && modelGt && modelGt.id !== gt.id) {
    diagnostics.push(diagnostic('REFERENCE_INCONSISTENT', {
      nodeId: node.id, relatedId: gt.id, detail: { field: 'ground_truth_id', expected: modelGt.id }
    }));
  }
}

function stripInternals(node) {
  const { _dependencies, ...rest } = node;
  return rest;
}

function dedupeEdges(edges) {
  const seen = new Map();
  for (const edge of edges) {
    const key = `${edge.parent_id}|${edge.child_id}|${edge.kind}`;
    if (!seen.has(key)) seen.set(key, edge);
  }
  return [...seen.values()];
}

function compareDiagnostics(a, b) {
  return compare(a.code, b.code) || compare(a.node_id ?? '', b.node_id ?? '') || compare(a.related_id ?? '', b.related_id ?? '');
}

/**
 * Identity of the scanned graph. Apply re-derives this and refuses to touch anything when it
 * differs, so a package added, removed or relinked after planning stops the run.
 */
export function graphFingerprint(graph) {
  return hash(canonicalJson({
    nodes: graph.nodes.map(node => ({
      phase: node.phase, id: node.id, relative_path: node.relative_path,
      manifest_sha256: node.manifest_sha256, descriptor_sha256: node.descriptor_sha256,
      schema_version: node.schema_version, policy_version: node.policy_version, status: node.status
    })),
    edges: graph.edges.map(edge => ({
      parent_id: edge.parent_id, child_id: edge.child_id, kind: edge.kind,
      expected_manifest_sha256: edge.expected_manifest_sha256
    })),
    diagnostics: graph.diagnostics
  }));
}

export function nodeById(graph, id) {
  return graph.nodes.find(node => node.id === id) || null;
}

export function childrenOf(graph, id) {
  return graph.edges.filter(edge => edge.parent_id === id).map(edge => edge.child_id);
}

export function parentsOf(graph, id) {
  return graph.edges.filter(edge => edge.child_id === id).map(edge => edge.parent_id);
}

export function reachable(graph, id, step) {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    for (const next of step(graph, queue.shift())) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

export const descendantsOf = (graph, id) => reachable(graph, id, childrenOf);
export const ancestorsOf = (graph, id) => reachable(graph, id, parentsOf);

export function blockingDiagnostics(graph, closure) {
  return graph.diagnostics.filter(item => item.severity === 'ERROR' &&
    (item.node_id === null || closure.has(item.node_id)));
}

export function advisoryDiagnostics(graph, closure) {
  return graph.diagnostics.filter(item => item.severity === 'ADVISORY' &&
    (item.node_id === null || closure.has(item.node_id)));
}
