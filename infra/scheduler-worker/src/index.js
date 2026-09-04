/**
 * SunsetScore Scheduler Worker (V2.4.2)
 *
 * Cloudflare Worker triggered by Cron Triggers to dispatch GitHub Actions pre-sunset-metadata workflow.
 * Produces strict HHMM SLOT calculated from scheduledTime in Asia/Shanghai.
 */

export const GITHUB_DISPATCH_URL = 'https://api.github.com/repos/kyok2001go-hub/SunsetScore/actions/workflows/pre-sunset-metadata.yml/dispatches';

/**
 * Redacts any potential token or sensitive credential from a message string.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeLog(text) {
  if (!text) return '';
  return String(text)
    .replace(/github_pat_[A-Za-z0-9_]{16,255}/g, '[REDACTED_TOKEN]')
    .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,255}/g, '[REDACTED_TOKEN]')
    .replace(/bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/token\s*[:=]\s*['"]?[^'"\s,;]+/gi, 'token:[REDACTED_TOKEN]');
}

/**
 * Formats a scheduled timestamp into a 4-digit HHMM slot in Asia/Shanghai.
 * @param {number|Date|string} scheduledTime
 * @param {string} [timeZone='Asia/Shanghai']
 * @returns {string} 4-digit slot (e.g. '1213', '1613')
 */
export function formatSlotFromScheduledTime(scheduledTime, timeZone = 'Asia/Shanghai') {
  const date = typeof scheduledTime === 'number'
    ? new Date(scheduledTime)
    : (scheduledTime instanceof Date ? new Date(scheduledTime.getTime()) : new Date(scheduledTime));

  if (!Number.isFinite(date.getTime())) {
    throw new Error('Invalid scheduledTime timestamp');
  }

  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
  } catch (err) {
    throw new Error('Unsupported timeZone: ' + timeZone);
  }

  const hour = parts.find((p) => p.type === 'hour')?.value;
  const minute = parts.find((p) => p.type === 'minute')?.value;
  if (!hour || !minute) {
    throw new Error('Failed to resolve time parts in timeZone ' + timeZone);
  }

  const slot = hour.padStart(2, '0') + minute.padStart(2, '0');
  if (!/^(?:[01]\d|2[0-3])[0-5]\d$/.test(slot)) {
    throw new Error('Resolved slot out of bounds: ' + slot);
  }
  return slot;
}

/**
 * Builds the dispatch request payload for GitHub Actions workflow_dispatch.
 * @param {string} slot 4-digit HHMM
 * @returns {object}
 */
export function buildDispatchPayload(slot) {
  if (!slot || !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(String(slot).trim())) {
    throw new Error('Invalid slot format: must be 4-digit HHMM between 0000 and 2359');
  }
  return {
    ref: 'main',
    inputs: {
      submit: true,
      cities: '',
      run_type: 'scheduled',
      slot: String(slot).trim()
    }
  };
}

/**
 * Triggers GitHub workflow_dispatch with scheduled inputs.
 * @param {string} slot 4-digit HHMM
 * @param {string} token GitHub fine-grained PAT or token
 * @param {typeof fetch} [fetchImpl=fetch]
 * @returns {Promise<{success: boolean, slot: string, status: number}>}
 */
export async function triggerWorkflowDispatch(slot, token, fetchImpl = fetch) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    throw new Error('GITHUB_TOKEN is missing or empty. Please set it in Worker Secrets.');
  }

  const payload = buildDispatchPayload(slot);
  let response;
  try {
    response = await fetchImpl(GITHUB_DISPATCH_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${normalizedToken}`,
        'User-Agent': 'sunsetscore-scheduler',
        'X-GitHub-Api-Version': '2026-03-10',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (netErr) {
    const safeErr = sanitizeLog(netErr?.message || 'Network error');
    throw new Error(`GitHub dispatch network failure: ${safeErr}`);
  }

  if (!response.ok) {
    const statusText = sanitizeLog(response.statusText || 'Request rejected');
    throw new Error(`GitHub workflow_dispatch failed with HTTP ${response.status}: ${statusText}`);
  }

  return { success: true, slot, status: response.status };
}

export default {
  async scheduled(controller, env) {
    if (!controller || !Number.isFinite(controller.scheduledTime)) {
      throw new Error('Scheduled controller is missing a valid scheduledTime');
    }
    const scheduledTime = controller.scheduledTime;
    const slot = formatSlotFromScheduledTime(scheduledTime, 'Asia/Shanghai');
    console.log({ event: 'scheduler_dispatch_started', slot, cron: controller.cron || null });

    const token = env && env.GITHUB_TOKEN;
    const result = await triggerWorkflowDispatch(slot, token);
    console.log({ event: 'scheduler_dispatch_succeeded', slot, status: result.status });
  }
};
