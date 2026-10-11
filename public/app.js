(() => {
  const qs = (sel) => document.querySelector(sel);

  const state = {
    date: null, // null = latest
    filters: { theme: '', audience: '', state: '' },
    historyMonth: new Date(),
    reportDates: new Set(),
    currentBundle: null,
    themeLabels: {},
    feedbackReasons: null
  };

  // Session-scoped editor token, same UX as the existing ADMIN_TOKEN prompt
  // (browser prompt(), Bearer header, sessionStorage) -- never written into
  // the report JSON or any source file. A separate token from ADMIN_TOKEN:
  // feedback is a distinct, lower-risk write than triggering a paid ingest run.
  function getEditorToken() {
    let token = sessionStorage.getItem('bd-editor-token');
    if (!token) {
      token = window.prompt('Editor token to record feedback:');
      if (token) sessionStorage.setItem('bd-editor-token', token);
    }
    return token;
  }
  function clearEditorToken() {
    sessionStorage.removeItem('bd-editor-token');
  }

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
    for (const t of meta.themes) {
      themeSel.insertAdjacentHTML('beforeend', `<option value="${t.value}">${escapeHtml(t.label)}</option>`);
      state.themeLabels[t.value] = t.label;
    }
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
    qs('#bd-emerging-list').innerHTML = '<div class="bd-empty">No data</div>';
    qs('#bd-theme-trends').innerHTML = '<div class="bd-empty">No data</div>';
    qs('#bd-search-bars').innerHTML = '<div class="bd-empty">No data</div>';
    qs('#bd-search-nuggets').innerHTML = '<div class="bd-empty">No data</div>';
    qs('#bd-social-list').innerHTML = '<div class="bd-empty">No data</div>';
    qs('#bd-updated-status').textContent = '';
  }

  function render(bundle) {
    qs('#bd-report-date').textContent = `${fmtDate(bundle.report.date)} · National view`;
    qs('#bd-updated-status').textContent = bundle.report.generatedAt ? `Updated ${fmtDateTime(bundle.report.generatedAt)}` : '';
    renderPriorities(bundle.recommendations, bundle.report);
    renderEmerging(bundle.microtrendsEmerging || []);
    renderThemeTrends(bundle.themeTrends || []);
    renderSearchDemand(bundle.signals.filter((s) => s.signalType === 'search_topic'));
    renderSocialSignals(bundle.signals.filter((s) => s.signalType === 'social_topic'));
  }

  // Deterministic cross-source corroboration, not an LLM claim -- computed
  // in reportBuilder.js from each source's own rising/growing definition.
  const MOMENTUM_LABELS = { google_trends: 'Google Trends', pinterest: 'Pinterest' };
  function momentumBadge(sources) {
    if (!sources || sources.length === 0) return '';
    const label = sources.map((s) => MOMENTUM_LABELS[s] || s).join(' + ');
    const word = sources.length > 1 ? 'Rising across' : 'Rising on';
    return `<span class="bd-source-tag" style="display:inline-block;margin-bottom:8px;">${word} ${escapeHtml(label)}</span>`;
  }

  // Deterministic, computed in reportBuilder.js/continuity.js from real
  // stored history -- never the LLM's own guess at continuity.
  const CONTINUITY_LABELS = {
    new: 'New', continuing: 'Continuing', strengthening: 'Strengthening',
    weakening: 'Weakening', new_angle: 'New angle', repeat_action: 'Repeated action'
  };
  function continuityBadge(status) {
    if (!status || !CONTINUITY_LABELS[status]) return '';
    return `<span class="bd-continuity ${escapeHtml(status)}">${escapeHtml(CONTINUITY_LABELS[status])}</span>`;
  }

  // Purely informational -- tells the reader WHERE today's idea came from
  // (a specific Claude-analyzed candidate vs. a compliance disclaimer
  // needing human review), never affects ranking or wording of the ask.
  const KIND_LABELS = { candidate: 'Evidence-backed idea', theme_disclaimer: 'Needs human review' };
  function kindBadge(kind) {
    if (!kind || !KIND_LABELS[kind]) return '';
    return `<span class="bd-kind-badge ${escapeHtml(kind)}">${escapeHtml(KIND_LABELS[kind])}</span>`;
  }

  // Claude's candidate analysis is mandatory for a recommendation to exist
  // (see src/reportBuilder.js) -- when it's unavailable, zero
  // recommendations looks IDENTICAL to a day where AI ran fine and
  // genuinely found nothing worth recommending, unless this is shown
  // explicitly. report.aiAnalysisAvailable is null for an old report that
  // predates this pipeline, in which case there's nothing meaningful to say.
  function renderPriorities(recommendations, report) {
    const el = qs('#bd-priorities');
    if (recommendations.length === 0 && report?.aiAnalysisAvailable === false) {
      el.innerHTML = `
        <div class="bd-ai-unavailable">
          <strong>AI analysis unavailable today</strong>
          <p>Claude's candidate analysis is required before any recommendation can be shown -- it didn't run successfully today, so there are none. Real signals and theme history below are unaffected.</p>
          ${report.aiAnalysisReason ? `<p class="bd-ai-unavailable-reason">${escapeHtml(report.aiAnalysisReason)}</p>` : ''}
        </div>`;
      return;
    }
    if (recommendations.length === 0) {
      el.innerHTML = `<p class="bd-empty-hero">No recommendation cleared the bar today under the current filters -- widen the filters, or there just wasn't enough evidence yet.</p>`;
      return;
    }
    el.innerHTML = recommendations.map((r, i) => {
      const categoryLabel = state.themeLabels[r.theme] || r.theme;
      const changeNote = r.continuityMeta?.changeSincePrevious;
      return `
      <article class="bd-priority">
        <div class="bd-priority-no">0${i + 1} · ${r.actionType.toUpperCase()}</div>
        ${kindBadge(r.recommendationKind)}
        <h3>${escapeHtml(r.opportunityName || r.title)}</h3>
        <div class="bd-pill" style="display:inline-block;margin-bottom:6px;">${escapeHtml(categoryLabel)}</div>
        ${continuityBadge(r.continuityStatus)}
        ${momentumBadge(r.momentumSources)}
        <p>${escapeHtml(r.rationale)}</p>
        ${r.recommendedAction ? `<p class="bd-change-note" style="font-style:normal;"><strong>Do this:</strong> ${escapeHtml(r.recommendedAction)}</p>` : ''}
        ${changeNote ? `<p class="bd-change-note">${escapeHtml(changeNote)}</p>` : ''}
        ${r.continuityMeta?.appearances14d ? `<p class="bd-change-note">Recommended ${r.continuityMeta.appearances14d} time${r.continuityMeta.appearances14d === 1 ? '' : 's'} in the last 14 days${r.continuityMeta.previousRecommendationDate ? `, last on ${escapeHtml(r.continuityMeta.previousRecommendationDate)}` : ''}.</p>` : ''}
        <div class="bd-priority-meta">
          <span class="bd-pill">${escapeHtml(r.state || 'National')} · ${escapeHtml(r.audience || 'General')} · ${escapeHtml(r.confidence.replace('_', ' '))}</span>
          <button class="bd-proof" type="button" data-rec-id="${r.id}">View evidence &rarr;</button>
        </div>
        <div class="bd-feedback-row">
          <button class="bd-feedback-btn" type="button" data-feedback-rec="${r.id}" data-feedback-type="useful">Useful</button>
          <button class="bd-feedback-btn" type="button" data-feedback-rec="${r.id}" data-feedback-type="already_covered">Already covered</button>
          <button class="bd-feedback-btn" type="button" data-feedback-rec="${r.id}" data-feedback-type="not_relevant">Not relevant</button>
          <button class="bd-feedback-btn" type="button" data-feedback-rec="${r.id}" data-feedback-type="dont_show_again">Don't show again</button>
        </div>
      </article>
    `;
    }).join('');
    el.querySelectorAll('[data-rec-id]').forEach((btn) => btn.addEventListener('click', () => openEvidence(btn.dataset.recId)));
    el.querySelectorAll('[data-feedback-rec]').forEach((btn) => btn.addEventListener('click', () => openFeedbackForm(btn.dataset.feedbackRec, btn.dataset.feedbackType)));
  }

  // --- "What's emerging" (brief: between "today's priorities" and theme
  // momentum) -- real microtrends tracked today that haven't won a slot,
  // sorted purely by their own deterministic score.
  function renderEmerging(microtrends) {
    const el = qs('#bd-emerging-list');
    if (microtrends.length === 0) {
      el.innerHTML = '<div class="bd-empty">Nothing new emerging right now under the current filters.</div>';
      return;
    }
    el.innerHTML = microtrends.slice(0, 12).map((m) => `
      <div class="bd-emerging-card">
        <div class="bd-emerging-top">
          <h4>${escapeHtml(m.displayName)}</h4>
          <span class="bd-candidate-type ${escapeHtml(m.candidateType)}">${escapeHtml(m.candidateType)}</span>
        </div>
        <div class="bd-emerging-meta">
          ${escapeHtml(m.label)} · score <strong>${m.score != null ? Math.round(m.score) : '—'}</strong> · ${m.todayEvidenceCount} evidence item${m.todayEvidenceCount === 1 ? '' : 's'}
        </div>
      </div>
    `).join('');
  }

  const LIFECYCLE_LABELS = {
    new: 'New', validating: 'Validating', building: 'Building',
    sustained: 'Sustained', cooling: 'Cooling', peaking: 'Peaking'
  };

  // Tiny inline SVG, no charting library -- just enough to see shape/
  // direction across up to 30 real daily scores. Flat line (single point
  // or all-equal scores) renders as a flat midline rather than dividing
  // by zero.
  function sparklineSvg(points) {
    if (!points || points.length < 2) return '';
    const scores = points.map((p) => p.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min || 1;
    const w = 100;
    const h = 24;
    const step = w / (points.length - 1);
    const coords = scores.map((s, i) => `${(i * step).toFixed(1)},${(h - ((s - min) / range) * h).toFixed(1)}`).join(' ');
    return `<svg class="bd-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    </svg>`;
  }

  // National theme momentum -- every active theme, not only today's top 3.
  // peakingEligible (from the API, itself from themeLifecycle.js) gates the
  // "insufficient history" message independently of whether today's shape
  // happens to match peaking -- a 3-day-old theme says "insufficient
  // history", never a mature-sounding lifecycle word it hasn't earned yet.
  function renderThemeTrends(themeTrends) {
    const el = qs('#bd-theme-trends');
    if (!themeTrends || themeTrends.length === 0) {
      el.innerHTML = '<div class="bd-empty">No themes with real evidence yet.</div>';
      return;
    }
    el.innerHTML = themeTrends.map((t) => {
      const lifecycleLabel = LIFECYCLE_LABELS[t.lifecycle] || t.lifecycle || '—';
      const sourceBadges = (t.sourceTypes || []).map((s) => `<span class="bd-theme-badge">${escapeHtml(s.replace('apify_', '').replace('dataforseo_trends', 'search').replace('google_news', 'news'))}</span>`).join('');
      const scoreChangeText = t.scoreChange == null ? '' : ` (${t.scoreChange > 0 ? '+' : ''}${t.scoreChange})`;
      return `
      <div class="bd-theme-card">
        <div class="bd-theme-card-top">
          <h4>${escapeHtml(t.label)}</h4>
          <span class="bd-lifecycle ${escapeHtml(t.lifecycle || '')}">${escapeHtml(lifecycleLabel)}</span>
        </div>
        <div class="bd-theme-meta">
          First seen ${escapeHtml(String(t.firstObservedDate).slice(0, 10))} · <strong>${t.observationCount}</strong> day${t.observationCount === 1 ? '' : 's'} of history · ${t.consecutiveActiveDays} consecutive active day${t.consecutiveActiveDays === 1 ? '' : 's'}<br>
          Score <strong>${t.latestScore}</strong>${scoreChangeText} · recommended ${t.appearances14d} time${t.appearances14d === 1 ? '' : 's'} (14d)${t.lastRecommendedDate ? ` · last ${escapeHtml(String(t.lastRecommendedDate).slice(0, 10))}` : ''}
        </div>
        ${sourceBadges ? `<div class="bd-theme-badges">${sourceBadges}</div>` : ''}
        ${!t.peakingEligible ? '<div class="bd-insufficient">Insufficient history to determine a peak</div>' : ''}
        ${sparklineSvg(t.sparkline)}
      </div>`;
    }).join('');
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
          <!-- A null value here means the source's own number was out of its
               documented range and was dropped (see sanitizeQueryValue) --
               showing "Breakout" would assert a specific classification the
               provider never actually supplied. "Rising" is the one thing
               that's actually true: it's in the rising-queries list. -->
          <div class="bd-rise">${q.value != null ? escapeHtml(String(q.value)) : 'Rising'}</div>
        </div>
      `).join('');
  }

  function renderSocialSignals(socialSignals) {
    const el = qs('#bd-social-list');
    if (socialSignals.length === 0) {
      el.innerHTML = '<div class="bd-empty">No social signals for the current filters. Check Source health if this looks wrong.</div>';
      return;
    }
    el.innerHTML = socialSignals.map((s, i) => {
      const count = s.metricSummary?.matchingPosts ?? 0;
      // Pinterest trend rows aren't posts -- itemLabel (set in
      // reportBuilder.js) says so explicitly rather than defaulting every
      // platform to "matching post".
      const itemLabel = s.metricSummary?.itemLabel || 'matching post';
      const itemLabelPlural = count === 1 ? itemLabel : `${itemLabel}s`;
      return `
      <div class="bd-signal">
        <div class="bd-rank">0${i + 1}</div>
        <div><strong>${escapeHtml(s.topic)}</strong><p>${count} ${escapeHtml(itemLabelPlural)}</p></div>
        <div><p>${s.lifecycle ? `Lifecycle: ${escapeHtml(s.lifecycle)}` : ''} ${s.momentum ? `· momentum ${escapeHtml(s.momentum)}` : ''}</p></div>
        <div class="bd-platform">${escapeHtml(s.platform || '')}</div>
        ${s.metricSummary?.exampleUrl ? `<a class="bd-link" href="${escapeHtml(s.metricSummary.exampleUrl)}" target="_blank" rel="noopener">Example &#8599;</a>` : '<span></span>'}
      </div>
    `;
    }).join('');
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

  // --- Feedback form ------------------------------------------------------
  const FEEDBACK_TYPE_LABELS = { useful: 'Useful', already_covered: 'Already covered', not_relevant: 'Not relevant', dont_show_again: "Don't show this idea again" };

  async function loadFeedbackReasons() {
    if (state.feedbackReasons) return state.feedbackReasons;
    const res = await fetch('/api/feedback/reasons');
    state.feedbackReasons = await res.json();
    return state.feedbackReasons;
  }

  async function openFeedbackForm(recId, feedbackType) {
    const reasonsData = await loadFeedbackReasons();
    const reasons = reasonsData.reasonsByType[feedbackType] || [];
    const needsContentDetails = feedbackType === 'already_covered';

    qs('#bd-feedback-title').textContent = FEEDBACK_TYPE_LABELS[feedbackType] || feedbackType;
    qs('#bd-feedback-form').innerHTML = `
      ${reasons.length > 0 ? `
      <div class="bd-feedback-field">
        <label for="bd-feedback-reason">Reason</label>
        <select id="bd-feedback-reason">
          ${reasons.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}
          <option value="Other">Other (add a note)</option>
        </select>
      </div>` : ''}
      ${needsContentDetails ? `
      <div class="bd-feedback-field">
        <label for="bd-feedback-url">Where this already lives (optional)</label>
        <input id="bd-feedback-url" type="url" placeholder="https://...">
      </div>
      <div class="bd-feedback-field">
        <label for="bd-feedback-status">Status</label>
        <select id="bd-feedback-status">
          <option value="published">Published</option>
          <option value="planned">Planned</option>
        </select>
      </div>` : ''}
      <div class="bd-feedback-field">
        <label for="bd-feedback-note">Note (required if "Other")</label>
        <textarea id="bd-feedback-note" rows="3"></textarea>
      </div>
      <button class="bd-feedback-submit" type="button" id="bd-feedback-submit">Save feedback</button>
      <p id="bd-feedback-error" style="color:var(--bd-red);font-size:11px;"></p>
    `;

    qs('#bd-feedback-submit').addEventListener('click', () => submitFeedback(recId, feedbackType));
    qs('#bd-feedback-scrim').hidden = false;
    qs('#bd-feedback-close').focus();
  }

  function closeFeedbackForm() {
    qs('#bd-feedback-scrim').hidden = true;
  }

  async function submitFeedback(recId, feedbackType) {
    const token = getEditorToken();
    if (!token) return;
    const payload = {
      feedbackType,
      reason: qs('#bd-feedback-reason')?.value || undefined,
      existingContentUrl: qs('#bd-feedback-url')?.value || undefined,
      contentStatus: qs('#bd-feedback-status')?.value || undefined,
      note: qs('#bd-feedback-note')?.value || undefined
    };
    const res = await fetch(`/api/recommendations/${recId}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    if (res.status === 403) {
      clearEditorToken();
      qs('#bd-feedback-error').textContent = 'Editor token rejected -- try again.';
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      qs('#bd-feedback-error').textContent = body.error || 'Could not save feedback.';
      return;
    }
    closeFeedbackForm();
    loadReport(); // re-fetch so a now-excluded idea/microtrend disappears immediately
  }

  // --- Hidden & covered items manager -------------------------------------
  async function openFeedbackManager() {
    qs('#bd-manager-scrim').hidden = false;
    qs('#bd-manager-close').focus();
    await renderFeedbackManager();
  }

  function closeFeedbackManager() {
    qs('#bd-manager-scrim').hidden = true;
  }

  async function renderFeedbackManager() {
    const list = qs('#bd-manager-list');
    list.innerHTML = '<div class="bd-empty">Loading…</div>';
    const res = await fetch('/api/feedback/active');
    const { feedback } = await res.json();
    if (feedback.length === 0) {
      list.innerHTML = '<div class="bd-empty">Nothing hidden, covered, or dismissed right now.</div>';
      return;
    }
    list.innerHTML = feedback.map((f) => `
      <div class="bd-manager-row">
        <div>
          <strong>${escapeHtml(f.microtrendDisplayName || f.opportunityName || f.theme || 'Untitled')}</strong>
          <span>${escapeHtml(FEEDBACK_TYPE_LABELS[f.feedbackType] || f.feedbackType)}${f.reason ? ` · ${escapeHtml(f.reason)}` : ''} · ${escapeHtml(fmtDateTime(f.createdAt))}</span>
        </div>
        <button class="bd-manager-undo" type="button" data-undo-id="${f.id}">Undo</button>
      </div>
    `).join('');
    list.querySelectorAll('[data-undo-id]').forEach((btn) => btn.addEventListener('click', () => undoFeedback(btn.dataset.undoId)));
  }

  async function undoFeedback(feedbackId) {
    const token = getEditorToken();
    if (!token) return;
    const res = await fetch(`/api/feedback/${feedbackId}/undo`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 403) { clearEditorToken(); alert('Editor token rejected -- try again.'); return; }
    if (!res.ok) { alert('Could not undo this feedback.'); return; }
    await renderFeedbackManager();
    loadReport(); // the un-excluded idea/microtrend can reappear immediately
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
  // --- Idea Tracker -------------------------------------------------------
  // One row per stable action_fingerprint (never one row per daily
  // appearance) -- first/last seen and recommendation_count are computed
  // live server-side from the real recommendations history, not a counter
  // this page maintains. workflowStatus and feedbackType are deliberately
  // separate controls/fields, never conflated.
  const WORKFLOW_LABELS = { new: 'New', reviewing: 'Reviewing', planned: 'Planned', in_production: 'In production', implemented: 'Implemented', ignored: 'Ignored' };
  let ideasSearchDebounce = null;

  async function loadIdeasSummary() {
    const res = await fetch('/api/ideas/summary');
    const summary = await res.json();
    qs('#bd-ideas-summary').innerHTML = `
      <div class="bd-ideas-summary-tile"><strong>${summary.new}</strong><span>New</span></div>
      <div class="bd-ideas-summary-tile"><strong>${summary.plannedOrInProduction}</strong><span>Planned / In production</span></div>
      <div class="bd-ideas-summary-tile"><strong>${summary.implemented}</strong><span>Implemented</span></div>
      <div class="bd-ideas-summary-tile"><strong>${summary.ignored}</strong><span>Ignored</span></div>
    `;
  }

  function populateIdeasThemeFilter() {
    const sel = qs('#bd-ideas-filter-theme');
    if (sel.options.length > 1) return; // already populated
    for (const [value, label] of Object.entries(state.themeLabels)) {
      sel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`);
    }
  }

  async function loadIdeas() {
    const params = new URLSearchParams();
    const search = qs('#bd-ideas-search').value.trim();
    const filters = {
      search,
      theme: qs('#bd-ideas-filter-theme').value,
      workflowStatus: qs('#bd-ideas-filter-workflow').value,
      feedbackType: qs('#bd-ideas-filter-feedback').value,
      tier: qs('#bd-ideas-filter-tier').value,
      source: qs('#bd-ideas-filter-source').value,
      fromDate: qs('#bd-ideas-filter-from').value,
      toDate: qs('#bd-ideas-filter-to').value
    };
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    const res = await fetch(`/api/ideas?${params.toString()}`);
    const { ideas } = await res.json();
    renderIdeas(ideas);
  }

  function renderIdeas(ideas) {
    const tbody = qs('#bd-ideas-tbody');
    qs('#bd-ideas-empty').hidden = ideas.length !== 0;
    if (ideas.length === 0) {
      tbody.innerHTML = '';
      return;
    }
    tbody.innerHTML = ideas.map((idea) => `
      <tr data-fingerprint="${escapeHtml(idea.actionFingerprint)}">
        <td>
          <div class="bd-idea-name">${escapeHtml(idea.opportunityName || '(untitled)')}</div>
          ${idea.recommendedAction ? `<div class="bd-idea-action">${escapeHtml(idea.recommendedAction)}</div>` : ''}
        </td>
        <td>${escapeHtml(idea.themeLabel || '')}</td>
        <td>${escapeHtml(idea.tier || '—')}</td>
        <td class="bd-idea-meta">${escapeHtml(String(idea.firstRecommendedAt || '').slice(0, 10))} &rarr; ${escapeHtml(String(idea.lastRecommendedAt || '').slice(0, 10))}</td>
        <td class="bd-idea-meta">${idea.recommendationCount}</td>
        <td><select data-idea-field="workflowStatus">
          ${Object.entries(WORKFLOW_LABELS).map(([v, l]) => `<option value="${v}" ${idea.workflowStatus === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></td>
        <td><select data-idea-field="feedbackType">
          <option value="" ${!idea.feedbackType ? 'selected' : ''}>&mdash;</option>
          ${Object.entries(FEEDBACK_TYPE_LABELS).map(([v, l]) => `<option value="${v}" ${idea.feedbackType === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></td>
        <td><input type="text" data-idea-field="owner" value="${escapeHtml(idea.owner || '')}" placeholder="Owner"></td>
        <td><input type="text" data-idea-field="notes" value="${escapeHtml(idea.notes || '')}" placeholder="Notes"></td>
        <td><input type="url" data-idea-field="contentUrl" value="${escapeHtml(idea.contentUrl || '')}" placeholder="https://..."></td>
      </tr>
    `).join('');

    tbody.querySelectorAll('select[data-idea-field="workflowStatus"]').forEach((sel) => sel.addEventListener('change', () =>
      patchIdea(sel.closest('tr').dataset.fingerprint, { workflowStatus: sel.value })));
    tbody.querySelectorAll('select[data-idea-field="feedbackType"]').forEach((sel) => sel.addEventListener('change', () =>
      giveIdeaFeedback(sel.closest('tr').dataset.fingerprint, sel.value)));
    tbody.querySelectorAll('input[data-idea-field]').forEach((input) => input.addEventListener('blur', () =>
      patchIdea(input.closest('tr').dataset.fingerprint, { [input.dataset.ideaField]: input.value })));
  }

  async function patchIdea(fingerprint, changes) {
    const token = getEditorToken();
    if (!token) return;
    const res = await fetch(`/api/ideas/${encodeURIComponent(fingerprint)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(changes)
    });
    if (res.status === 403) { clearEditorToken(); alert('Editor token rejected -- try again.'); return; }
    if (!res.ok) { alert('Could not save change.'); return; }
    await loadIdeasSummary();
  }

  async function giveIdeaFeedback(fingerprint, feedbackType) {
    if (!feedbackType) return;
    const token = getEditorToken();
    if (!token) return;
    const res = await fetch(`/api/ideas/${encodeURIComponent(fingerprint)}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ feedbackType })
    });
    if (res.status === 403) { clearEditorToken(); alert('Editor token rejected -- try again.'); return; }
    if (!res.ok) { const body = await res.json().catch(() => ({})); alert(body.error || 'Could not save feedback.'); return; }
    await loadIdeas();
  }

  async function openIdeaTracker() {
    populateIdeasThemeFilter();
    await Promise.all([loadIdeasSummary(), loadIdeas()]);
  }

  function setupIdeasFilters() {
    ['#bd-ideas-filter-theme', '#bd-ideas-filter-workflow', '#bd-ideas-filter-feedback', '#bd-ideas-filter-tier', '#bd-ideas-filter-source', '#bd-ideas-filter-from', '#bd-ideas-filter-to']
      .forEach((sel) => qs(sel).addEventListener('change', loadIdeas));
    qs('#bd-ideas-search').addEventListener('input', () => {
      clearTimeout(ideasSearchDebounce);
      ideasSearchDebounce = setTimeout(loadIdeas, 300);
    });
  }

  function setupNav() {
    document.querySelectorAll('#bd-nav button[data-view]').forEach((btn) => btn.addEventListener('click', () => {
      document.querySelectorAll('#bd-nav button[data-view]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      const view = btn.dataset.view;
      qs('#bd-view-today').hidden = view !== 'today';
      qs('#bd-view-ideas').hidden = view !== 'ideas';
      if (view === 'ideas') openIdeaTracker();
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
      } else if (res.status === 409) {
        alert('An ingest run is already in progress -- wait for it to finish before starting another.');
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

    qs('#bd-feedback-close').addEventListener('click', closeFeedbackForm);
    qs('#bd-feedback-scrim').addEventListener('click', (e) => { if (e.target.id === 'bd-feedback-scrim') closeFeedbackForm(); });

    qs('#bd-feedback-manager-button').addEventListener('click', openFeedbackManager);
    qs('#bd-manager-close').addEventListener('click', closeFeedbackManager);
    qs('#bd-manager-scrim').addEventListener('click', (e) => { if (e.target.id === 'bd-manager-scrim') closeFeedbackManager(); });

    document.addEventListener('click', (e) => {
      const popover = qs('#bd-history-popover');
      const button = qs('#bd-history-button');
      if (!popover.hidden && !popover.contains(e.target) && !button.contains(e.target)) closeHistory(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!qs('#bd-history-popover').hidden) closeHistory();
      if (!qs('#bd-proof-scrim').hidden) { closeEvidence(); qs('#bd-refresh-button').blur(); }
      if (!qs('#bd-feedback-scrim').hidden) closeFeedbackForm();
      if (!qs('#bd-manager-scrim').hidden) closeFeedbackManager();
    });
  }

  async function init() {
    readUrl();
    setupNav();
    setupEvents();
    setupRefresh();
    setupIdeasFilters();
    await loadMeta();
    await loadReport();
  }

  init();
})();
