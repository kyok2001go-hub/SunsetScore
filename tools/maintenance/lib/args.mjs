import path from 'node:path';
import { fail } from '../../dataset/lib/common.mjs';
import { resolveDefaultDatasetRoot } from '../maintenance-policy.mjs';

const FORMATS = ['text', 'mermaid', 'json'];

function reader(argv, allowed) {
  const result = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag.startsWith('--')) fail('INVALID_ARGUMENTS', { detail: flag });
    const key = flag.slice(2);
    if (!allowed.includes(key) || seen.has(key)) fail('INVALID_ARGUMENTS', { detail: flag });
    seen.add(key);
    if (key === 'quiet' || key === 'verify' || key === 'group' || key === 'dry-run') {
      result[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS', { detail: flag });
    index += 1;
    result[key] = value;
  }
  return result;
}

export function parseLineageArgs(argv) {
  const raw = reader(argv, ['dataset', 'focus', 'format', 'out', 'verify', 'group', 'quiet']);
  const format = raw.format ?? 'text';
  if (!FORMATS.includes(format)) fail('INVALID_ARGUMENTS', { reason_code: 'UNKNOWN_FORMAT', detail: format });
  return {
    datasetRoot: path.resolve(raw.dataset ?? resolveDefaultDatasetRoot()),
    focus: raw.focus ?? null,
    format,
    out: raw.out ? path.resolve(raw.out) : null,
    verify: raw.verify === true,
    group: raw.group === true,
    quiet: raw.quiet === true
  };
}

/**
 * Prune accepts the package id on its own: `dataset:prune -- <id>`. The phase is looked up from
 * the manifest, so the only thing an operator has to remember is the id itself. `--dry-run`
 * previews, `--plan` / `--apply` / `--resume` stay available for explicit two step control.
 */
export function parsePruneArgs(argv) {
  const positional = [];
  const flags = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    flags.push(token);
    if (!['--dry-run', '--quiet'].includes(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS', { detail: token });
      flags.push(value);
      index += 1;
    }
  }
  const raw = reader(flags, ['dataset', 'plan', 'apply', 'resume', 'phase', 'id', 'dry-run', 'quiet']);
  const modes = ['plan', 'apply', 'resume'].filter(key => raw[key] !== undefined);
  if (modes.length > 1) fail('INVALID_ARGUMENTS', { reason_code: 'ONLY_ONE_MODE_ALLOWED' });
  if (raw.plan !== undefined && raw['dry-run'] !== undefined) fail('INVALID_ARGUMENTS', { reason_code: 'DRY_RUN_WITH_PLAN' });
  const mode = modes[0] || 'auto';
  const datasetRoot = path.resolve(raw.dataset ?? resolveDefaultDatasetRoot());
  const ids = positional.concat(raw.id === undefined ? [] : [raw.id]);
  if (ids.length > 1) fail('INVALID_ARGUMENTS', { reason_code: 'ONE_ID_AT_A_TIME' });
  const phase = raw.phase === undefined ? null : Number(raw.phase);
  if (phase !== null && (!Number.isInteger(phase) || phase < 1 || phase > 6)) {
    fail('INVALID_ARGUMENTS', { reason_code: 'PHASE_OUT_OF_RANGE' });
  }
  if (mode === 'plan') {
    if (ids.length !== 1) fail('INVALID_ARGUMENTS', { reason_code: 'ID_REQUIRED' });
    if (!/^[A-Za-z0-9_-]{1,180}$/.test(ids[0])) fail('INVALID_ARGUMENTS', { reason_code: 'INVALID_ID' });
    return { mode, datasetRoot, phase, id: ids[0], planPath: path.resolve(raw.plan), quiet: raw.quiet === true };
  }
  if (mode === 'auto') {
    if (ids.length !== 1) fail('INVALID_ARGUMENTS', { reason_code: 'ID_REQUIRED' });
    if (!/^[A-Za-z0-9_-]{1,180}$/.test(ids[0])) fail('INVALID_ARGUMENTS', { reason_code: 'INVALID_ID' });
    return {
      mode, datasetRoot, phase, id: ids[0], dryRun: raw['dry-run'] === true, planPath: null,
      resume: false, quiet: raw.quiet === true
    };
  }
  return {
    mode, datasetRoot, phase, dryRun: false,
    planPath: path.resolve(raw[mode]),
    resume: mode === 'resume',
    quiet: raw.quiet === true
  };
}
