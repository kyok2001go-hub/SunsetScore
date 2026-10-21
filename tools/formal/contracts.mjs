import path from 'node:path';
import { canonicalJson, compare, fail, hash } from '../dataset/lib/common.mjs';

export const FORMAL_CONTRACT_REVISION = 1;
export const TEST_FIXTURE = Symbol('explicit API-only formal fixture');
export const INTERPRETATION = 'FIVE_LEVEL_SUNSET_AESTHETIC_ORDINAL';
export const LABELS = Object.freeze(['poor', 'fair', 'good', 'very_good', 'excellent']);
export const MAPPING = Object.freeze({ mapping_basis: 'REVIEWED_FIXED_PRODUCT_BANDS',
  mapping_status: 'READY', interpretation_scope: INTERPRETATION });
export const FIXED_MAPPING = Object.freeze({ mapping_contract_revision: 1,
  task: 'SUNSET_AESTHETIC_FIVE_LEVEL', algorithm: 'SCORE_TO_ORDINAL_INTEGER_V1',
  score_range: [0, 100], integer_only: true, thresholds: [20, 40, 60, 90],
  prediction_levels: ['很差', '较差', '一般', '很好', '极佳'], observation_labels: LABELS,
  interpretation_scope: INTERPRETATION });
export const assert = (ok, reason_code, detail) => {
  if (!ok) fail('FORMAL_CONTRACT_INVALID', { reason_code, ...(detail === undefined ? {} : { detail }) });
};
export const equal = (a, b, reason) => assert(canonicalJson(a) === canonicalJson(b), reason);
export function keys(value, required, optional = [], reason = 'FIELDS_INVALID') {
  assert(value && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => [...required, ...optional].includes(key)), reason);
}
export const text = value => typeof value === 'string' && value.trim().length > 0;
export const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function utc(value) {
  assert(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'), 'UTC_INVALID'); return Date.parse(value);
}
export function day(value) {
  assert(typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value, 'DATE_INVALID'); return value;
}
export function member(value) {
  assert(text(value.event_id) && text(value.location_key), 'EVENT_IDENTITY_INVALID'); day(value.event_date_local);
  return { event_id: value.event_id, location_key: value.location_key, event_date_local: value.event_date_local };
}
export const eventKey = value => `${value.location_key}\u0000${value.event_date_local}`;
export function members(values) {
  assert(Array.isArray(values), 'MEMBERS_INVALID'); const map = new Map(), locations = new Map();
  for (const value of values) {
    const item = member(value), prior = map.get(item.event_id), sameLocation = locations.get(eventKey(item));
    assert(!prior || canonicalJson(prior) === canonicalJson(item), 'EVENT_IDENTITY_CONFLICT');
    assert(!sameLocation || sameLocation === item.event_id, 'EVENT_LOCATION_ID_CONFLICT');
    map.set(item.event_id, item); locations.set(eventKey(item), item.event_id);
  }
  return [...map.values()].sort((a, b) => compare(a.event_id, b.event_id));
}
export function intersects(left, right) {
  const ids = new Set(right.map(x => x.event_id)), dates = new Set(right.map(eventKey));
  return left.filter(x => ids.has(x.event_id) || dates.has(eventKey(x)));
}
export function sourceRef(packet) {
  return { id: packet.manifest[packet.manifest.id_field], manifest_sha256: hash(canonicalJson(packet.manifest)) };
}
export function snapshot(packet) { return { manifest: packet.manifest, files: packet.files }; }
export function fixtureUsage(options = {}) { return options.testFixture === TEST_FIXTURE ? 'TEST_FIXTURE_ONLY' : null; }
export function assertExecutableUsage(usage, options = {}) {
  assert(usage === 'FORMAL' || (usage === 'TEST_FIXTURE_ONLY' && options.testFixture === TEST_FIXTURE),
    'TEST_FIXTURE_EXECUTION_FORBIDDEN');
}
export function rejectCliFixture(value) {
  const visit = x => {
    if (Array.isArray(x)) { x.forEach(visit); return; }
    if (!x || typeof x !== 'object') return;
    for (const [key, child] of Object.entries(x)) {
      assert(!(key === 'result_usage' && child === 'TEST_FIXTURE_ONLY') && key !== 'test_fixture_only',
        'TEST_FIXTURE_CLI_FORBIDDEN'); visit(child);
    }
  }; visit(value);
}
export function artifactDatasetRoot(directory) {
  const absolute = path.resolve(directory).replaceAll('\\', '/');
  return path.resolve(directory, /\/(?:rubrics|pilots|review_plans|evidence|plans|product_plans|executions)\/exports\/[^/]+$/.test(absolute) ? '../../../..' : '../../..');
}
