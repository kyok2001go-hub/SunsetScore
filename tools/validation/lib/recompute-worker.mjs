import { canonicalJson, errorCode, hash } from '../../dataset/lib/common.mjs';
import { recomputeValidation } from './recompute.mjs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const result = await recomputeValidation(JSON.parse(Buffer.concat(chunks)));
  console.log(canonicalJson({ manifest: result.manifest, recomputed_file_inventory: Object.fromEntries(
    Object.entries(result.files).map(([name, value]) => [name, { sha256: hash(value), bytes: Buffer.byteLength(value) }])) }));
}
catch (error) { console.log(canonicalJson({ error_code: errorCode(error), reason_code: error.reason_code || null })); process.exitCode = 1; }
