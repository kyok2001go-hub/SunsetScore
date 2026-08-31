const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const ignoredDirectories = new Set(['.git', '.wrangler', 'artifacts', 'node_modules', 'playwright-report', 'test-results']);

function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? collect(path) : (/\.m?js$/.test(path) ? [path] : []);
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
