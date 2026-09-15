// Terminal feedback is never part of package contents or stdout.
export function createProgress({ quiet = false, stream = process.stderr, interval = 1000, heartbeat = 10000 } = {}) {
  const started = Date.now();
  let stage = '准备', detail = '', last = 0, timer, closed = false;
  const emit = () => {
    if (quiet || closed) return;
    try { stream.write('[' + Math.floor((Date.now() - started) / 1000) + 's] ' + stage + (detail ? ' · ' + detail : '') + '\n'); } catch { /* feedback must not affect the operation */ }
    last = Date.now();
  };
  if (!quiet) { timer = setInterval(() => { if (Date.now() - last >= heartbeat) emit(); }, heartbeat); timer.unref(); }
  return {
    stage(value) { stage = value; detail = ''; emit(); },
    update(value, force = false) { detail = value; if (stream.isTTY && (force || Date.now() - last >= interval)) emit(); },
    finish(value) { if (closed) return; stage = value; detail = ''; emit(); closed = true; clearInterval(timer); },
    fail(code) { this.finish('失败（' + stage + '）：' + code); }
  };
}
export const silentProgress = { stage() {}, update() {}, finish() {}, fail() {} };
