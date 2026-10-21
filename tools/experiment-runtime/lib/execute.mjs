import path from 'node:path';
import { canonicalJson, fail, hash, readSafe, within } from '../../dataset/lib/common.mjs';
import { APP_ROOT } from '../../tuning/lib/engine-runtime.mjs';
import { withGovernanceLeases } from './lease.mjs';
import { nodeProcess, verifyBundle } from './bundle.mjs';
import { publishGovernancePackage } from './package.mjs';
import { protectExternalReferences } from './references.mjs';
import { artifactDatasetRoot } from '../../formal/contracts.mjs';
import { recordLegacyValidationAccess } from '../../formal/legacy-access.mjs';

export function sourceManifestIdentity(key, manifest, manifestSha256) {
  const fields = { raw: 'dataset_id', gt: 'ground_truth_id', model: 'model_dataset_id',
    baseline: 'evaluation_id', sensitivity: 'sensitivity_id', optimization: 'optimization_id', campaign: 'campaign_id',
    metric_evidence: 'semantic_evidence_id', rubric: 'rubric_id', pilot: 'pilot_id' };
  if (!fields[key] || typeof manifest[fields[key]] !== 'string' || !manifest[fields[key]]) fail('RUNTIME_SOURCE_IDENTITY_MISSING');
  return { id: manifest[fields[key]], manifest_sha256: manifestSha256 };
}

