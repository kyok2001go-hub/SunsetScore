/* SunsetScore V2.5.2.1 - administrator Observation backfill UI */
(function () {
  'use strict';

  const MAX_ROWS = 20;
  const BULK_RATING_BY_ORDINAL = {
    '0': 'poor',
    '1': 'fair',
    '2': 'good',
    '3': 'very_good',
    '4': 'excellent'
  };
  const BULK_CONFIDENCE_RE = /^(?:0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/;
  const BULK_EVIDENCE_RE = /^\d+$/;
  const rowsNode = document.getElementById('backfill-rows');
  const template = document.getElementById('row-template');
  const bulkButton = document.getElementById('bulk-add');
  const bulkDialog = document.getElementById('bulk-dialog');
  const bulkText = document.getElementById('bulk-text');
  const bulkFeedback = document.getElementById('bulk-feedback');
  const bulkConfirmButton = document.getElementById('bulk-confirm');
  const bulkCloseButton = document.getElementById('bulk-close');
  const bulkCancelButton = document.getElementById('bulk-cancel');
  const addButton = document.getElementById('add-row');
  const previewButton = document.getElementById('preview');
  const commitButton = document.getElementById('commit');
  const statusNode = document.getElementById('status');
  let previewItems = null;
  let commitRequestId = null;
  let busy = false;
  let editRevision = 0;

  function setStatus(message, kind) {
    statusNode.textContent = message;
    statusNode.className = 'status' + (kind ? ' ' + kind : '');
  }

  function invalidatePreview() {
    editRevision++;
    previewItems = null;
    commitRequestId = null;
    commitButton.disabled = true;
    for (const row of rowsNode.rows) {
      const status = row.querySelector('.match-status');
      const slot = row.querySelector('.candidate-slot');
      status.textContent = '待重新预览';
      status.className = 'match-status';
      slot.replaceChildren();
    }
  }

  function restoreMaximum(input, maximum) {
    if (!input.value.trim()) return;
    const value = Number(input.value);
    if (Number.isFinite(value) && value > maximum) input.value = String(maximum);
  }

  function setRowValues(row, values) {
    const field = function (name) { return row.querySelector('[data-field="' + name + '"]'); };
    field('city').value = values.city || '';
    const date = values.event_date_local || '';
    field('event_date_local').value = date;
    row.querySelector('.date-picker').value = date;
    field('rating').value = values.rating || '';
    field('confidence').value = values.confidence == null ? '' : String(values.confidence);
    field('evidence_count').value = values.evidence_count == null ? '' : String(values.evidence_count);
    field('comment').value = values.comment || '';
  }

  function createRow(values) {
    const fragment = template.content.cloneNode(true);
    const row = fragment.querySelector('tr');
    row.dataset.clientItemId = 'row-' + crypto.randomUUID();
    const onEdit = function (event) {
      if (event.target.matches('[data-field]')) {
        if (event.target.matches('[data-field="event_date_local"]') && /^\d{8}$/.test(event.target.value)) {
          const normalized = normalizeDate(event.target.value);
          if (normalized) event.target.value = normalized;
        }
        if (event.target.matches('[data-field="confidence"]')) restoreMaximum(event.target, 1);
        if (event.target.matches('[data-field="evidence_count"]')) restoreMaximum(event.target, 10000);
        invalidatePreview();
      }
    };
    row.addEventListener('input', onEdit);
    row.addEventListener('change', onEdit);
    const dateInput = row.querySelector('[data-field="event_date_local"]');
    const datePicker = row.querySelector('.date-picker');
    dateInput.addEventListener('blur', function () {
      const normalized = normalizeDate(dateInput.value);
      if (normalized) dateInput.value = normalized;
      datePicker.value = normalized || '';
    });
    datePicker.addEventListener('click', function () {
      datePicker.value = normalizeDate(dateInput.value) || '';
      if (typeof datePicker.showPicker === 'function') {
        try { datePicker.showPicker(); } catch (_) { /* Keep the native date control fallback. */ }
      }
    });
    datePicker.addEventListener('change', function () {
      const normalized = normalizeDate(datePicker.value);
      dateInput.value = normalized || '';
      invalidatePreview();
    });
    row.querySelector('.remove-row').addEventListener('click', function () {
      row.remove();
      if (!rowsNode.rows.length) addRow();
      invalidatePreview();
    });
    rowsNode.appendChild(fragment);
    setRowValues(row, values || {});
    return row;
  }

  function addRow() {
    if (rowsNode.rows.length >= MAX_ROWS) {
      setStatus('单次最多允许 20 行。', 'error');
      return;
    }
    createRow();
    invalidatePreview();
  }

  function optionalNumber(input, integer) {
    if (!input.value.trim()) return null;
    const value = Number(input.value);
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
      throw new Error(integer ? '证据数必须是整数' : '置信度必须是数字');
    }
    return value;
  }

  function normalizeDate(value) {
    const text = value.trim();
    const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
    const separated = /^(\d{4})([.\/-])(\d{1,2})\2(\d{1,2})$/.exec(text);
    const match = compact || (separated && [separated[0], separated[1], separated[3], separated[4]]);
    if (!match || Number(match[1]) < 1) return null;
    const normalized = match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
    const parsed = new Date(normalized + 'T00:00:00.000Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized ? normalized : null;
  }

  function splitBulkLine(line) {
    const fields = [];
    let start = 0;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if ((char === ',' || char === '，') && fields.length < 5) {
        fields.push(line.slice(start, index).trim());
        start = index + 1;
      }
    }
    fields.push(line.slice(start).trim());
    while (fields.length < 6) fields.push('');
    return fields;
  }

  function parseBulkRecord(fields, lineNumber) {
    const warnings = [];
    const values = {
      city: fields[0],
      event_date_local: '',
      rating: '',
      confidence: null,
      evidence_count: null,
      comment: fields[5]
    };
    const warning = function (message) {
      warnings.push('第 ' + lineNumber + ' 行：' + message);
    };

    if (fields[1]) {
      const date = normalizeDate(fields[1]);
      if (date) values.event_date_local = date;
      else warning('日期格式无效，已留空');
    }

    if (fields[2]) {
      const rating = BULK_RATING_BY_ORDINAL[fields[2]];
      if (rating) values.rating = rating;
      else warning('等级必须是 0-4，已留空');
    }

    if (fields[3]) {
      if (BULK_CONFIDENCE_RE.test(fields[3])) values.confidence = Number(fields[3]);
      else warning('置信度必须是 0-1 且最多两位小数，已留空');
    }

    if (fields[4]) {
      if (BULK_EVIDENCE_RE.test(fields[4])) {
        const evidenceCount = Number(fields[4]);
        if (evidenceCount <= 10000) values.evidence_count = evidenceCount;
        else warning('证据数必须是 0-10000 的整数，已留空');
      } else {
        warning('证据数必须是 0-10000 的整数，已留空');
      }
    }

    return { values, warnings };
  }

  function parseBulkRows(text) {
    const candidates = [];
    const lines = String(text || '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      const fields = splitBulkLine(line);
      if (fields.every(function (value) { return !value; })) continue;
      candidates.push({ fields, lineNumber: index + 1 });
    }

    const kept = candidates.slice(0, MAX_ROWS);
    const truncated = Math.max(0, candidates.length - kept.length);
    const warnings = [];
    if (truncated) {
      warnings.push('识别到 ' + candidates.length + ' 条数据，已导入前 ' + kept.length + ' 条，忽略后 ' + truncated + ' 条。');
    }
    const rows = kept.map(function (entry) {
      const parsed = parseBulkRecord(entry.fields, entry.lineNumber);
      warnings.push(...parsed.warnings);
      return parsed.values;
    });
    if (!candidates.length) warnings.push('未识别到可导入数据。');
    return { rows, warnings, sourceCount: candidates.length, truncated };
  }

  function replaceRows(records) {
    rowsNode.replaceChildren();
    const rows = records.length ? records : [{}];
    for (const values of rows) createRow(values);
    invalidatePreview();
  }

  function renderBulkFeedback(result) {
    const lines = [];
    if (result.sourceCount) lines.push('已识别 ' + result.sourceCount + ' 条，导入 ' + result.rows.length + ' 行。');
    else lines.push('未识别到可导入数据，当前表格已重置为一行。');
    lines.push(...result.warnings);
    bulkFeedback.textContent = lines.join('\n');
    bulkFeedback.className = 'bulk-feedback ' + (result.warnings.length ? 'warning' : 'success');
    bulkFeedback.hidden = false;
  }

  function closeBulkDialog() {
    if (typeof bulkDialog.close === 'function') bulkDialog.close();
    else bulkDialog.removeAttribute('open');
  }

  function openBulkDialog() {
    if (bulkDialog.open) {
      bulkText.focus();
      return;
    }
    bulkFeedback.hidden = true;
    bulkFeedback.textContent = '';
    bulkFeedback.className = 'bulk-feedback';
    if (typeof bulkDialog.showModal === 'function') bulkDialog.showModal();
    else bulkDialog.setAttribute('open', '');
    bulkText.focus();
  }

  function importBulkRows() {
    const result = parseBulkRows(bulkText.value);
    replaceRows(result.rows);
    renderBulkFeedback(result);
    const warning = result.warnings.length > 0;
    const summary = result.sourceCount
      ? '已批量导入 ' + result.rows.length + ' 行。' +
        (result.truncated ? ' 已忽略 ' + result.truncated + ' 行。' : '') +
        (warning ? ' 请查看批量导入警告。' : '')
      : '未识别到可导入数据，当前表格已重置为一行。';
    setStatus(summary, warning ? 'error' : 'success');
    if (!warning) {
      bulkText.value = '';
      closeBulkDialog();
    }
  }

  function formItems() {
    return Array.from(rowsNode.rows, function (row, index) {
      const field = function (name) { return row.querySelector('[data-field="' + name + '"]'); };
      const date = normalizeDate(field('event_date_local').value);
      if (!date) {
        field('event_date_local').focus();
        throw new Error('第 ' + (index + 1) + ' 行：请输入有效日期，例如20260910或2026-09-10');
      }
      field('event_date_local').value = date;
      if (!['excellent', 'very_good', 'good', 'fair', 'poor'].includes(field('rating').value)) {
        field('rating').focus();
        throw new Error('第 ' + (index + 1) + ' 行：请选择晚霞等级');
      }
      return {
        client_item_id: row.dataset.clientItemId,
        city: field('city').value.trim(),
        event_date_local: date,
        rating: field('rating').value,
        confidence: optionalNumber(field('confidence'), false),
        evidence_count: optionalNumber(field('evidence_count'), true),
        comment: field('comment').value.trim() || null
      };
    });
  }

  async function post(payload) {
    const response = await fetch('/api/admin/observation-backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(function () { return null; });
    if (!response.ok || !body || body.success !== true) {
      const error = new Error(body && body.error || '请求失败（HTTP ' + response.status + '）');
      error.details = body;
      throw error;
    }
    return body;
  }

  function candidateLabel(candidate) {
    const place = [candidate.city, candidate.admin1, candidate.country].filter(Boolean).join(' · ');
    return place + '｜' + candidate.sunset_time_local + '｜' + candidate.event_id;
  }

  function candidateDetail(candidate) {
    const identity = candidate.location_source && candidate.location_id
      ? candidate.location_source + ':' + candidate.location_id
      : Number(candidate.latitude).toFixed(4) + ', ' + Number(candidate.longitude).toFixed(4);
    return identity + '｜' + candidate.timezone + '｜Snapshot ' + candidate.snapshot_count + ' 条';
  }

  function renderCandidate(row, item) {
    const status = row.querySelector('.match-status');
    const slot = row.querySelector('.candidate-slot');
    slot.replaceChildren();
    if (!item) {
      status.textContent = '预览结果缺失，请重试';
      status.className = 'match-status error';
      return;
    }
    status.textContent = item.error || item.status;
    status.className = 'match-status ' + (item.status === 'matched' ? 'ok' : 'error');
    if (!item.candidates || !item.candidates.length) return;

    if (item.status === 'ambiguous') {
      const select = document.createElement('select');
      select.setAttribute('aria-label', '选择 Sunset Event');
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '请选择具体 Event';
      select.appendChild(placeholder);
      for (const candidate of item.candidates) {
        const option = document.createElement('option');
        option.value = candidate.event_id;
        option.textContent = candidateLabel(candidate);
        option.disabled = candidate.duplicate || candidate.context_conflict;
        select.appendChild(option);
      }
      select.addEventListener('change', function () {
        item.selected_event_id = select.value || null;
        status.textContent = select.value ? '已选择 Event' : item.error;
        status.className = 'match-status ' + (select.value ? 'ok' : 'error');
        updateCommitState();
      });
      slot.appendChild(select);
      return;
    }

    const candidate = item.candidates[0];
    if (item.status === 'matched') item.selected_event_id = candidate.event_id;
    const detail = document.createElement('div');
    detail.className = 'candidate-detail';
    detail.textContent = candidateLabel(candidate) + '｜' + candidateDetail(candidate);
    slot.appendChild(detail);
  }

  function readyItem(item) {
    return item.status === 'matched' || (item.status === 'ambiguous' && item.selected_event_id);
  }

  function updateCommitState() {
    commitButton.disabled = busy || !previewItems || !previewItems.length || !previewItems.every(readyItem);
  }

  async function preview() {
    if (busy) return;
    let items;
    try { items = formItems(); }
    catch (error) { setStatus(error.message, 'error'); return; }
    const revision = editRevision;
    busy = true;
    previewButton.disabled = true;
    commitButton.disabled = true;
    setStatus('正在查询 Snapshot 并校验 Event…');
    try {
      const body = await post({ mode: 'preview', items });
      if (revision !== editRevision) {
        setStatus('内容已修改，请重新预览并校验。', 'error');
        return;
      }
      previewItems = body.items;
      commitRequestId = null;
      const byId = new Map(previewItems.map(function (item) { return [item.client_item_id, item]; }));
      for (const row of rowsNode.rows) renderCandidate(row, byId.get(row.dataset.clientItemId));
      const ready = previewItems.filter(readyItem).length;
      setStatus('预览完成：' + ready + '/' + previewItems.length + ' 行可提交。' +
        (ready === previewItems.length ? ' 请核对 Event 后确认。' : ' 请处理或删除不可提交行。'),
        ready === previewItems.length ? 'success' : 'error');
    } catch (error) {
      previewItems = null;
      setStatus(error.message, 'error');
    } finally {
      busy = false;
      previewButton.disabled = false;
      updateCommitState();
    }
  }

  function commitItems() {
    return previewItems.map(function (item) {
      return {
        client_item_id: item.client_item_id,
        event_id: item.selected_event_id || item.candidates[0].event_id,
        rating: item.rating,
        confidence: item.confidence,
        evidence_count: item.evidence_count,
        comment: item.comment
      };
    });
  }

  function renderCommitFailure(items) {
    if (!Array.isArray(items)) return;
    const labels = {
      no_snapshot: 'Snapshot 已不存在',
      context_conflict: 'Event 上下文冲突',
      duplicate: '该 Event 已有管理员补录',
      not_committed: '批次未提交'
    };
    for (const result of items) {
      const row = Array.from(rowsNode.rows).find(function (entry) {
        return entry.dataset.clientItemId === result.client_item_id;
      });
      if (!row) continue;
      const status = row.querySelector('.match-status');
      status.textContent = labels[result.status] || result.status || '提交失败';
      status.className = 'match-status error';
    }
  }

  async function commit() {
    if (busy || !previewItems || !previewItems.every(readyItem)) return;
    try { formItems(); }
    catch (error) { invalidatePreview(); setStatus(error.message, 'error'); return; }
    if (!window.confirm('确认写入 ' + previewItems.length + ' 条管理员 Observation？此版本不支持修改或删除。')) return;
    if (!commitRequestId) commitRequestId = crypto.randomUUID();
    busy = true;
    previewButton.disabled = true;
    commitButton.disabled = true;
    setStatus('正在原子提交 Observation 与审计记录…');
    try {
      const body = await post({ mode: 'commit', request_id: commitRequestId, items: commitItems() });
      const prefix = body.deduplicated ? '该批次此前已写入，未重复创建。' : '提交成功。';
      setStatus(prefix + ' 共 ' + body.items.length + ' 条。', 'success');
      for (const result of body.items) {
        const row = Array.from(rowsNode.rows).find(function (entry) { return entry.dataset.clientItemId === result.client_item_id; });
        if (!row) continue;
        const status = row.querySelector('.match-status');
        status.textContent = result.status === 'deduplicated' ? '已存在（本批次重试）' : '已创建';
        status.className = 'match-status ok';
      }
      previewItems = null;
    } catch (error) {
      renderCommitFailure(error.details && error.details.items);
      setStatus(error.message + '；若刚才发生超时，请保留当前页面并再次确认提交。', 'error');
    } finally {
      busy = false;
      previewButton.disabled = false;
      updateCommitState();
    }
  }

  bulkButton.addEventListener('click', openBulkDialog);
  bulkConfirmButton.addEventListener('click', importBulkRows);
  bulkCloseButton.addEventListener('click', closeBulkDialog);
  bulkCancelButton.addEventListener('click', closeBulkDialog);
  bulkDialog.addEventListener('click', function (event) {
    if (event.target === bulkDialog) closeBulkDialog();
  });
  addButton.addEventListener('click', addRow);
  previewButton.addEventListener('click', preview);
  commitButton.addEventListener('click', commit);
  addRow();
}());
