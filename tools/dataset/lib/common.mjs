import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, readdir, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export { canonicalJson } from '../../../server/replay-schema.js';
import { canonicalJson } from '../../../server/replay-schema.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const compare = (a, b) => {
  const x = Array.from(String(a)), y = Array.from(String(b));
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return Math.sign(d);
  }
  return x.length - y.length;
};
export const unique = values => [...new Set(values)].sort(compare);
export const rowOrder = (a, b) => a.submitted_at_epoch - b.submitted_at_epoch || compare(a.id, b.id);
export const fail = (code, entity = {}) => { throw Object.assign(new Error(code), { code, ...entity }); };
export const errorCode = error => /^[A-Z][A-Z0-9_]+$/.test(error?.code || error?.message || '')
  ? (error.code || error.message) : 'DATASET_OPERATION_FAILED';
export const isMain = url => process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url);
export function safeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(id)) fail('INVALID_ENTITY_ID');
  return id;
}
export function within(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}
// Reject symlinks/junctions in every existing ancestor, including output roots.
export async function safePath(file) {
  const resolved = path.resolve(file), parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) fail('UNSAFE_PATH'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return resolved;
}
export async function readSafe(file) {
  await safePath(file);
  const info = await lstat(file);
  if (!info.isFile() || info.nlink > 1) fail('UNSAFE_PATH');
  return readFile(file);
}
export const readJson = async file => JSON.parse((await readSafe(file)).toString('utf8'));
export const writeJson = (file, value) => writeFile(file, canonicalJson(value), { encoding: 'utf8', flag: 'wx' });
export async function inventory(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    await safePath(path.join(root, name));
    if (entry.isDirectory()) result.push(...await inventory(root, name));
    else if (entry.isFile()) result.push(name);
    else fail('UNSAFE_PATH');
  }
  return result.sort(compare);
}
export async function reportOutside(dataset, directory, name, report) {
  const root = await realpath(dataset);
  const destination = await safePath(directory);
  if (within(root, destination)) fail('REPORT_DIRECTORY_INSIDE_DATASET');
  await mkdir(destination, { recursive: true });
  if (within(root, await realpath(destination))) fail('REPORT_DIRECTORY_INSIDE_DATASET');
  await writeJson(path.join(destination, name), report);
}
export function parseReadArgs(args) {
  if (!args[0] || args[0].startsWith('--') || ![1, 3].includes(args.length) ||
      (args.length === 3 && (args[1] !== '--report-dir' || !args[2]))) fail('INVALID_ARGUMENTS');
  return { dataset: path.resolve(args[0]), reportDir: args[2] };
}
export async function removeOwned(root, target) {
  const absolute = await safePath(target);
  if (!within(root, absolute) || path.resolve(root) === absolute) fail('UNSAFE_PATH');
  await rm(absolute, { recursive: true, force: true });
}
export const runId = () => randomUUID();
export async function withLock(lock, operation, attempts = 100) {
  await safePath(lock);
  let acquired = false;
  for (let i = 0; i < attempts; i++) {
    try { await mkdir(lock); acquired = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await safePath(lock);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!acquired) fail('DATASET_LOCK_BUSY');
  try { return await operation(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
