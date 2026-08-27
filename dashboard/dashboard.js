  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const csrf = () => document.cookie.match(/(?:^|; )ai_studio_proxy_csrf=([^;]+)/)?.[1] || '';

  // Theme Management
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ai_studio_proxy_theme', theme);
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.innerHTML = theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  const savedTheme = localStorage.getItem('ai_studio_proxy_theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(savedTheme);

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf(),
        ...(options.headers || {})
      }
    });
    if (response.status === 401) {
      location.reload();
      throw Error('Session expired');
    }
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) throw Error(data?.error?.message || data?.error || 'Request failed');
    return data;
  }

  async function copyText(value, button) {
    let copied = false;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch {}
    if (!copied) {
      const input = document.createElement('textarea');
      input.value = value;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.focus();
      input.select();
      copied = document.execCommand('copy');
      input.remove();
    }
    button.textContent = copied ? 'Copied!' : 'Copy failed';
  }

  function showClientKey(key) {
    const box = document.getElementById('generatedClientKey');
    box.className = 'key-alert visible';
    box.innerHTML = `<div class="key-alert-head">Your new client key</div>
      <div style="font-size:12px;color:var(--text-dim)">Copy it now or at any time from the Client Keys tab.</div>
      <code class="key-alert-code">${esc(key)}</code>
      <button class="btn-tbl" onclick="copyText('${esc(key)}',this)">Copy Key</button>`;
  }

  function render(data) {
    const totalReq = (data.usage || []).reduce((s, r) => s + (r.today || 0), 0);
    const models = data.models || [];

    document.getElementById('ov-ck').textContent = (data.clientKeys || []).length;
    document.getElementById('ov-gk').textContent = (data.keys || []).length;
    document.getElementById('ov-m').textContent = models.length;
    document.getElementById('ov-r').textContent = totalReq;

    const rst = data.resetTimezone
      ? `Midnight Pacific (${data.resetTimezone}) · Began ${new Date(data.resetAt).toLocaleTimeString()}`
      : '';
    const mc = data.modelsCheckedAt
      ? `${new Date(Number(data.modelsCheckedAt)).toLocaleString()}`
      : 'Not checked yet';

    document.getElementById('ov-reset').textContent = rst;
    document.getElementById('ov-mc').textContent = mc;
    const cacheAge = data.modelsCheckedAt ? Date.now() - Number(data.modelsCheckedAt) : null;
    const statusEl = document.getElementById('cacheStatus');
    if (!data.modelsCheckedAt) {
      statusEl.textContent = ' (no cache)';
      statusEl.style.color = 'var(--rose)';
    } else if (cacheAge < 24 * 3600e3) {
      statusEl.textContent = ` (fresh, ${Math.round(cacheAge/60e3)}m ago)`;
      statusEl.style.color = 'var(--emerald)';
    } else {
      statusEl.textContent = ` (stale, ${Math.round(cacheAge/3600e3)}h ago)`;
      statusEl.style.color = 'var(--amber)';
    }

    const ck = data.clientKeys || [];
    document.getElementById('clientKeysTbody').innerHTML = ck.length
      ? ck.map(k => {
          const u = usageFor((pageUsage || {}).clients, k.id);
          return `<tr class="key-row" data-key-type="client" data-key-id="${k.id}" title="Click for actions">
          <td><strong>${esc(k.label)}</strong></td>
          <td><code style="font-family:'JetBrains Mono',monospace">${esc(k.masked)}</code></td>
          <td class="u-total">${u.total}</td>
          <td class="u-success">${u.success}</td>
          <td class="u-pct">${pct(u.success, u.total)}</td>
        </tr>`;
        }).join('')
      : '<tr><td colspan="5" class="empty-notice">No client keys configured.</td></tr>';

    const gk = data.keys || [];
    document.getElementById('keysTbody').innerHTML = gk.length
      ? gk.map(k => {
          const u = usageFor((pageUsage || {}).keys, k.id);
          return `<tr class="key-row" data-key-type="gemini" data-key-id="${k.id}" title="Click for actions">
          <td><strong>${esc(k.label)}</strong></td>
          <td><code style="font-family:'JetBrains Mono',monospace">${esc(k.masked)}</code></td>
          <td class="u-total">${u.total}</td>
          <td class="u-success">${u.success}</td>
          <td class="u-pct">${pct(u.success, u.total)}</td>
        </tr>`;
        }).join('')
      : '<tr><td colspan="5" class="empty-notice">No Gemini API keys configured.</td></tr>';

    const us = data.usage || [];

    // Build pivot matrix: models (rows) × keys (cols)
    const usedModels = [...new Set(us.map(r => r.model))].sort();
    const usedKeys = [...new Set(us.map(r => r.key_id))].sort((a,b)=>a-b);
    const keyLabels = {};
    const keyMasks = {};
    us.forEach(r => { keyLabels[r.key_id] = r.label; keyMasks[r.key_id] = r.masked; });

    function cellMeta(row) {
      const now = Date.now();
      const active = row.cooldown_until && Number(row.cooldown_until) > now;
      if (active && row.cooldown_reason === 'daily_quota') {
        return { cls: 'cell-hot', title: `Daily limit reached — resets at ${new Date(Number(row.cooldown_until)).toLocaleTimeString()}` };
      }
      if (active) {
        return { cls: 'cell-warn', title: `${row.cooldown_reason || 'cooldown'} — ~${Math.max(1, Math.ceil((row.cooldown_until - now) / 1000))}s left` };
      }
      return { cls: 'cell-ok', title: 'Ready' };
    }

    if (!us.length) {
      document.getElementById('usageThead').innerHTML = '';
      document.getElementById('usageTbody').innerHTML = '<tr><td colspan="2" class="empty-notice">No requests recorded in the current day window.</td></tr>';
      return;
    }

    // Header row with numbered key columns (hover/click reveals the key)
    const headerHtml = ['<th>Model</th>'].concat(usedKeys.map((id, i) =>
      `<th class="keynum" title="${esc(keyLabels[id])} · ${esc(keyMasks[id])}" onclick="showKeyTip(event, '${esc(`${i + 1} = ${keyLabels[id]} (${keyMasks[id]})`)}')">${i + 1}</th>`
    )).join('');

    // Data rows
    const rowsHtml = usedModels.map(model => {
      const cells = usedKeys.map(keyId => {
        const match = us.find(r => r.model === model && r.key_id === keyId);
        if (!match) return '<td class="num cell-none">·</td>';
        const meta = cellMeta(match);
        return `<td class="num ${meta.cls}" title="${esc(meta.title)}">${match.today}</td>`;
      }).join('');
      return `<tr><th title="${esc(model)}">${esc(model)}</th>${cells}</tr>`;
    }).join('');

    document.getElementById('usageThead').innerHTML = '<tr>' + headerHtml + '</tr>';
    document.getElementById('usageTbody').innerHTML = rowsHtml;
  }

  function showKeyTip(evt, text) {
    evt.stopPropagation();
    let tip = document.getElementById('keyTip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'keyTip'; document.body.appendChild(tip); }
    tip.textContent = text;
    tip.style.display = 'block';
    const r = evt.currentTarget.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px';
    tip.style.top = (r.bottom + 6) + 'px';
    clearTimeout(tip._t);
    tip._t = setTimeout(() => { tip.style.display = 'none'; }, 1800);
  }

  function initUsageColumnFocus() {
    const table = document.querySelector('.usage-table');
    if (!table) return;
    const clear = () => table.querySelectorAll('td.xfocus').forEach(n => n.classList.remove('xfocus'));
    table.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('td');
      clear();
      if (!cell || cell.cellIndex === 0) return;
      for (const row of table.tBodies[0].rows) row.cells[cell.cellIndex]?.classList.add('xfocus');
    });
    table.addEventListener('mouseleave', clear);
  }

  async function clearCooldowns() {
    try {
      await api('/api/admin/cooldowns/clear', { method: 'POST' });
      load();
    } catch (err) { console.error(err); }
  }

  function syncModelFilter(models) {
    const sel = document.getElementById('logModel');
    const desired = '<option value="">All models</option>' + models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
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
    document.getElementById('logModal').style.display = 'none';
  }

  async function showLogDetail(id) {
    try {
      const l = await api('/api/admin/logs/' + id);
      currentLog = l;
      document.getElementById('logModalTitle').innerHTML = `Log #${l.id} ${resultTag(l)}`;
      const summary = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;
      document.getElementById('logModalBody').innerHTML = `
        <dl class="log-summary">
          ${summary('Time', new Date(Number(l.created_at)).toLocaleString())}
          ${summary('Model', `<strong>${esc(l.model)}</strong>`)}
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

  function showPanel(name, tabEl, updateHash = true) {
    const validTabs = ['overview', 'gemini-keys', 'client-keys', 'request-logs', 'statistics'];
    if (!validTabs.includes(name)) name = 'overview';

    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

    const targetPanel = document.getElementById('panel-' + name);
    if (targetPanel) targetPanel.classList.add('active');

    const targetTab = tabEl || document.querySelector(`.nav-tab[data-tab="${name}"]`);
    if (targetTab) targetTab.classList.add('active');

    localStorage.setItem('ai_studio_proxy_tab', name);
    if (updateHash && window.location.hash !== '#' + name) {
      history.replaceState(null, '', '#' + name);
    }
    void load();
  }

  function initActiveTab() {
    const hash = window.location.hash.replace(/^#/, '');
    const saved = localStorage.getItem('ai_studio_proxy_tab');
    const initial = hash || saved || 'overview';
    showPanel(initial, null, true);
  }

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace(/^#/, '');
    if (hash) showPanel(hash, null, false);
  });

  async function load() {
    const active = document.querySelector('.panel.active')?.id.replace('panel-', '') || 'overview';
    if (active === 'request-logs') return loadLogs(false);
    if (active === 'statistics') return loadUsage();
    try {
      const data = await api('/api/admin/state');
      window.__lastState = data;
      render(data);
      if (active === 'gemini-keys' || active === 'client-keys') await loadPageUsage(active);
    } catch (e) { console.error(e); }
  }

  let pageUsage = null;
  async function loadPageUsage(panel) {
    const active = panel || document.querySelector('.panel.active')?.id.replace('panel-', '') || 'gemini-keys';
    const isClient = active === 'client-keys';
    const query = usageQuery(
      isClient ? 'clientPeriod' : 'geminiPeriod',
      isClient ? 'clientMonth' : 'geminiMonth'
    );
    try {
      const usage = await api('/api/admin/usage' + query + '&view=' + (isClient ? 'clients' : 'gemini'));
      pageUsage = { ...(pageUsage || {}), ...usage };
      renderPageUsage();
    } catch (e) { console.error(e); }
  }

  function usageQuery(selId, monthId) {
    const mode = document.getElementById(selId)?.value || '30d';
    const month = document.getElementById(monthId)?.value || '';
    if (mode === 'month') return '?period=30d&month=' + (month || pacificNowMonth());
    return '?period=' + mode;
  }

  function pacificNowMonth() {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' })
      .formatToParts(new Date()).reduce((acc, p) => acc + (p.type === 'year' ? p.value : p.type === 'month' ? '-' + p.value : ''), '');
  }

  function statsPeriodChanged() {
    document.getElementById('statsMonthWrap').style.display = document.getElementById('statsPeriod').value === 'month' ? 'flex' : 'none';
    loadUsage();
  }

  function keyPeriodChanged() {
    loadPageUsage().then(() => {
      const s = window.__lastState;
      if (s) render(s);
    });
  }

  function usageFor(list, id) {
    const row = (list || []).find(x => x.id === id);
    return row || { total: 0, success: 0, failed: 0 };
  }

  function pct(success, total) {
    return total ? Math.round(100 * success / total) + '%' : '—';
  }

  function renderPageUsage() {
    if (!pageUsage || !window.__lastState) return;
    const g = pageUsage.keys || [];
    const c = pageUsage.clients || [];
    document.querySelectorAll('#keysTbody tr[data-key-id]').forEach(tr => {
      const u = usageFor(g, Number(tr.dataset.keyId));
      tr.querySelector('.u-total').textContent = u.total;
      tr.querySelector('.u-success').textContent = u.success;
      tr.querySelector('.u-pct').textContent = pct(u.success, u.total);
    });
    document.querySelectorAll('#clientKeysTbody tr[data-key-id]').forEach(tr => {
      const u = usageFor(c, Number(tr.dataset.keyId));
      tr.querySelector('.u-total').textContent = u.total;
      tr.querySelector('.u-success').textContent = u.success;
      tr.querySelector('.u-pct').textContent = pct(u.success, u.total);
    });
    buildMatrix('cmMatrixHead', 'cmMatrixBody', (pageUsage.matrix_client || []).filter(e => !String(e.label).startsWith('(deleted)')));
  }

  function buildMatrix(headId, bodyId, entries) {
    const headEl = document.getElementById(headId);
    const bodyEl = document.getElementById(bodyId);
    if (!entries.length) {
      headEl.innerHTML = '';
      bodyEl.innerHTML = '<tr><td colspan="2" class="empty-notice">No requests recorded in this period.</td></tr>';
      return;
    }
    const rowLabels = [...new Set(entries.map(e => e.model))].sort();
    const colLabels = [...new Set(entries.map(e => e.label))];
    const lookup = {};
    entries.forEach(e => { lookup[e.model + '||' + e.label] = e.total; });
    headEl.innerHTML = '<tr><th>Model</th>' +
      colLabels.map(c => `<th title="${esc(c)}">${esc(c.length > 18 ? c.slice(0, 17) + '…' : c)}</th>`).join('') + '</tr>';
    bodyEl.innerHTML = rowLabels.map(r =>
      '<tr><th title="' + esc(r) + '">' + esc(r.length > 28 ? r.slice(0, 27) + '…' : r) + '</th>' +
      colLabels.map(c => `<td class="num">${lookup[r + '||' + c] || '·'}</td>`).join('') + '</tr>'
    ).join('');
  }

  async function loadUsage() {
    try {
      const d = await api('/api/admin/usage' + usageQuery('statsPeriod', 'statsMonth') + '&view=statistics');
      document.getElementById('usageMeta').textContent = d.period;
      const failsByModel = {};
      for (const f of d.failures_model || []) (failsByModel[f.model] ||= []).push(f);
      const rows = d.models || [];
      document.getElementById('usageModelsTbody').innerHTML = rows.length ? rows.map(m => {
        const reasons = (failsByModel[m.model] || [])
          .map(f => `<span class="status-tag tag-off" style="margin:2px" title="${esc(f.code)}">${esc(f.code)} &times;${f.n}</span>`).join(' ') || '—';
        return `<tr><td><strong>${esc(m.model)}</strong></td><td>${m.total}</td><td>${m.success}</td><td>${m.failed}</td><td>${reasons}</td></tr>`;
      }).join('') : '<tr><td colspan="5" class="empty-notice">No requests recorded in this period.</td></tr>';
    } catch (err) { console.error(err); }
  }

  async function refreshModels() {
    const btn = document.getElementById('refreshModelsBtn');
    const statusEl = document.getElementById('cacheStatus');
    btn.disabled = true;
    btn.textContent = 'Refreshing...';
    statusEl.textContent = ' (refreshing...)';
    statusEl.style.color = 'var(--amber)';
    try {
      await api('/api/admin/models/refresh', { method: 'POST' });
      load();
    } catch (err) {
      alert(err.message);
      statusEl.textContent = ' (error)';
      statusEl.style.color = 'var(--rose)';
    }
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }

  async function doDeleteKey(type, id) {
    if (!confirm(type === 'client' ? 'Delete this client key?' : 'Delete this Gemini API key?')) return;
    try {
      await api('/api/admin/' + (type === 'client' ? 'client-keys' : 'keys') + '/' + id, { method: 'DELETE' });
      closeKeyModal();
      load();
    } catch (err) { alert(err.message); }
  }

  function openKeyModal(type, id, label, masked) {
    const isClient = type === 'client';
    document.getElementById('keyModalTitle').textContent = (isClient ? 'Client Key' : 'Gemini Key') + ' — ' + label;
    document.getElementById('keyModalBody').innerHTML = `
      <div class="log-summary" style="grid-template-columns:auto 1fr">
        <dt>Label</dt><dd><strong>${esc(label)}</strong></dd>
        <dt>Key</dt><dd><code style="font-family:'JetBrains Mono',monospace">${esc(masked)}</code></dd>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
        <button type="button" class="btn-tbl" onclick="openEditKey(${isClient}, ${id})">Edit</button>
        ${isClient ? `<button type="button" class="btn-tbl" onclick="copyClientKey(${id}, this)">Copy Key</button>` : ''}
        <button type="button" class="btn-tbl btn-tbl-danger" onclick="doDeleteKey('${type}', ${id})">Delete</button>
      </div>`;
    document.getElementById('keyModal').style.display = 'flex';
  }

  function openEditKey(isClient, id) {
    const currentLabel = document.getElementById('keyModalTitle').textContent.replace(/^(Client Key|Gemini Key) — /, '');
    document.getElementById('keyModalBody').innerHTML = `
      <label class="field-label">Label</label>
      <input type="text" id="editKeyLabel" class="form-input" value="${esc(currentLabel)}" style="width:100%;margin-bottom:12px">
      <label class="field-label">${isClient ? 'Regenerate key (leave blank to keep)' : 'Key (leave blank to keep)'}</label>
      ${isClient
        ? `<input type="text" id="editKeyValue" class="form-input" placeholder="Generates a new random key" style="width:100%;margin-bottom:12px">`
        : `<input type="text" id="editKeyValue" class="form-input" placeholder="Paste a new Gemini API key" style="width:100%;margin-bottom:12px">`}
      <div style="display:flex;gap:8px;margin-top:6px">
        <button type="button" class="btn-tbl" onclick="saveEditKey(${isClient}, ${id})">Save</button>
        <button type="button" class="btn-tbl" onclick="openKeyModal(${isClient ? "'client'" : "'gemini'"}, ${id}, '${esc(currentLabel)}', '')">Cancel</button>
      </div>`;
    document.getElementById('keyModalTitle').textContent = isClient ? 'Edit Client Key' : 'Edit Gemini Key';
  }

  async function saveEditKey(isClient, id) {
    const label = document.getElementById('editKeyLabel').value.trim();
    const keyVal = document.getElementById('editKeyValue').value.trim();
    if (!label) { alert('Label cannot be empty'); return; }
    try {
      const body = { label };
      if (keyVal) body.key = keyVal;
      const res = await api('/api/admin/' + (isClient ? 'client-keys' : 'keys') + '/' + id, { method: 'PATCH', body: JSON.stringify(body) });
      closeKeyModal();
      if (isClient && res.clientApiKey) showClientKey(res.clientApiKey);
      load();
    } catch (err) { alert(err.message); }
  }

  async function copyClientKey(id, button) {
    try {
      const res = await api('/api/admin/client-keys/' + id);
      if (res.key) { copyText(res.key, button); return; }
      alert('No key available to copy');
    } catch (err) { alert(err.message); }
  }

  function closeKeyModal() { document.getElementById('keyModal').style.display = 'none'; }

  document.addEventListener('click', (e) => {
    const row = e.target.closest('.key-row');
    if (!row) return;
    const id = Number(row.dataset.keyId);
    const type = row.dataset.keyType;
    const label = row.querySelector('td strong')?.textContent || '';
    const masked = row.querySelector('td code')?.textContent || '';
    openKeyModal(type, id, label, masked);
  });
  async function logout() { await fetch('/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf() } }); location.href = '/'; }

  async function injectPanels() {
    const panels = ['overview', 'gemini-keys', 'client-keys', 'request-logs', 'statistics'];
    await Promise.all(panels.map(async (name) => {
      const res = await fetch('/panels/' + name + '.html');
      const html = await res.text();
      const el = document.getElementById('panel-' + name);
      if (el) el.innerHTML = html;
    }));
  }

  (async () => {
    await injectPanels();
    initUsageColumnFocus();
  document.getElementById('clientKeyForm').onsubmit = async (event) => {
    event.preventDefault();
    try {
      const form = new FormData(event.target);
      const data = await api('/api/admin/client-keys', { method: 'POST', body: JSON.stringify({ label: form.get('label') }) });
      showClientKey(data.clientApiKey);
      event.target.reset();
      showPanel('client-keys');
    } catch (err) { alert(err.message); }
  };

  document.getElementById('keyForm').onsubmit = async (event) => {
    event.preventDefault();
    const resultDiv = document.getElementById('keyImportResult');
    try {
      const form = new FormData(event.target);
      const raw = (form.get('key') || '').trim();
      const keys = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      if (!keys.length) { alert('Please enter at least one API key'); return; }
      if (keys.length === 1) {
        await api('/api/admin/keys', { method: 'POST', body: JSON.stringify({ label: form.get('label'), key: keys[0] }) });
        event.target.reset();
        showPanel('gemini-keys');
        return;
      }
      const data = await api('/api/admin/keys', { method: 'POST', body: JSON.stringify({ keys }) });
      event.target.querySelector('[name=key]').value = '';
      event.target.querySelector('[name=label]').value = '';
      const lines = [];
      if (data.added) lines.push(`<b>${data.added}</b> key(s) added`);
      if (data.skipped) lines.push(`<b>${data.skipped}</b> skipped (duplicates or empty)`);
      if (data.results) {
        const added = data.results.filter((r) => r.status === 'added');
        if (added.length) lines.push(added.map((r) => `${r.label}: ${r.key}`).join('<br>'));
      }
      resultDiv.innerHTML = lines.join('<br>');
      resultDiv.style.display = 'block';
      load();
    } catch (err) { alert(err.message); resultDiv.style.display = 'none'; }
  };

    initActiveTab();
    const POLL_MS = 5000;
    setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLogModal(); });
  })();
