import { canonicalJson, errorCode } from '../dataset/lib/common.mjs';
import { inspectGovernancePackage } from '../experiment-runtime/lib/package.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
try {
  const [raw, directory, root] = process.argv.slice(2);
  const { files } = await inspectGovernancePackage(directory);
  const { computeQuality, QUALITY_COMPUTATION_CONTRACT_REVISION } = await import(pathToFileURL(path.join(root, 'tools/replay-quality/quality.mjs')).href);
  if (QUALITY_COMPUTATION_CONTRACT_REVISION !== 1) throw new Error('QUALITY_RUNTIME_TOOL_PROTOCOL_UNSUPPORTED');
  console.log(canonicalJson(await computeQuality({ raw, plan: files['quality_plan.json'], root })));
} catch (error) { console.log(canonicalJson({ error_code: errorCode(error) })); process.exitCode = 1; }
