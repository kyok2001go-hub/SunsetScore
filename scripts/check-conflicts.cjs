const { readdirSync, readFileSync } = require('node:fs');
const { join, relative, extname } = require('node:path');

const root = join(__dirname, '..');
const ignored = new Set(['.git', '.wrangler', 'artifacts', 'dataset', 'node_modules', 'playwright-report', 'test-results']);
const extensions = new Set(['.html', '.css', '.js', '.cjs', '.mjs', '.json', '.jsonc', '.sql', '.yml', '.yaml']);
const marker = /^(?:<<<<<<<|=======|>>>>>>>)(?:[^\r\n]*)$/m;

function hasConflictMarker(source) {
  return marker.test(source);
}

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink() || ignored.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    return entry.isFile() && extensions.has(extname(entry.name)) ? [path] : [];
  });
}

function check() {
  const conflicted = collect(root).filter((path) => hasConflictMarker(readFileSync(path, 'utf8')));
  if (conflicted.length) {
    for (const path of conflicted) console.error('Unresolved merge conflict: ' + relative(root, path));
    process.exitCode = 1;
    return;
  }
  console.log('Merge conflict marker check passed.');
}

if (require.main === module) check();

module.exports = { hasConflictMarker };
