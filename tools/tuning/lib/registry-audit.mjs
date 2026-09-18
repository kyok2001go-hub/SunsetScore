import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../../dataset/lib/common.mjs';
import { bindingIsNamespaceScoped, KNOWN_BINDINGS, DEFAULT_ANCHOR_BINDINGS } from './bindings.mjs';
import { resolvePath } from './base-config.mjs';

const ANCHOR_TOLERANCE = 2;

async function readLines(root, rel) {
  try {
    return (await readFile(path.join(root, rel), 'utf8')).split(/\r?\n/);
  } catch {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'WIRING_EVIDENCE_FILE_MISSING', detail: rel });
  }
}

async function verifyAnchor(root, anchor) {
  const lines = await readLines(root, anchor.file);
  const index = anchor.line - 1;
  const from = Math.max(0, index - ANCHOR_TOLERANCE);
  const to = Math.min(lines.length - 1, index + ANCHOR_TOLERANCE);
  for (let i = from; i <= to; i++) {
    if (lines[i] && lines[i].includes(anchor.token)) return { ...anchor, verified: true, matched_line: i + 1 };
  }
  const actual_lines = [];
  lines.forEach((line, i) => { if (line.includes(anchor.token)) actual_lines.push(i + 1); });
  return { ...anchor, verified: false, actual_lines };
}

function namespaceOf(canonicalPath) {
  return String(canonicalPath).split('.')[0];
}

async function scanScoringReferences(root, token) {
  const jsDir = path.join(root, 'js');
  const hits = [];
  for (const name of (await readdir(jsDir)).filter(f => f.endsWith('.js')).sort()) {
    if (name === 'config.js' || name === 'model_config.js') continue;
    const lines = (await readFile(path.join(jsDir, name), 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => { if (line.includes(token)) hits.push({ file: 'js/' + name, line: index + 1 }); });
  }
  return hits;
}

function isDeclared(hits, anchors) {
  return hits.every(hit => anchors.some(a => a.file === hit.file && Math.abs(a.line - hit.line) <= ANCHOR_TOLERANCE));
}

/**
 * Verifies every registry unit against the frozen base config and the real sources:
 * path resolution, alias identity, wiring anchors, namespace binding and truncation sites.
 */
export async function auditRegistry({ units, config, modelConfig, root, verifyAliasIdentity, policy }) {
  const alias = verifyAliasIdentity(modelConfig);
  if (!alias.ok) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'ALIAS_IDENTITY_BROKEN', detail: alias.issues });
  }
  const audited = [];
  for (const unit of units) {
    const resolved = resolvePath(config, unit.canonical_path);
    if (!resolved.exists) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'PARAMETER_PATH_UNRESOLVED', detail: unit.canonical_path });
    }
    const anchors = [];
    for (const anchor of (unit.wiring_evidence && unit.wiring_evidence.read_at) || []) {
      anchors.push(await verifyAnchor(root, anchor));
    }
    // Each declared read site states which cfg binding applies at its own line; a
    // namespace-scoped binding must match the parameter's leading namespace.
    for (const anchor of anchors) {
      const binding = anchor.binding || DEFAULT_ANCHOR_BINDINGS[anchor.file];
      if (!binding) {
        fail('TUNING_VALIDATION_FAILED', { reason_code: 'WIRING_ANCHOR_MISSING_BINDING', detail: { parameter_id: unit.parameter_id, anchor } });
      }
      if (!(binding in KNOWN_BINDINGS)) {
        fail('TUNING_VALIDATION_FAILED', { reason_code: 'UNKNOWN_WIRING_BINDING', detail: { parameter_id: unit.parameter_id, binding } });
      }
      if (!bindingIsNamespaceScoped(binding)) continue;
      const namespace = namespaceOf(unit.canonical_path);
      if (namespace !== binding) {
        fail('TUNING_VALIDATION_FAILED', {
          reason_code: 'WIRING_NAMESPACE_MISMATCH',
          detail: { parameter_id: unit.parameter_id, file: anchor.file, binding, canonical_path: unit.canonical_path }
        });
      }
    }
    const truncations = [];
    for (const anchor of (unit.wiring_evidence && unit.wiring_evidence.truncation_sites) || []) {
      truncations.push(await verifyAnchor(root, anchor));
    }
    const stale = anchors.filter(a => !a.verified);
    if (stale.length) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'WIRING_ANCHOR_STALE', detail: { parameter_id: unit.parameter_id, stale } });
    }
    const staleTruncation = truncations.filter(a => !a.verified);
    if (staleTruncation.length) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'TRUNCATION_ANCHOR_STALE', detail: { parameter_id: unit.parameter_id, stale: staleTruncation } });
    }
    const token = unit.scan_token || unit.canonical_path.split('.').pop();
    const hits = await scanScoringReferences(root, token);
    // Token level scanning can collide with identically named parameters in other
    // namespaces, so the strict undeclared-site rule applies only when a unit declares
    // an explicit scan_token that uniquely identifies its leaf.
    const strictScan = Boolean(unit.scan_token);
    let wiring_class = hits.length ? 'REFERENCED' : 'UNREFERENCED';
    if (strictScan && hits.length) wiring_class = isDeclared(hits, anchors) ? 'DECLARED_SITES_ONLY' : 'UNDECLARED_SITES';
    if (unit.wired_status === 'WIRED') {
      if (wiring_class === 'UNREFERENCED') {
        fail('TUNING_VALIDATION_FAILED', { reason_code: 'WIRED_BUT_UNREFERENCED', detail: unit.parameter_id });
      }
      if (anchors.every(a => a.outside_scoring_path)) {
        fail('TUNING_VALIDATION_FAILED', { reason_code: 'WIRED_ANCHOR_OUTSIDE_SCORING_PATH', detail: unit.parameter_id });
      }
    } else if (unit.wired_status === 'OPERATIONAL_ONLY' || unit.wired_status === 'PARTIALLY_WIRED') {
      if (strictScan && wiring_class === 'UNDECLARED_SITES') {
        fail('TUNING_VALIDATION_FAILED', { reason_code: 'UNDECLARED_WIRING_SITE', detail: { parameter_id: unit.parameter_id, hits } });
      }
      if (unit.wired_status === 'PARTIALLY_WIRED' && !truncations.length) {
        fail('TUNING_VALIDATION_FAILED', { reason_code: 'PARTIALLY_WIRED_WITHOUT_TRUNCATION_EVIDENCE', detail: unit.parameter_id });
      }
    }
    audited.push({
      parameter_id: unit.parameter_id,
      canonical_path: unit.canonical_path,
      wired_status: unit.wired_status,
      wiring_class,
      baseline_value: resolved.value,
      verified_anchors: anchors.map(a => `${a.file}:${a.matched_line}`),
      verified_truncation_sites: truncations.map(a => `${a.file}:${a.matched_line}`),
      reference_sites: hits.length
    });
  }
  return { aliased_namespaces: alias.aliased_namespaces, units: audited };
}
