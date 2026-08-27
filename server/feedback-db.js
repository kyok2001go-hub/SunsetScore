/** Read-only compatibility with V2.2.2 and migrated V2.3 D1 tables. */
export async function feedbackColumns(db) {
  const info = await db.prepare('PRAGMA table_info(sunset_feedback)').all();
  const columns = new Set((info.results || []).map((row) => row.name));
  if (!columns.has('created_at') || !columns.has('user_rating')) {
    throw new Error('sunset_feedback table is missing; initialize schema.sql');
  }
  return columns;
}

// V2.2.2 created_at is Beijing wall-clock time, NOT UTC or the city's local time.
export function feedbackEpochSql(columns) {
  const legacy = "CAST(strftime('%s', created_at, '-8 hours') AS INTEGER) * 1000";
  return columns.has('created_at_epoch') ? `COALESCE(created_at_epoch, ${legacy})` : legacy;
}

export function feedbackSelectSql(name, columns) {
  if (name === 'created_at_epoch') return `${feedbackEpochSql(columns)} AS created_at_epoch`;
  if (columns.has(name)) return name;
  if (name === 'created_at_utc') {
    return "strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '-8 hours') AS created_at_utc";
  }
  if (name === 'app_version' || name === 'schema_version') {
    const fallback = name === 'app_version' ? 'model_version' : '2';
    const snapshot = columns.has('raw_snapshot_json')
      ? `json_extract(CASE WHEN json_valid(raw_snapshot_json) THEN raw_snapshot_json ELSE '{}' END, '$.${name}')`
      : 'NULL';
    return `COALESCE(${snapshot}, ${fallback}) AS ${name}`;
  }
  // name comes only from the hard-coded export allowlist, never from a request.
  return `NULL AS ${name}`;
}
