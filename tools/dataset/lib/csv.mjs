import { assertValue } from '../dataset-schema.mjs';
import { fail } from './common.mjs';

const cell = value => {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  const text = String(value);
  return text === '' || /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export function writeCsv(fields, rows) {
  const names = fields.map(field => field.name);
  const lines = [names.join(',')];
  for (const row of rows) {
    if (Object.keys(row).length !== names.length || Object.keys(row).some(name => !names.includes(name))) fail('CSV_COLUMNS_INVALID');
    lines.push(fields.map(field => { assertValue(field, row[field.name]); return cell(row[field.name]); }).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// Stateful RFC CSV parser retaining quoted-empty versus unquoted-null information.
export function parseCsv(text) {
  if (!text.startsWith('\uFEFF') || !text.endsWith('\r\n')) fail('CSV_ENCODING_INVALID');
  let i = 1, record = [];
  const records = [];
  while (i < text.length) {
    const quoted = text[i] === '"';
    let value = '';
    if (quoted) {
      i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { value += '"'; i += 2; }
          else { i++; closed = true; break; }
        } else value += text[i++];
      }
      if (!closed) fail('CSV_SYNTAX_INVALID');
    } else {
      while (i < text.length && ![',', '\r', '\n'].includes(text[i])) {
        if (text[i] === '"') fail('CSV_SYNTAX_INVALID');
        value += text[i++];
      }
    }
    record.push({ value, quoted });
    if (text[i] === ',') i++;
    else if (text.slice(i, i + 2) === '\r\n') {
      records.push(record); record = []; i += 2;
    } else fail('CSV_SYNTAX_INVALID');
  }
  if (record.length) fail('CSV_SYNTAX_INVALID');
  return records;
}
export function readCsv(fields, bytes) {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  const records = parseCsv(text), header = records.shift();
  if (!header || header.length !== fields.length || header.some((item, i) => item.quoted || item.value !== fields[i].name)) fail('CSV_COLUMNS_INVALID');
  const rows = records.map(record => {
    if (record.length !== fields.length) fail('CSV_COLUMNS_INVALID');
    return Object.fromEntries(fields.map((field, i) => {
      const item = record[i];
      let value = item.value;
      if (!item.quoted && value === '') value = null;
      else if (field.type === 'boolean') {
        if (!['0', '1'].includes(value)) fail('FIELD_INVALID');
        value = value === '1';
      } else if (field.type !== 'string') {
        if (!value || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) fail('FIELD_INVALID');
        value = Number(value);
      }
      assertValue(field, value);
      return [field.name, value];
    }));
  });
  // Also rejects noncanonical quoting, numeric spellings and invalid UTF-8 bytes.
  if (writeCsv(fields, rows) !== text || (typeof bytes !== 'string' && !Buffer.from(text).equals(Buffer.from(bytes)))) fail('CSV_NOT_CANONICAL');
  return rows;
}
