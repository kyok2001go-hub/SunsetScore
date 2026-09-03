/* SunsetScore V2.4.0 - human/agent observation service */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  function source() {
    return SS.runtime && SS.runtime.observationSource === 'rednote_agent' ? 'rednote_agent' : 'user';
  }

  function submissionId() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12);
  }

  async function buildPayload(result, feedback) {
    var input = feedback || {};
    if (['great', 'good', 'fair', 'poor'].indexOf(input.rating) < 0) throw new Error('请选择实际晚霞等级');
    var eventContext = await SS.eventService.context(result);
    var sid = String(input.submissionId || '').trim();
    if (!sid) throw new Error('缺少反馈提交标识');
    var nowMs = Number.isFinite(input.nowUtcMs) ? input.nowUtcMs : Date.now();
    var payload = {
      observation: {
        submission_id: sid,
        event_context: eventContext,
        rating: input.rating,
        comment: input.comment ? String(input.comment).trim().slice(0, 200) : null,
        source: input.source === 'rednote_agent' ? 'rednote_agent' : source(),
        confidence: Number.isFinite(input.confidence) ? input.confidence : null,
        evidence_count: Number.isInteger(input.evidenceCount) ? input.evidenceCount : null
      },
      snapshot: null
    };
    if (SS.eventService.isSnapshotWindow(eventContext, nowMs)) {
      payload.snapshot = await SS.snapshotService.buildPayload(result, {
        source: 'user_feedback',
        submissionId: sid,
        nowUtcMs: nowMs
      });
    }
    return payload;
  }

  async function submit(result, feedback) {
    var payload = await buildPayload(result, feedback);
    var markerKey = 'ss_observation_backup_' + payload.observation.submission_id;
    var localId = null;
    try { localId = root.localStorage.getItem(markerKey); } catch (error) { /* storage is optional */ }
    var localRecord = localId ? { id: localId } : SS.baseline.saveFeedback({
        dataset: 'event_observation_v1',
        submission_id: payload.observation.submission_id,
        observation: payload.observation,
        snapshot: payload.snapshot
      });
    if (!localId && localRecord) {
      localId = localRecord.id;
      try { root.localStorage.setItem(markerKey, localId); } catch (error) { /* record itself remains backed up */ }
    }
    localId = localId || payload.observation.submission_id;
    try {
      var reply = await SS.network.request('/api/observation', {
        timeoutMs: SS.modelConfig.network.feedbackTimeoutMs,
        allowHttpError: true,
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      });
      var data = reply.data || {};
      if (!reply.response.ok || data.success !== true) {
        return { local: !!localRecord, remote: false, id: localId, cooldown: !!data.cooldown,
          error: data.error || ('HTTP ' + reply.response.status) };
      }
      return { local: !!localRecord, remote: true, id: data.id || localId,
        snapshotId: data.snapshotId || null, snapshotSaved: !!data.snapshotSaved,
        deduplicated: !!data.deduplicated };
    } catch (error) {
      return { local: !!localRecord, remote: false, id: localId,
        error: error && error.name === 'TimeoutError'
          ? '提交超时，服务器是否保存尚未确认；请直接重试（将复用同一提交标识）'
          : '无法连接反馈服务，请稍后重试' };
    }
  }

  SS.observationService = {
    source: source,
    createSubmissionId: submissionId,
    buildPayload: buildPayload,
    submit: submit
  };
})(typeof window !== 'undefined' ? window : globalThis);
