import { canonicalJson, errorCode } from '../dataset/lib/common.mjs';
import { calculateFrozenDiagnostics } from './package.mjs';
import { digest } from './engine.mjs';
try {
  const args = process.argv.slice(2), options = Object.fromEntries(['plan', 'sources'].map(key => [key, args[args.indexOf(`--${key}`) + 1]]));
  const result = await calculateFrozenDiagnostics(options);
  console.log(canonicalJson({ payload_sha256: digest(result.payloads) }));
} catch (error) { console.log(canonicalJson({ error_code: errorCode(error), reason_code: error.reason_code || null })); process.exitCode = 1; }
