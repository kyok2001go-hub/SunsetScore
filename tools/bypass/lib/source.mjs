// V2.5.5.9 read-only remote source: D1 queries and R2 object reads through the user's authenticated Wrangler session.
// Credentials are never accepted as arguments; remote output is classified, never echoed.
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { d1Rows, npxInvocation } from '../../dataset/lib/wrangler.mjs';
import { fail } from '../../dataset/lib/common.mjs';

const TRANSIENT = /ETIMEDOUT|ECONNRESET|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|\b503\b|\b504\b/;
// Wrangler reports an absent key as "The specified key does not exist" (R2 code 10007 / HTTP 404).
const NOT_FOUND = /specified key does not exist|NoSuchKey|\b10007\b|\b404\b/i;

export function classifyR2Failure(diagnostic) {
  if (NOT_FOUND.test(diagnostic)) return 'MISSING';
  if (TRANSIENT.test(diagnostic)) return 'TRANSIENT';
  return 'FAILED';
}

function run(invocation, timeoutMs) {
  return new Promise(resolve => {
    execFile(invocation.command, invocation.args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, diagnostic: `${error?.code || ''} ${stderr || ''} ${stdout || ''}` }));
  });
}

export function createBypassSource(options, tempDir, dependencies = {}) {
  const runner = dependencies.run || run, delay = dependencies.delay || (ms => new Promise(r => setTimeout(r, ms)));
  return {
    query: sql => d1Rows(options.database, sql, options.config, { tempDir }),
    /** → { status: 'FOUND', bytes } | { status: 'MISSING' }; other failures throw DOWNLOAD_FAILED after 3 transient retries. */
    async getObject(key) {
      for (let attempt = 0; ; attempt++) {
        const file = path.join(tempDir, `r2-${randomUUID()}.gz`);
        try {
          const invocation = npxInvocation(['wrangler', ...(options.config ? ['--config', options.config] : []),
            'r2', 'object', 'get', `${options.bucket}/${key}`, '--remote', '--file', file]);
          const result = await runner(invocation, 120_000);
          if (!result.error) return { status: 'FOUND', bytes: await readFile(file) };
          const kind = classifyR2Failure(result.diagnostic);
          if (kind === 'MISSING') return { status: 'MISSING' };
          if (kind !== 'TRANSIENT' || attempt >= 3) fail('DOWNLOAD_FAILED');
        } finally { await rm(file, { force: true }); }
        await delay(1000 * (attempt + 1));
      }
    }
  };
}
