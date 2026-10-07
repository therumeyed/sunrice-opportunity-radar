(() => {
  const qs = (sel) => document.querySelector(sel);

  const state = {
    date: null, // null = latest
    filters: { theme: '', audience: '', state: '' },
    historyMonth: new Date(),
    reportDates: new Set(),
    currentBundle: null
  };

  function readUrl() {
    const params = new URLSearchParams(location.search);
    state.date = params.get('date') || null;
    state.filters.theme = params.get('theme') || '';
    state.filters.audience = params.get('audience') || '';
    state.filters.state = params.get('state') || '';
  }

  function writeUrl() {
    const params = new URLSearchParams();
    if (state.date) params.set('date', state.date);
    if (state.filters.theme) params.set('theme', state.filters.theme);
    if (state.filters.audience) params.set('audience', state.filters.audience);
    if (state.filters.state) params.set('state', state.filters.state);
    const qsStr = params.toString();
    history.replaceState(null, '', qsStr ? `?${qsStr}` : location.pathname);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  function fmtDateTime(iso) {
    if (!iso) return 'unknown';
    return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function statusTagClass(status) {
    if (status === 'live') return '';
    if (status === 'cached' || status === 'imported') return 'cached';
    return 'bad';
  }

  function statusLabel(status) {
    return { live: 'Live', cached: 'Cached', imported: 'Imported', awaiting_connection: 'Awaiting connection', failed: 'Failed' }[status] || status;
  }

  // --- Meta / filters -----------------------------------------------
  async function loadMeta() {
    const res = await fetch('/api/meta');
    const meta = await res.json();
    const themeSel = qs('#bd-filter-theme');
    for (const t of meta.themes) themeSel.insertAdjacentHTML('beforeend', `<option value="${t.value}">${escapeHtml(t.label)}</option>`);
    const audSel = qs('#bd-filter-audience');
    for (const a of meta.audiences) audSel.insertAdjacentHTML('beforeend', `<option value="${a}">${escapeHtml(a)}</option>`);
    const stateSel = qs('#bd-filter-state');
    for (const s of meta.states) stateSel.insertAdjacentHTML('beforeend', `<option value="${s}">${escapeHtml(s)}</option>`);

    themeSel.value = state.filters.theme;
    audSel.value = state.filters.audience;
    stateSel.value = state.filters.state;

    themeSel.addEventListener('change', () => { state.filters.theme = themeSel.value; writeUrl(); loadReport(); });
    audSel.addEventListener('change', () => { state.filters.audience = audSel.value; writeUrl(); loadReport(); });
    stateSel.addEventListener('change', () => { state.filters.state = stateSel.value; writeUrl(); loadReport(); });
  }

  // --- Report loading --------------------------------------------------
  async function loadReport() {
    const params = new URLSearchParams();
    if (state.filters.theme) params.set('theme', state.filters.theme);
    if (state.filters.audience) params.set('audience', state.filters.audience);
    if (state.filters.state) params.set('state', state.filters.state);
    const path = state.date ? `/api/reports/${state.date}` : '/api/reports/latest';
    const res = await fetch(`${path}?${params.toString()}`);
    if (!res.ok) {
      renderNoReport();
      return;
    }
    const bundle = await res.json();
    state.currentBundle = bundle;
    state.date = bundle.report.date;
    writeUrl();
    render(bundle);
  }

  function renderNoReport() {
    qs('#bd-report-date').textContent = 'No completed report for this date yet';
    qs('#bd-priorities').innerHTML = `<p class="bd-empty-hero">Nothing to show. Run ingestion, or pick a different date from History.</p>`;
    qs('#bd-search-bars').innerHTML = '<div class="bd-empty">No data</div>';
    qs('#bd-search-nuggets').innerHTML = '<div class="bd-empty">No data</div>';
    qs('#bd-social-list').innerHTML = '<div class="bd-empty">No data</div>';
    qs('#bd-updated-status').textContent = '';
  }

  function render(bundle) {
    qs('#bd-report-date').textContent = `${fmtDate(bundle.report.date)} · National view`;
    qs('#bd-updated-status').textContent = bundle.report.generatedAt ? `Updated ${fmtDateTime(bundle.report.generatedAt)}` : '';
    renderPriorities(bundle.recommendations);
    renderSearchDemand(bundle.signals.filter((s) => s.signalType === 'search_topic'));
    renderSocialSignals(bundle.signals.filter((s) => s.signalType === 'social_topic'));
  }

  function renderPriorities(recommendations) {
    const el = qs('#bd-priorities');
    if (recommendations.length === 0) {
      el.innerHTML = `<p class="bd-empty-hero">No recommendation cleared the bar today under the current filters -- widen the filters, or there just wasn't enough evidence yet.</p>`;
      return;
    }
    el.innerHTML = recommendations.map((r, i) => `
      <article class="bd-priority">
        <div class="bd-priority-no">0${i + 1} · ${r.actionType.toUpperCase()}</div>
        <h3>${escapeHtml(r.title)}</h3>
        <p>${escapeHtml(r.rationale)}</p>
        <div class="bd-priority-meta">
          <span class="bd-pill">${escapeHtml(r.state || 'National')} · ${escapeHtml(r.audience || 'General')} · ${escapeHtml(r.confidence.replace('_', ' '))}</span>
          <button class="bd-proof" type="button" data-rec-id="${r.id}">View evidence &rarr;</button>
        </div>
      </article>
    `).join('');
    el.querySelectorAll('[data-rec-id]').forEach((btn) => btn.addEventListener('click', () => openEvidence(btn.dataset.recId)));
  }

  // DataForSEO normalizes each topic's regional interest against its own
  // 0-100 scale -- one topic's 100 and another's 100 mean nothing in
  // relation to each other. This renders exactly one topic's bars at a
  // time (picked from the dropdown), never a flattened mix of several.
  function renderSearchBars(signal) {
    const bars = qs('#bd-search-bars');
    const regions = signal?.metricSummary?.interestByRegion || [];
    if (regions.length === 0) {
      bars.innerHTML = '<div class="bd-empty">No regional breakdown returned for this topic.</div>';
      return;
    }
    const max = Math.max(...regions.map((r) => r.value), 1);
    bars.innerHTML = regions.slice(0, 8).map((r) => `
      <div class="bd-bar-row">
        <span>${escapeHtml(r.region)}</span>
        <div class="bd-track"><div class="bd-fill" style="width:${Math.round((r.value / max) * 100)}%"></div></div>
        <span>${r.value}</span>
      </div>
    `).join('');
  }

  function renderSearchDemand(searchSignals) {
    const tag = qs('#bd-search-tag');
    const bars = qs('#bd-search-bars');
    const nuggets = qs('#bd-search-nuggets');
    const select = qs('#bd-search-topic-select');
    if (searchSignals.length === 0) {
      tag.textContent = 'Awaiting connection';
      tag.className = 'bd-source-tag bad';
      select.innerHTML = '';
      bars.innerHTML = '<div class="bd-empty">No search-demand data for the current filters. DataForSEO may not be connected yet -- check Source health.</div>';
      nuggets.innerHTML = '<div class="bd-empty">No data</div>';
      return;
    }
    tag.textContent = `DataForSEO · ${statusLabel(searchSignals[0].dataStatus)}`;
    tag.className = `bd-source-tag ${statusTagClass(searchSignals[0].dataStatus)}`;

    select.innerHTML = searchSignals.map((s, i) => `<option value="${i}">${escapeHtml(s.topic)}</option>`).join('');
    select.onchange = () => renderSearchBars(searchSignals[Number(select.value)]);
    renderSearchBars(searchSignals[0]);

    const rising = searchSignals.flatMap((s) => (s.metricSummary?.risingQueries || []).map((q) => ({ ...q, topic: s.topic })));
    nuggets.innerHTML = rising.length === 0
      ? '<div class="bd-empty">No rising queries returned yet.</div>'
      : rising.slice(0, 6).map((q) => `
        <div class="bd-nugget">
          <div><strong>${escapeHtml(q.query)}</strong><span>Related to "${escapeHtml(q.topic)}"</span></div>
          <div class="bd-rise">${q.value != null ? escapeHtml(String(q.value)) : 'Breakout'}</div>
        </div>
      `).join('');
  }

  function renderSocialSignals(socialSignals) {
    const el = qs('#bd-social-list');
    if (socialSignals.length === 0) {
      el.innerHTML = '<div class="bd-empty">No social signals for the current filters. Check Source health if this looks wrong.</div>';
      return;
    }
    el.innerHTML = socialSignals.map((s, i) => `
      <div class="bd-signal">
        <div class="bd-rank">0${i + 1}</div>
        <div><strong>${escapeHtml(s.topic)}</strong><p>${s.metricSummary?.matchingPosts ?? 0} matching post${(s.metricSummary?.matchingPosts ?? 0) === 1 ? '' : 's'}</p></div>
        <div><p>${s.lifecycle ? `Lifecycle: ${escapeHtml(s.lifecycle)}` : ''} ${s.momentum ? `· momentum ${escapeHtml(s.momentum)}` : ''}</p></div>
        <div class="bd-platform">${escapeHtml(s.platform || '')}</div>
        ${s.metricSummary?.exampleUrl ? `<a class="bd-link" href="${escapeHtml(s.metricSummary.exampleUrl)}" target="_blank" rel="noopener">Example &#8599;</a>` : '<span></span>'}
      </div>
    `).join('');
  }


  // --- Evidence drawer --------------------------------------------------
  function openEvidence(recId) {
    const rec = state.currentBundle?.recommendations.find((r) => String(r.id) === String(recId));
    if (!rec) return;
    qs('#bd-proof-title').textContent = rec.title;
    qs('#bd-proof-summary').textContent = rec.rationale;
    qs('#bd-proof-scores').innerHTML = Object.entries(rec.scoreComponents).map(([k, v]) =>
      `<span>${escapeHtml(k)}</span><span>${Math.round(v * 100)}%</span>`
    ).join('') + `<span>Total score</span><span>${rec.score}/100</span>`;

    const evEl = qs('#bd-proof-evidence');
    if (rec.evidence.length === 0) {
      evEl.innerHTML = '<div class="bd-evidence"><p>No evidence rows linked -- this should not happen; treat this recommendation as unverified.</p></div>';
    } else {
      evEl.innerHTML = rec.evidence.map((e) => `
        <div class="bd-evidence">
          <small>${escapeHtml(e.sourceName)} · ${escapeHtml(statusLabel(e.dataStatus))} · COLLECTED ${escapeHtml(fmtDateTime(e.collectedAt))}</small>
          <strong>${escapeHtml(e.title || e.queryOrTopic || 'Untitled')}</strong>
          <p>${escapeHtml((e.excerpt || '').slice(0, 240))}</p>
          <p style="font-size:10px;">${e.publishedAt ? `Published ${escapeHtml(fmtDateTime(e.publishedAt))} · ` : ''}${e.author ? `by ${escapeHtml(e.author)}` : ''}</p>
          ${e.sourceUrl ? `<a class="bd-link" href="${escapeHtml(e.sourceUrl)}" target="_blank" rel="noopener">Open original &rarr;</a>` : ''}
        </div>
      `).join('');
    }

    qs('#bd-proof-scrim').hidden = false;
    qs('#bd-proof-close').focus();
  }

  function closeEvidence() {
    qs('#bd-proof-scrim').hidden = true;
  }

  // --- History popover ----------------------------------------------
  async function loadHistoryMonth() {
    const y = state.historyMonth.getFullYear();
    const m = state.historyMonth.getMonth();
    const from = new Date(y, m, 1).toISOString().slice(0, 10);
    const to = new Date(y, m + 1, 0).toISOString().slice(0, 10);
    const res = await fetch(`/api/reports/dates?from=${from}&to=${to}`);
    const data = await res.json();
    state.reportDates = new Set(data.dates);
    renderHistoryCalendar();
  }

  function renderHistoryCalendar() {
    const y = state.historyMonth.getFullYear();
    const m = state.historyMonth.getMonth();
    qs('#bd-history-month').textContent = state.historyMonth.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

    const firstDay = new Date(y, m, 1);
    const startOffset = (firstDay.getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const todayStr = new Date().toISOString().slice(0, 10);

    let html = '';
    for (let i = 0; i < startOffset; i++) html += '<button class="bd-day" type="button" disabled></button>';
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const has = state.reportDates.has(dateStr);
      const classes = ['bd-day'];
      if (has) classes.push('has');
      if (dateStr === state.date) classes.push('selected');
      html += `<button class="${classes.join(' ')}" type="button" ${has ? '' : 'disabled'} data-date="${dateStr}">${d}${dateStr === todayStr ? ' ·' : ''}</button>`;
    }
    qs('#bd-history-days').innerHTML = html;
    qs('#bd-history-days').querySelectorAll('.bd-day.has').forEach((btn) => btn.addEventListener('click', () => {
      state.date = btn.dataset.date;
      closeHistory();
      loadReport();
    }));
  }

  function openHistory() {
    const popover = qs('#bd-history-popover');
    popover.hidden = false;
    qs('#bd-history-button').setAttribute('aria-expanded', 'true');
    loadHistoryMonth();
    popover.querySelector('button').focus();
  }

  function closeHistory(returnFocus = true) {
    qs('#bd-history-popover').hidden = true;
    qs('#bd-history-button').setAttribute('aria-expanded', 'false');
    if (returnFocus) qs('#bd-history-button').focus();
  }

  // --- Nav ------------------------------------------------------------
  function setupNav() {
    document.querySelectorAll('#bd-nav button[data-view]').forEach((btn) => btn.addEventListener('click', () => {
      document.querySelectorAll('#bd-nav button[data-view]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      const view = btn.dataset.view;
      qs('#bd-view-today').hidden = view !== 'today';
    }));
  }

  // --- Refresh (admin) --------------------------------------------------
  function setupRefresh() {
    qs('#bd-refresh-button').addEventListener('click', async () => {
      const token = window.prompt('Admin token to trigger a refresh:');
      if (!token) return;
      const res = await fetch('/admin/refresh', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        alert('Refresh started. This can take several minutes -- reload later to see the new report.');
      } else {
        alert('Refresh failed to start -- check the token.');
      }
    });
  }

  function setupEvents() {
    qs('#bd-history-button').addEventListener('click', () => qs('#bd-history-popover').hidden ? openHistory() : closeHistory());
    qs('#bd-history-close').addEventListener('click', () => closeHistory());
    qs('#bd-history-prev').addEventListener('click', () => { state.historyMonth.setMonth(state.historyMonth.getMonth() - 1); loadHistoryMonth(); });
    qs('#bd-history-next').addEventListener('click', () => { state.historyMonth.setMonth(state.historyMonth.getMonth() + 1); loadHistoryMonth(); });
    qs('#bd-proof-close').addEventListener('click', closeEvidence);
    qs('#bd-proof-scrim').addEventListener('click', (e) => { if (e.target.id === 'bd-proof-scrim') closeEvidence(); });

    document.addEventListener('click', (e) => {
      const popover = qs('#bd-history-popover');
      const button = qs('#bd-history-button');
      if (!popover.hidden && !popover.contains(e.target) && !button.contains(e.target)) closeHistory(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!qs('#bd-history-popover').hidden) closeHistory();
      if (!qs('#bd-proof-scrim').hidden) { closeEvidence(); qs('#bd-refresh-button').blur(); }
    });
  }

  async function init() {
    readUrl();
    setupNav();
    setupEvents();
    setupRefresh();
    await loadMeta();
    await loadReport();
  }

  init();
})();
