import {
  ADMIN_AUDIT_FIELDS,
  OBSERVATION_FIELDS,
  RATING_LABELS,
  ValidationError,
  buildObservationRow,
  insertStatement,
  isUniqueError,
  sha256
} from './event-dataset.js';

export const MAX_BACKFILL_ITEMS = 20;

const PREVIEW_FIELDS = new Set([
  'client_item_id', 'city', 'event_date_local', 'rating', 'confidence',
  'evidence_count', 'comment'
]);
const COMMIT_FIELDS = new Set([
  'client_item_id', 'event_id', 'rating', 'confidence', 'evidence_count', 'comment'
]);
const EVENT_CONTEXT_FIELDS = Object.freeze([
  'event_id', 'event_date_local', 'location_key', 'city', 'country', 'admin1',
  'latitude', 'longitude', 'location_source', 'location_id', 'timezone',
  'sunset_time_utc', 'sunset_time_local'
]);

export class BackfillConflictError extends Error {
  constructor(message, items = []) {
    super(message);
    this.name = 'BackfillConflictError';
    this.items = items;
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(label + ' 必须是对象');
  }
  return value;
}

function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ValidationError(label + ' 包含未知字段：' + key);
  }
}

function requiredText(value, label, max) {
  if (typeof value !== 'string') throw new ValidationError(label + ' 必须是字符串');
  const result = value.normalize('NFKC').trim();
  if (!result) throw new ValidationError(label + ' 不能为空');
  if (result.length > max) throw new ValidationError(label + ' 过长');
  return result;
}

function optionalText(value, label, max) {
  if (value == null || value === '') return null;
  return requiredText(value, label, max);
}

function optionalNumber(value, label, min, max, integer = false) {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(label + ' 非法');
  }
  if (integer && !Number.isInteger(value)) throw new ValidationError(label + ' 必须是整数');
  return value;
}

function rating(value) {
  const result = requiredText(value, 'rating', 10);
  if (!RATING_LABELS[result]) throw new ValidationError('rating 非法');
  return result;
}

function eventDate(value) {
  const result = requiredText(value, 'event_date_local', 10);
  const parsed = new Date(result + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new ValidationError('event_date_local 非法');
  }
  return result;
}

function itemId(value) {
  const result = requiredText(value, 'client_item_id', 80);
  if (!/^[A-Za-z0-9_.:-]+$/.test(result)) throw new ValidationError('client_item_id 非法');
  return result;
}

function eventId(value) {
  const result = requiredText(value, 'event_id', 80);
  if (!/^evt_v1_[a-f0-9]{20}_\d{4}-\d{2}-\d{2}$/.test(result)) throw new ValidationError('event_id 非法');
  return result;
}

function normalizedObservationInput(item) {
  return {
    rating: rating(item.rating),
    confidence: optionalNumber(item.confidence, 'confidence', 0, 1),
    evidence_count: optionalNumber(item.evidence_count, 'evidence_count', 0, 10000, true),
    comment: optionalText(item.comment, 'comment', 200)
  };
}

function validateItems(value, mode) {
  if (!Array.isArray(value) || !value.length) throw new ValidationError('items 必须是非空数组');
  if (value.length > MAX_BACKFILL_ITEMS) throw new ValidationError('items 最多允许 ' + MAX_BACKFILL_ITEMS + ' 条');
  const seenItemIds = new Set();
  const seenEvents = new Set();
  const fields = mode === 'preview' ? PREVIEW_FIELDS : COMMIT_FIELDS;
  return value.map((entry, index) => {
    try {
      const item = object(entry, 'items[' + index + ']');
      rejectUnknown(item, fields, 'items[' + index + ']');
      const clientItemId = itemId(item.client_item_id);
      if (seenItemIds.has(clientItemId)) throw new ValidationError('client_item_id 在批次内重复');
      seenItemIds.add(clientItemId);
      const common = { client_item_id: clientItemId, ...normalizedObservationInput(item) };
      if (mode === 'preview') {
        return { ...common, city: requiredText(item.city, 'city', 100), event_date_local: eventDate(item.event_date_local) };
      }
      const normalizedEventId = eventId(item.event_id);
      if (seenEvents.has(normalizedEventId)) throw new ValidationError('event_id 在批次内重复');
      seenEvents.add(normalizedEventId);
      return { ...common, event_id: normalizedEventId };
    } catch (error) {
      if (mode !== 'preview' || !(error instanceof ValidationError)) throw error;
      const suppliedId = entry && typeof entry === 'object' && !Array.isArray(entry)
        ? entry.client_item_id
        : null;
      const fallbackId = typeof suppliedId === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(suppliedId.trim())
        ? suppliedId.trim()
        : 'row-' + (index + 1);
      return {
        client_item_id: fallbackId,
        validation_error: error.message
      };
    }
  });
}

