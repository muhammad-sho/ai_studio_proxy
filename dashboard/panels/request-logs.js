(() => {
  const { api, esc, copyText, resetCopyButtons } = window.dashboard;

  function syncModelFilter(models) {
    const sel = document.getElementById('logModel');
    const desired = '<option value="">All models and request types</option>' + models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    if (sel.innerHTML === desired) return;
    const current = sel.value;
    sel.innerHTML = desired;
    sel.value = [...sel.options].some(o => o.value === current) ? current : '';
  }

  let logsOffset = 0;
  const LOG_PAGE_SIZE = 50;

  function resultTag(l) {
    if (l.outcome === 'success') return `<span class="status-tag tag-ready">${l.status}</span>`;
    if (l.outcome === 'rejected') return `<span class="status-tag tag-off">rejected · ${l.status ?? 'ERR'}${l.error_code ? ' · ' + esc(l.error_code) : ''}</span>`;
    return `<span class="status-tag tag-cooldown">${l.status ?? 'ERR'}${l.error_code ? ' · ' + esc(l.error_code) : ''}</span>`;
  }

  async function loadLogs(reset = true) {
    if (reset) { logsOffset = 0; }
    const params = new URLSearchParams();
    const model = document.getElementById('logModel').value;
    const outcome = document.getElementById('logResult').value;
    const q = document.getElementById('logSearch').value.trim();
    if (model) params.set('model', model);
    if (outcome) params.set('outcome', outcome);
    if (q) params.set('q', q);
    params.set('limit', String(LOG_PAGE_SIZE));
    params.set('offset', String(logsOffset));
    try {
      const d = await api('/api/admin/logs?' + params.toString());
      if (Array.isArray(d.models)) syncModelFilter(d.models);
      document.getElementById('logsTbody').innerHTML = d.logs.length
        ? d.logs.map(l => `<tr class="log-row" onclick="showLogDetail(${l.id})">
            <td>${new Date(Number(l.created_at)).toLocaleTimeString()}</td>
            <td><strong>${esc(l.model)}</strong></td>
            <td><code style="font-family:'JetBrains Mono',monospace">${esc(l.key_label || '—')}${l.key_masked ? ` (${esc(l.key_masked)})` : ''}</code></td>
            <td>${l.attempt || '—'}</td>
            <td>${resultTag(l)}</td>
          </tr>`).join('')
        : '<tr><td colspan="5" class="empty-notice">No log entries match.</td></tr>';
      document.getElementById('logMeta').textContent = `${d.total} log entr${d.total === 1 ? 'y' : 'ies'}`;
      document.getElementById('logsNewerBtn').style.display = logsOffset > 0 ? '' : 'none';
      document.getElementById('logsOlderBtn').style.display = logsOffset + LOG_PAGE_SIZE < d.total ? '' : 'none';
    } catch (err) { console.error(err); }
  }

  function logsPage(delta) {
    logsOffset = Math.max(0, logsOffset + delta * LOG_PAGE_SIZE);
    loadLogs(false);
  }

  function prettyPayload(text) {
    if (!text) return '';
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }

  const EVENT_KIND = {
    receive:  { label: 'received', tone: '' },
    auth:     { label: 'auth',     tone: 'tl-good' },
    body:     { label: 'body',     tone: '' },
    pool:     { label: 'key pool', tone: '' },
    order:    { label: 'order',    tone: '' },
    select:   { label: 'attempt',  tone: '' },
    upstream: { label: 'response', tone: 'tl-warn' },
    result:   { label: 'outcome',  tone: '' },
    cooldown: { label: 'cooldown', tone: 'tl-warn' },
    transport:{ label: 'transport',tone: 'tl-bad' },
    relay:    { label: 'relayed',  tone: 'tl-good' },
    abort:    { label: 'aborted',  tone: 'tl-bad' },
    fail:     { label: 'failed',   tone: 'tl-bad' },
    reject:   { label: 'rejected', tone: 'tl-bad' }
  };

  function timelineHtml(eventsJson) {
    let evs = [];
    try { evs = JSON.parse(eventsJson || '[]'); } catch {}
    if (!Array.isArray(evs) || !evs.length) return '';
    return `<h3>Timeline</h3><div class="timeline">${evs.map(ev => {
      const kind = EVENT_KIND[ev.type] || { label: ev.type || 'event', tone: '' };
      return `<div class="tl-row ${kind.tone}"><span class="tl-t">+${Number(ev.t) || 0} ms</span><span class="tl-type">${esc(kind.label)}</span><span class="tl-d">${esc(ev.detail)}</span></div>`;
    }).join('')}</div>`;
  }

  let currentLog = null;

  function closeLogModal() {
    const modal = document.getElementById('logModal');
    resetCopyButtons(modal);
    modal.style.display = 'none';
    currentLog = null;
  }

  async function showLogDetail(id) {
    try {
      const modal = document.getElementById('logModal');
      resetCopyButtons(modal);
      const l = await api('/api/admin/logs/' + id);
      currentLog = l;
      document.getElementById('logModalTitle').innerHTML = `Log #${l.id} ${resultTag(l)}`;
      const summary = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;
      document.getElementById('logModalBody').innerHTML = `
        <dl class="log-summary">
          ${summary('Time', new Date(Number(l.created_at)).toLocaleString())}
          ${summary('Model / request type', `<strong>${esc(l.model)}</strong>`)}
          ${summary('Gemini key', l.key_label ? `${esc(l.key_label)} <code style="font-family:'JetBrains Mono',monospace">(${esc(l.key_masked)})</code>` : '—')}
          ${summary('Attempts', String(l.attempt || 0))}
          ${summary('Result', `${resultTag(l)}${l.error_code ? ` · ${esc(l.error_code)}` : ''}`)}
          ${summary('Trace', `<code style="font-family:'JetBrains Mono',monospace">${esc((l.trace_id || '').slice(0, 8)) || '—'}</code> <span style="color:var(--text-muted);font-size:11px">(search this ID in the proxy logs)</span>`)}
        </dl>
        ${timelineHtml(l.events)}`;
      document.getElementById('logModal').style.display = 'flex';
    } catch (err) { console.error(err); }
  }

  function logDebugText(l) {
    let events = [];
    try { events = JSON.parse(l.events || '[]'); } catch {}
    return JSON.stringify({
      id: l.id,
      trace_id: l.trace_id,
      created_at: new Date(Number(l.created_at)).toISOString(),
      model: l.model,
      key: l.key_label ? `${l.key_label} (${l.key_masked})` : null,
      attempt: l.attempt,
      status: l.status,
      outcome: l.outcome,
      error_code: l.error_code,
      timeline: events,
      request_body: prettyPayload(l.request_body) || null,
      response_body: prettyPayload(l.response_body) || null
    }, null, 2);
  }

  async function copyLogDetail(button) {
    if (!currentLog) return;
    copyText(logDebugText(currentLog), button);
  }

  window.loadLogs = loadLogs;
  window.logsPage = logsPage;
  window.showLogDetail = showLogDetail;
  window.closeLogModal = closeLogModal;
  window.copyLogDetail = copyLogDetail;
})();
