/* SunsetScore V2.4.5 - administrator Observation backfill UI */
(function () {
  'use strict';

  const MAX_ROWS = 20;
  const rowsNode = document.getElementById('backfill-rows');
  const template = document.getElementById('row-template');
  const addButton = document.getElementById('add-row');
  const previewButton = document.getElementById('preview');
  const commitButton = document.getElementById('commit');
  const statusNode = document.getElementById('status');
  let previewItems = null;
  let commitRequestId = null;
  let busy = false;

  function setStatus(message, kind) {
    statusNode.textContent = message;
    statusNode.className = 'status' + (kind ? ' ' + kind : '');
  }

  function invalidatePreview() {
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

  function addRow() {
    if (rowsNode.rows.length >= MAX_ROWS) {
      setStatus('单次最多允许 20 行。', 'error');
      return;
    }
    const fragment = template.content.cloneNode(true);
    const row = fragment.querySelector('tr');
    row.dataset.clientItemId = 'row-' + crypto.randomUUID();
    const onEdit = function (event) {
      if (event.target.matches('[data-field]')) invalidatePreview();
    };
    row.addEventListener('input', onEdit);
    row.addEventListener('change', onEdit);
    row.querySelector('.remove-row').addEventListener('click', function () {
      row.remove();
      if (!rowsNode.rows.length) addRow();
      invalidatePreview();
    });
    rowsNode.appendChild(fragment);
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

  function formItems() {
    return Array.from(rowsNode.rows, function (row) {
      const field = function (name) { return row.querySelector('[data-field="' + name + '"]'); };
      return {
        client_item_id: row.dataset.clientItemId,
        city: field('city').value.trim(),
        event_date_local: field('event_date_local').value,
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
    busy = true;
    previewButton.disabled = true;
    commitButton.disabled = true;
    setStatus('正在查询 Snapshot 并校验 Event…');
    try {
      const body = await post({ mode: 'preview', items });
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

  addButton.addEventListener('click', addRow);
  previewButton.addEventListener('click', preview);
  commitButton.addEventListener('click', commit);
  addRow();
}());
