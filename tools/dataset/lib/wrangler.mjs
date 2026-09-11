import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fail } from './common.mjs';

export function npxInvocation(fullArgs, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return { command: 'npx', args: fullArgs };
  const pathApi = path.win32;
  const nodeExecutable = options.nodeExecutable || process.execPath;
  const npmExecPath = options.npmExecPath === undefined ? process.env.npm_execpath : options.npmExecPath;
  const exists = options.exists || existsSync;
  const candidates = [
    npmExecPath && pathApi.join(pathApi.dirname(npmExecPath), 'npx-cli.js'),
    pathApi.join(pathApi.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npx-cli.js')
  ].filter(Boolean);
  const npxCli = candidates.find((candidate) => exists(candidate));
  if (!npxCli) throw new Error('NPX_LAUNCHER_NOT_FOUND');
  return { command: nodeExecutable, args: [npxCli, ...fullArgs] };
}

// Collapse layout whitespace only outside SQL literals; preserve city names verbatim.
export function compactSql(sql) {
  return (String(sql).match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[^'"\s]+|\s+/g) || [])
    .map(token => /^\s+$/.test(token) ? ' ' : token).join('').trim();
}

export function wrangler(args, config, options = {}) {
  const invocation = npxInvocation(['wrangler', ...(config ? ['--config', config] : []), ...args]);
  const result = (options.spawn || spawnSync)(invocation.command, invocation.args, {
    encoding: 'utf8', windowsHide: true, timeout: options.timeoutMs ?? 120_000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024
  });
  if (result.status !== 0 || result.error) {
    // Classify without exposing remote output, which can contain account metadata.
    const diagnostic = `${result.error?.code || ''} ${result.stderr || ''} ${result.stdout || ''}`;
    if (/ETIMEDOUT|ECONNRESET|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|\b503\b|\b504\b/.test(diagnostic)) fail('NETWORK_TRANSIENT');
    fail('WRANGLER_FAILED');
  }
  return result.stdout;
}

export function parseD1Output(output) {
  let parsed;
  try { parsed = JSON.parse(output); } catch { fail('D1_RESPONSE_INVALID'); }
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  if (!blocks.length) fail('D1_RESPONSE_INVALID');
  const rows = [];
  for (const block of blocks) {
    if (!block || block.success === false || block.error || block.errors?.length) fail('D1_QUERY_FAILED');
    if (Array.isArray(block.results)) rows.push(...block.results);
    else if (Array.isArray(block.result) && block.result.length) {
      for (const child of block.result) {
        if (!child || child.success === false || !Array.isArray(child.results)) fail('D1_RESPONSE_INVALID');
        rows.push(...child.results);
      }
    } else fail('D1_RESPONSE_INVALID');
  }
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail('D1_RESPONSE_INVALID');
  return rows;
}

export async function d1Rows(database, sql, config, options = {}) {
  const compact = compactSql(sql);
  if (Buffer.byteLength(compact) > 80_000) fail('SQL_BUDGET_EXCEEDED');
  const execute = options.execute || wrangler;
  let temp;
  try {
    // Long command lines exceed Windows CreateProcess limits. Use a unique SQL file.
    let input = ['--command', compact];
    if (compact.length > 5000) {
      if (!options.tempDir) fail('SQL_TEMP_DIRECTORY_REQUIRED');
      temp = path.join(options.tempDir, `query-${randomUUID()}.sql`);
      await writeFile(temp, compact, { flag: 'wx' });
      input = ['--file', temp];
    }
    return parseD1Output(await execute(['d1', 'execute', database, '--remote', '--json', ...input], config, options));
  } finally { if (temp) await rm(temp, { force: true }); }
}

export function createRemoteSource(options, tempDir) {
  const started = Date.now();
  const deadline = () => {
    if (Date.now() - started > 60 * 60 * 1000) fail('EXPORT_TIMEOUT');
  };
  return {
    async query(sql) {
      deadline();
      return d1Rows(options.database, sql, options.config, { tempDir });
    },
    async download(row) {
      deadline();
      const file = path.join(tempDir, `r2-${randomUUID()}.gz`);
      try {
        wrangler(['r2', 'object', 'get', `${options.bucket}/${row.replay_object_key}`, '--remote', '--file', file], options.config);
        return await readFile(file);
      } finally { await rm(file, { force: true }); }
    }
  };
}
