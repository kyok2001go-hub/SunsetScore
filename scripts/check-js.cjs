const { readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

function collect(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? collect(path) : (/\.m?js$/.test(path) ? [path] : []);
  });
}

let failed = false;
for (const file of collect(join(__dirname, '..'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout);
  }
}
if (failed) process.exit(1);
console.log('JavaScript syntax check passed.');
