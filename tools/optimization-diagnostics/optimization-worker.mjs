import { canonicalJson, errorCode } from '../dataset/lib/common.mjs';
import { buildOptimizationPackage } from '../optimization/lib/build.mjs';
import { digest } from './engine.mjs';
try {
  const options = JSON.parse(process.argv[process.argv.indexOf('--options') + 1]);
  const built = await buildOptimizationPackage(options);
  console.log(canonicalJson({ digest: digest(built.files) }));
} catch (error) { console.log(canonicalJson({ error_code: errorCode(error), reason_code: error.reason_code || null })); process.exitCode = 1; }