export function validateBackfillEnvelope(input) {
  const body = object(input, '请求体');
  const mode = requiredText(body.mode, 'mode', 10);
  const allowed = mode === 'preview'
    ? new Set(['mode', 'items'])
    : mode === 'commit'
      ? new Set(['mode', 'request_id', 'items'])
      : null;
  if (!allowed) throw new ValidationError('mode 仅支持 preview 或 commit');
  rejectUnknown(body, allowed, '请求体');
  const items = validateItems(body.items, mode);
  if (mode === 'preview') return { mode, items };
  const requestId = requiredText(body.request_id, 'request_id', 80);
  if (!/^[A-Za-z0-9_.:-]+$/.test(requestId)) throw new ValidationError('request_id 非法');
  return { mode, request_id: requestId, items };
}

function queryColumns(alias = 'p') {
  return EVENT_CONTEXT_FIELDS.map((field) => alias + '.' + field).join(', ');
}

async function snapshotRowsForPreview(db, items) {
  if (!items.length) return [];
  const conditions = items.map(() => '(p.city = ? COLLATE NOCASE AND p.event_date_local = ?)').join(' OR ');
  const values = items.flatMap((item) => [item.city, item.event_date_local]);
  const result = await db.prepare(`
    SELECT ${queryColumns()}, p.prediction_time_epoch,
      EXISTS(
        SELECT 1 FROM sunset_observations o
        WHERE o.event_id = p.event_id AND o.source = 'rednote_manual'
      ) AS manual_exists
    FROM prediction_snapshots p
    WHERE ${conditions}
    ORDER BY p.event_id, p.prediction_time_epoch DESC
  `).bind(...values).all();
  return result.results || [];
}

async function snapshotRowsForEvents(db, items) {
  const placeholders = items.map(() => '?').join(', ');
  const result = await db.prepare(`
    SELECT ${queryColumns()}, p.prediction_time_epoch,
      EXISTS(
        SELECT 1 FROM sunset_observations o
        WHERE o.event_id = p.event_id AND o.source = 'rednote_manual'
      ) AS manual_exists
    FROM prediction_snapshots p
    WHERE p.event_id IN (${placeholders})
    ORDER BY p.event_id, p.prediction_time_epoch DESC
  `).bind(...items.map((item) => item.event_id)).all();
  return result.results || [];
}

function sameContext(left, right) {
  const fields = [
    'event_id', 'event_date_local', 'location_key', 'latitude', 'longitude',
    'location_source', 'location_id', 'timezone', 'sunset_time_utc',
    'sunset_time_local'
  ];
  return fields.every((field) => (left[field] == null ? null : left[field]) === (right[field] == null ? null : right[field]));
}

function candidates(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.event_id)) groups.set(row.event_id, []);
    groups.get(row.event_id).push(row);
  }
  return Array.from(groups.values()).map((group) => {
    const canonical = group[0];
    const conflict = group.some((row) => !sameContext(canonical, row));
    return {
      ...Object.fromEntries(EVENT_CONTEXT_FIELDS.map((field) => [field, canonical[field] == null ? null : canonical[field]])),
      snapshot_count: group.length,
      duplicate: group.some((row) => Number(row.manual_exists) === 1),
      context_conflict: conflict
    };
  });
}

function sameSearch(row, item) {
  return String(row.event_date_local) === item.event_date_local &&
    String(row.city).normalize('NFKC').trim().toLocaleLowerCase('en-US') === item.city.toLocaleLowerCase('en-US');
}

export async function previewBackfill(db, items) {
  const rows = await snapshotRowsForPreview(db, items.filter((item) => !item.validation_error));
  return items.map((item) => {
    if (item.validation_error) {
      return { ...item, status: 'invalid', error: item.validation_error, candidates: [] };
    }
    const matched = candidates(rows.filter((row) => sameSearch(row, item)));
    let status = 'matched';
    let error = null;
    if (!matched.length) {
      status = 'no_snapshot';
      error = '该城市和日期没有 Prediction Snapshot';
    } else if (matched.some((candidate) => candidate.context_conflict)) {
      status = 'context_conflict';
      error = '同一 Event 的 Snapshot 上下文不一致';
    } else if (matched.length > 1) {
      status = 'ambiguous';
      error = '匹配到多个 Event，请明确选择';
    } else if (matched[0].duplicate) {
      status = 'duplicate';
      error = '该 Event 已有管理员补录';
    }
    return { ...item, status, error, candidates: matched };
  });
}

function eventContext(row) {
  return Object.fromEntries(EVENT_CONTEXT_FIELDS.map((field) => [field, row[field] == null ? null : row[field]]));
}