export async function executeBundleCli(bundle, entry, args, { receiptOutput } = {}) {
  const relative = path.relative(APP_ROOT, entry).split(path.sep).join('/');
  if (!/^tools\/(tuning|optimization|validation|evaluation|metric-semantics|campaign|score-diagnostics)\/[a-z-]+\.mjs$/.test(relative)) fail('RUNTIME_ENTRY_NOT_ALLOWED');
  const root = path.dirname(path.dirname(bundle));
  const sourceRoots = [];
  for (const name of ['raw', 'gt', 'model', 'baseline', 'sensitivity', 'optimization']) {
    const i = args.indexOf(`--${name}`);
    if (i >= 0) sourceRoots.push(name === 'raw' ? path.dirname(path.dirname(args[i + 1])) :
      path.dirname(path.dirname(path.dirname(args[i + 1]))));
  }
  for (const flag of ['--campaign', '--metric-evidence', '--rubric', '--pilot']) {
    const i = args.indexOf(flag); if (i >= 0) sourceRoots.push(artifactDatasetRoot(args[i + 1]));
  }
  const receiptRoot = receiptOutput || path.join(root, 'executions');
  const outputIndex = args.indexOf('--output');
  const namespace = /\/(?:metric-semantics|campaign)\//.test(relative);
  const positional = namespace ? (args[0] === 'validate' ? args[1] : null) : args[0];
  const resultRoot = positional && !positional.startsWith('--') ? artifactDatasetRoot(positional) : null;
  const outputRoot = outputIndex >= 0 ? path.dirname(path.resolve(args[outputIndex + 1])) : null;
  const roots = [...new Set([path.dirname(root), path.dirname(path.dirname(receiptRoot)), ...sourceRoots,
    resultRoot, outputRoot].filter(Boolean).map(value => path.resolve(value)))].sort();
  async function operation() {
    const checked = await verifyBundle(bundle, { requireEnvironment: true });
    const source = checked.source;
    const readOnlyValidation = relative === 'tools/validation/validate-validation.mjs' && !args.includes('--raw');
    if (relative === 'tools/validation/validate-validation.mjs' && args.includes('--raw') &&
        !(await readSafe(path.join(source, relative))).toString('utf8').includes('VERIFY_RECOMPUTE_STARTED')) {
      fail('HISTORICAL_VERIFICATION_AUDIT_PROTOCOL_UNSUPPORTED');
    }
    // New runs must use the publication gate. Historical validation remains readable.
    if (relative === 'tools/validation/run-validation.mjs' &&
        !(await readSafe(path.join(source, relative))).toString('utf8').includes('PREPUBLISH_RECOMPUTE')) {
      fail('HISTORICAL_PUBLICATION_PROTOCOL_UNSUPPORTED');
    }
    const sources = {}, identities = {};
    for (const name of ['raw', 'gt', 'model', 'baseline', 'sensitivity', 'optimization']) {
      const i = args.indexOf(`--${name}`);
      if (i >= 0) {
        sources[name] = path.resolve(args[i + 1]);
        const bytes = await readSafe(path.join(sources[name], 'manifest.json'));
        const manifest = JSON.parse(bytes);
        identities[name] = sourceManifestIdentity(name, manifest, hash(bytes));
      }
    }
    for (const [flag, key] of [['--campaign', 'campaign'], ['--metric-evidence', 'metric_evidence'], ['--rubric', 'rubric'], ['--pilot', 'pilot']]) {
      const i = args.indexOf(flag); if (i >= 0) {
        const bytes = await readSafe(path.join(args[i + 1], 'manifest.json'));
        identities[key] = sourceManifestIdentity(key, JSON.parse(bytes), hash(bytes));
      }
    }
    for (const flag of ['--output', '--report-dir', '--access-ledger']) {
      const i = args.indexOf(flag);
      if (i >= 0 && within(bundle, args[i + 1])) fail('RUNTIME_BUNDLE_WRITE_FORBIDDEN');
    }
    const legacyVal = relative === 'tools/evaluation/evaluate-baseline.mjs' &&
      (!args.includes('--evaluation-version') || args[args.indexOf('--evaluation-version') + 1] === '1') ||
      relative === 'tools/tuning/evaluate-candidate.mjs' && args[args.indexOf('--split') + 1] === 'VALIDATION';
    if (legacyVal && !(await readSafe(path.join(source, relative))).toString('utf8').includes('export const LEGACY_VALIDATION_ACCESS_AUDIT_REVISION = 1;')) {
      const flagValue = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
      await recordLegacyValidationAccess({ model: sources.model, output: flagValue('--output'), accessLedger: flagValue('--access-ledger'), stage: 'ARCHIVED_LEGACY_VALIDATION' });
    }
    const stdout = await nodeProcess(path.join(source, relative), args, { cwd: source, bundleSha256: checked.runtime_bundle_sha256 });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    await verifyBundle(bundle, { requireEnvironment: true });
    if (readOnlyValidation) return { ...result, runtime_bundle_id: checked.runtime_bundle_id };
    const resultId = result.score_diagnostic_id || result.score_diagnostic_plan_id || result.validation_id || result.optimization_id || result.optimization_plan_id || result.sensitivity_id || result.evaluation_id || result.plan_id ||
      result.campaign_id || result.semantic_evidence_id || result.review_plan_id || result.pilot_id || result.rubric_id || result.evidence_id || null;
    const links = { runtime_bundle_id: checked.runtime_bundle_id,
      runtime_bundle_manifest_sha256: checked.manifest_sha256, source_ids: identities };
    const resultDirectory = result.directory || result.plan_dir || (resultId && positional && !positional.startsWith('--') ? positional : null);
    if (resultId && resultDirectory) {
      links.result_id = resultId;
      const name = resultId.startsWith('validation_plan_') ? 'plan_manifest.json' : 'manifest.json';
      links.result_manifest_sha256 = hash(await readSafe(path.join(resultDirectory, name)));
    }
    const receipt = { execution_receipt_schema_version: 1, entry: relative,
      ...links, runtime_bundle_sha256: checked.runtime_bundle_sha256,
      environment: checked.descriptor.environment, status: result.status,
      result_usage: result.result_usage || 'DEVELOPMENT_ONLY',
      result_id: resultId,
      // No caller paths/timestamps enter an immutable execution receipt.
      validation_scope: result.validation_scope || null };
    await protectExternalReferences([...sourceRoots, path.dirname(root), ...[resultRoot, outputRoot].filter(Boolean)], receiptRoot);
    const published = await publishGovernancePackage({
      output: receiptRoot, kind: 'runtime_execution',
      idField: 'execution_receipt_id', payloads: { 'execution.json': receipt }, links,
      sourceCheck: () => verifyBundle(bundle, { requireEnvironment: true })
    });
    return { ...result, runtime_bundle_id: checked.runtime_bundle_id,
      execution_receipt_id: published.execution_receipt_id, execution_receipt_directory: published.directory };
  }
  return withGovernanceLeases('runtime_execution', roots, operation);
}
export function bundleArgs(args, command, family) {
  const index = args.indexOf('--runtime-bundle');
  const forwarded = args.slice(); forwarded.splice(index, 2);
  const reportIndex = forwarded.indexOf('--report-dir');
  if (reportIndex >= 0) forwarded.splice(reportIndex, 2);
  const pathFlags = new Set(['--model', '--raw', '--gt', '--baseline', '--sensitivity', '--optimization', '--output',
    '--plan', '--access-ledger', '--disclosure-evidence', '--validation-evidence', '--candidates',
    '--campaign', '--metric-evidence', '--rubric', '--pilot', '--index', '--annotations', '--conclusion',
    '--specification', '--build-runtimes', '--history-ledgers', '--declaration', '--diagnostic-plan', '--diagnostic-result', '--optimization-plan', '--sources']);
  for (let i = 0; i < forwarded.length; i++) if (pathFlags.has(forwarded[i])) forwarded[++i] = path.resolve(forwarded[i]);
  if (['validate', 'recover'].includes(command)) forwarded[family === 'campaign' || family === 'metric-semantics' ? 1 : 0] =
    path.resolve(forwarded[family === 'campaign' || family === 'metric-semantics' ? 1 : 0]);
  const writing = family === 'validation' ? ['plan', 'run'].includes(command) :
    family === 'optimization' ? ['run', 'plan'].includes(command) : family === 'evaluation' ? command === 'baseline' :
      family === 'metric-semantics' ? command !== 'validate' : family === 'campaign' ? ['freeze', 'disclosure'].includes(command) : ['sensitivity', 'plan', 'readiness'].includes(command);
  if (writing && !forwarded.includes('--output')) {
    forwarded.push('--output', path.join(APP_ROOT, 'dataset', family === 'metric-semantics' ? 'metric_semantics' : family === 'campaign' && command === 'disclosure' ? 'validation' : family));
  }
  const legacyVal = family === 'evaluation' && command === 'baseline' && (!forwarded.includes('--evaluation-version') ||
    forwarded[forwarded.indexOf('--evaluation-version') + 1] === '1') || family === 'tuning' && command === 'candidate' &&
    forwarded[forwarded.indexOf('--split') + 1] === 'VALIDATION';
  const needsLedger = (['campaign', 'metric-semantics'].includes(family) && command !== 'validate') || forwarded.includes('--campaign') || legacyVal;
  if (needsLedger && !forwarded.includes('--access-ledger')) forwarded.push('--access-ledger', path.join(APP_ROOT, 'dataset/validation/access-ledger'));
  return forwarded;
}
