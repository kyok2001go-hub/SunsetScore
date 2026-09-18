import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, fail } from '../../dataset/lib/common.mjs';
import { tuningPolicy } from '../tuning-policy.mjs';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export async function computeRuntimeSha256(root = APP_ROOT) {
  const policy = tuningPolicy();
  const digest = [];
  for (const rel of policy.runtime_files) {
    const bytes = await readFile(path.join(root, rel));
    digest.push(rel, hash(bytes));
  }
  return hash(digest.join('\n'));
}

async function definedNamespaces(jsDir) {
  const map = new Map();
  for (const name of (await readdir(jsDir)).filter(f => f.endsWith('.js')).sort()) {
    const source = await readFile(path.join(jsDir, name), 'utf8');
    for (const match of source.matchAll(/SS\.([A-Za-z_$][\w$]*)\s*=/g)) {
      if (!map.has(match[1])) map.set(match[1], 'js/' + name);
    }
  }
  return map;
}

/**
 * Asserts the frozen Runtime list covers every namespace the scoring path reaches.
 * References from the network-acquisition path are declared in the policy; anything
 * else fails so a newly added scoring module cannot be silently left out of the hash.
 */
export async function verifyRuntimeImports(root = APP_ROOT) {
  const policy = tuningPolicy();
  const listed = new Set(policy.runtime_files);
  const defines = await definedNamespaces(path.join(root, 'js'));
  const allowed = policy.non_scoring_namespace_references;
  const observed = {};

  for (const rel of policy.runtime_files) {
    const source = await readFile(path.join(root, rel), 'utf8');
    const own = path.basename(rel);
    for (const match of source.matchAll(/SS\.([A-Za-z_$][\w$]*)/g)) {
      const namespace = match[1];
      const owner = defines.get(namespace);
      if (!owner || listed.has(owner) || path.basename(owner) === own) continue;
      if (!observed[rel]) observed[rel] = new Set();
      observed[rel].add(namespace);
    }
  }

  const normalized = {};
  for (const [rel, namespaces] of Object.entries(observed)) {
    normalized[rel] = [...namespaces].sort();
  }
  const expected = {};
  for (const [rel, namespaces] of Object.entries(allowed)) expected[rel] = [...namespaces].sort();

  const ordered = value => Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  if (JSON.stringify(ordered(normalized)) !== JSON.stringify(ordered(expected))) {
    fail('TUNING_VALIDATION_FAILED', {
      reason_code: 'RUNTIME_IMPORT_GRAPH_DRIFT',
      observed: normalized,
      declared: expected
    });
  }
  return { runtime_files: [...policy.runtime_files], non_scoring_references: normalized };
}

export async function runtimeDocument(root = APP_ROOT) {
  const policy = tuningPolicy();
  const [sha256, imports] = await Promise.all([computeRuntimeSha256(root), verifyRuntimeImports(root)]);
  return {
    engine_runtime_sha256: sha256,
    runtime_file_count: policy.runtime_files.length,
    runtime_files: imports.runtime_files,
    non_scoring_namespace_references: imports.non_scoring_references
  };
}