async function requestFingerprint(actor, items) {
  const normalized = items.map((item) => ({
    event_id: item.event_id,
    rating: item.rating,
    confidence: item.confidence,
    evidence_count: item.evidence_count,
    comment: item.comment
  })).sort((left, right) => left.event_id.localeCompare(right.event_id));
  return sha256(JSON.stringify({ actor: actor.subject, items: normalized }));
}

async function existingRequest(db, requestId) {
  const result = await db.prepare(`
    SELECT request_id, request_fingerprint, observation_id, event_id
    FROM observation_admin_audit
    WHERE request_id = ?
    ORDER BY event_id
  `).bind(requestId).all();
  return result.results || [];
}

function deduplicatedResult(items, auditRows) {
  const byEvent = new Map(auditRows.map((row) => [row.event_id, row.observation_id]));
  return items.map((item) => ({
    client_item_id: item.client_item_id,
    event_id: item.event_id,
    observation_id: byEvent.get(item.event_id) || null,
    status: 'deduplicated'
  }));
}

function validateExistingRequest(items, fingerprint, rows) {
  if (!rows.length) return null;
  const exact = rows.length === items.length && rows.every((row) => row.request_fingerprint === fingerprint) &&
    items.every((item) => rows.some((row) => row.event_id === item.event_id));
  if (!exact) throw new BackfillConflictError('request_id 已被不同批次使用');
  return deduplicatedResult(items, rows);
}

async function manualSubmissionId(eventIdValue) {
  return 'manual_v1_' + await sha256('rednote_manual|' + eventIdValue);
}

export async function commitBackfill(db, actor, requestId, items, now = new Date()) {
  const fingerprint = await requestFingerprint(actor, items);
  const prior = validateExistingRequest(items, fingerprint, await existingRequest(db, requestId));
  if (prior) return { deduplicated: true, items: prior };

  const rows = await snapshotRowsForEvents(db, items);
  const grouped = new Map(items.map((item) => [item.event_id, candidates(rows.filter((row) => row.event_id === item.event_id))]));
  const invalid = [];
  for (const item of items) {
    const matched = grouped.get(item.event_id) || [];
    if (!matched.length) invalid.push({ client_item_id: item.client_item_id, event_id: item.event_id, status: 'no_snapshot' });
    else if (matched.some((candidate) => candidate.context_conflict)) invalid.push({ client_item_id: item.client_item_id, event_id: item.event_id, status: 'context_conflict' });
    else if (matched[0].duplicate) invalid.push({ client_item_id: item.client_item_id, event_id: item.event_id, status: 'duplicate' });
  }
  if (invalid.length) {
    const invalidById = new Map(invalid.map((item) => [item.client_item_id, item]));
    throw new BackfillConflictError('批次状态已变化，请重新预览', items.map((item) => (
      invalidById.get(item.client_item_id) || {
        client_item_id: item.client_item_id,
        event_id: item.event_id,
        status: 'not_committed'
      }
    )));
  }

  const statements = [];
  const committed = [];
  for (const item of items) {
    const candidate = grouped.get(item.event_id)[0];
    const observation = await buildObservationRow({
      submission_id: await manualSubmissionId(item.event_id),
      event_context: eventContext(candidate),
      rating: item.rating,
      comment: item.comment,
      source: 'rednote_manual',
      confidence: item.confidence,
      evidence_count: item.evidence_count
    }, {
      source: 'rednote_manual',
      allowedSources: ['rednote_manual'],
      submittedAt: now,
      snapshotId: null,
      datasetSchemaVersion: 3,
      id: 'obs_manual_' + now.getTime() + '_' + crypto.randomUUID()
    });
    delete observation.sunset_epoch;
    const audit = {
      id: 'audit_' + now.getTime() + '_' + crypto.randomUUID(),
      request_id: requestId,
      request_fingerprint: fingerprint,
      observation_id: observation.id,
      event_id: observation.event_id,
      action: 'create',
      actor_type: actor.type,
      actor_subject: actor.subject,
      actor_email: actor.email || null,
      created_at_utc: now.toISOString(),
      created_at_epoch: now.getTime()
    };
    statements.push(insertStatement(db, 'sunset_observations', OBSERVATION_FIELDS, observation));
    statements.push(insertStatement(db, 'observation_admin_audit', ADMIN_AUDIT_FIELDS, audit));
    committed.push({
      client_item_id: item.client_item_id,
      event_id: item.event_id,
      observation_id: observation.id,
      status: 'created'
    });
  }

  try {
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.some((result) => result && result.success === false)) {
      throw new Error('D1_BATCH_FAILED');
    }
  } catch (error) {
    if (!isUniqueError(error)) throw error;
    const raced = validateExistingRequest(items, fingerprint, await existingRequest(db, requestId));
    if (raced) return { deduplicated: true, items: raced };
    throw new BackfillConflictError('补录记录发生并发冲突，请重新预览');
  }
  return { deduplicated: false, items: committed };
}
