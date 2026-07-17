const form = document.querySelector('#search-form');
const queryInput = document.querySelector('#query');
const refreshInput = document.querySelector('#refresh');
const searchButton = document.querySelector('#search-button');
const statusEl = document.querySelector('#status');
const resultsEl = document.querySelector('#results');
const contactsEl = document.querySelector('#contacts');
const contactsSearchForm = document.querySelector('#contacts-search-form');
const contactsSearchInput = document.querySelector('#contacts-search');
const contactsCountEl = document.querySelector('#contacts-count');
const jobsEl = document.querySelector('#jobs');
const traceEl = document.querySelector('#agent-trace');
const traceSummaryEl = document.querySelector('#agent-trace-summary');
const traceBodyEl = document.querySelector('#agent-trace-body');
const fastModeButton = document.querySelector('#fast-mode');
const agentModeButton = document.querySelector('#agent-mode');
const searchTab = document.querySelector('#search-tab');
const contactsTab = document.querySelector('#contacts-tab');
const searchPanel = document.querySelector('#search-panel');
const contactsPanel = document.querySelector('#contacts-panel');
const historyEl = document.querySelector('#history');
let searchMode = 'quality';
let funStatusTimer = null;
let funStatusIndex = 0;
let activeJobId = '';
const jobPollers = new Map();

const funnySearchStages = [
  'Reading the request like an over-caffeinated founder',
  'Searching LinkedIn-shaped haystacks',
  'Asking the diaspora group chat, spiritually',
  'Checking if their aunt knows your aunt',
  'Verifying company receipts, not vibes',
  'Looking for Armenian identity signals',
  'Separating real leads from LinkedIn confetti',
  'Drafting a non-cringe outreach angle',
];

const exampleQueries = [
  'Find Armenians who work at OpenAI',
  'Find me someone at Google sales',
  'Find Armenian AI founders in San Francisco',
];

queryInput.placeholder = exampleQueries[Math.floor(Math.random() * exampleQueries.length)];

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await runSearch();
});

fastModeButton.addEventListener('click', () => setSearchMode('fast'));
agentModeButton.addEventListener('click', () => setSearchMode('quality'));
searchTab.addEventListener('click', () => setActiveTab('search'));
contactsTab.addEventListener('click', () => setActiveTab('contacts'));

contactsSearchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  loadContacts(contactsSearchInput.value.trim());
});

async function init() {
  await api('/api/config');
  await loadJobs();
  await loadHistory();
  await loadContacts();
}

async function runSearch() {
  const query = queryInput.value.trim();
  if (!query) return;

  setBusy(true, 'Starting search...');
  try {
    const response = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        query,
        refresh: refreshInput.checked,
        mode: searchMode,
      }),
    });
    const job = response.job;
    activeJobId = job.id;
    renderJob(job);
    statusEl.textContent = `Started ${job.mode} search. You can run another query now.`;

    if (job.mode !== 'fast') {
      hideAgentTrace();
      startFunnyStatusTicker(job.id);
    } else {
      hideAgentTrace();
    }
    pollJob(job.id);
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

function pollJob(jobId) {
  if (jobPollers.has(jobId)) return;
  const interval = setInterval(async () => {
    try {
      const { job } = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      renderJob(job);
      if (job.status === 'completed' || job.status === 'failed') {
        clearInterval(interval);
        jobPollers.delete(jobId);
        if (job.status === 'completed' && job.result && activeJobId === job.id) {
          renderCompletedSearch(job.result);
          removeJobCard(job.id);
          dismissJob(job.id);
        }
        if (job.status === 'failed' && activeJobId === job.id) {
          statusEl.textContent = job.error || 'Search failed';
          renderErrorAgentTrace(job.query, new Error(job.error || 'Search failed'));
        }
      }
    } catch (error) {
      clearInterval(interval);
      jobPollers.delete(jobId);
      statusEl.textContent = error.message;
    }
  }, 2500);
  jobPollers.set(jobId, interval);
}

async function loadJobs() {
  const result = await api('/api/jobs');
  jobsEl.innerHTML = '';
  for (const job of result.jobs.reverse()) {
    renderJob(job);
    if (job.status === 'queued' || job.status === 'running') {
      pollJob(job.id);
    }
  }
}

function renderCompletedSearch(result) {
  const runSummary = result.runs
    ?.map((run) => `${run.cached ? 'cached' : run.demo ? 'demo' : 'live'}: ${run.itemCount}`)
    .join(' | ');
  const planning = result.agent?.planning;
  const validation = result.agent?.validation;
  const contactCache = result.agent?.contactCache;
  const mcp = result.agent?.mcp;
  const agentSummary = result.mode !== 'fast' && validation?.geminiUsed
    ? ` Agent planned ${planning?.stepCount || result.plan?.steps?.length || 0} steps, saw ${mcp?.toolCount || 0} MCP tools, loaded ${contactCache?.matched || 0} cached contacts, and judged ${validation.judgedCandidates || 0} candidates.`
    : validation?.error || planning?.error
      ? ` Agent note: ${validation?.error || planning?.error}`
      : '';
  statusEl.textContent = `Found ${result.results.length} candidates. ${runSummary || ''}${agentSummary}`;
  if (result.mode !== 'fast') {
    renderAgentTrace(result);
  } else {
    hideAgentTrace();
  }
  renderPeople(result.results, resultsEl);
  loadHistory();
}

function renderJob(job) {
  const existing = document.querySelector(`[data-job-id="${job.id}"]`);
  const stage = job.status === 'running'
    ? `<span class="muted job-stage">${escapeHtml(funnySearchStages[funStatusIndex] || 'Running agent...')}</span>`
    : '';
  const html = `
    <div>
      <strong>${escapeHtml(job.query)}</strong>
      <span class="muted">${escapeHtml(job.mode)} · ${escapeHtml(job.status)}${job.error ? ` · ${escapeHtml(job.error)}` : ''}</span>
      ${stage}
    </div>
    ${job.status === 'completed' ? `<button type="button" data-view-job="${escapeAttr(job.id)}">View</button>` : ''}
  `;

  if (existing) {
    existing.innerHTML = html;
  } else {
    const node = document.createElement('article');
    node.className = 'job-card';
    node.dataset.jobId = job.id;
    node.innerHTML = html;
    jobsEl.prepend(node);
  }

  document.querySelector(`[data-view-job="${job.id}"]`)?.addEventListener('click', async () => {
    const { job: latest } = await api(`/api/jobs/${encodeURIComponent(job.id)}`);
    if (latest.result) {
      activeJobId = job.id;
      renderCompletedSearch(latest.result);
      removeJobCard(job.id);
      dismissJob(job.id);
    }
  });
}

function updateJobStage(jobId, stage) {
  const stageEl = document.querySelector(`[data-job-id="${jobId}"] .job-stage`);
  if (stageEl) stageEl.textContent = stage;
}

function removeJobCard(jobId) {
  document.querySelector(`[data-job-id="${jobId}"]`)?.remove();
}

function dismissJob(jobId) {
  api(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {});
}

function setActiveTab(tab) {
  const isSearch = tab === 'search';
  searchTab.classList.toggle('active', isSearch);
  contactsTab.classList.toggle('active', !isSearch);
  searchPanel.hidden = !isSearch;
  contactsPanel.hidden = isSearch;
  // Refresh the list each time it's opened so newly found people show up.
  if (!isSearch) loadContacts(contactsSearchInput.value.trim());
}

function setSearchMode(mode) {
  searchMode = mode;
  fastModeButton.classList.toggle('active', mode === 'fast');
  agentModeButton.classList.toggle('active', mode !== 'fast');
  if (mode === 'fast') hideAgentTrace();
}

function hideAgentTrace() {
  stopFunnyStatusTicker();
  traceEl.hidden = true;
  traceEl.open = false;
  traceSummaryEl.textContent = '';
  traceBodyEl.innerHTML = '';
}

function renderPendingAgentTrace(query) {
  traceEl.hidden = false;
  traceEl.open = true;
  traceSummaryEl.textContent = 'running...';
  traceBodyEl.innerHTML = `
    <div class="trace-section">
      <h3>Running Agent</h3>
      <p class="muted">
        The browser has sent the request. The backend is now running the agent.
        Live server-side streaming is not wired yet, so this panel shows the expected execution path until the final trace returns.
      </p>
      <div class="trace-code">${escapeHtml(query)}</div>
    </div>

    <div class="trace-section">
      <h3>What I am doing</h3>
      <ul id="fun-status-list" class="fun-status-list">
        ${funnySearchStages.map((stage, index) => `
          <li class="${index === 0 ? 'active' : ''}">
            <span class="fun-dot"></span>
            <span>${escapeHtml(stage)}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `;
}

function startFunnyStatusTicker(jobId) {
  stopFunnyStatusTicker();
  funStatusIndex = 0;
  updateJobStage(jobId, funnySearchStages[0]);
  funStatusTimer = setInterval(() => {
    funStatusIndex = (funStatusIndex + 1) % funnySearchStages.length;
    updateJobStage(jobId, funnySearchStages[funStatusIndex]);
  }, 2400);
}

function stopFunnyStatusTicker() {
  if (funStatusTimer) {
    clearInterval(funStatusTimer);
    funStatusTimer = null;
  }
}

function renderErrorAgentTrace(query, error) {
  stopFunnyStatusTicker();
  traceEl.hidden = false;
  traceEl.open = true;
  traceSummaryEl.textContent = 'failed';
  traceBodyEl.innerHTML = `
    <div class="trace-section">
      <h3>Agent Failed</h3>
      <p class="muted">The request failed before a final trace came back.</p>
      <div class="trace-code">${escapeHtml(query)}</div>
    </div>
    <div class="trace-section">
      <h3>Error</h3>
      <div class="trace-code">${escapeHtml(error.message || String(error))}</div>
    </div>
  `;
}

function renderAgentTrace(result) {
  stopFunnyStatusTicker();
  const plan = result.plan;
  const runs = result.runs || [];
  const errors = result.errors || [];
  const agent = result.agent || {};
  const planning = agent.planning || {};
  const validation = agent.validation || {};
  const mcp = agent.mcp || {};
  const contactCache = agent.contactCache || {};

  traceEl.hidden = false;
  traceSummaryEl.textContent = `${runs.length} tool calls | ${contactCache.matched || 0} cached contacts | ${validation.judgedCandidates || 0} judged`;

  const planItems = (plan?.steps || [])
    .map((step, index) => `
      <li>
        <strong>${index + 1}. ${escapeHtml(formatToolName(step.tool))}</strong>
        <div class="muted">${escapeHtml(step.reason || 'No reason supplied')}</div>
        <div class="trace-code">${escapeHtml(step.query || step.company || '')}</div>
      </li>
    `)
    .join('');

  const runItems = runs
    .map((run) => `
      <li>
        <strong>${escapeHtml(run.actorId || 'tool')}</strong>
        <span class="pill">${run.cached ? 'cached' : run.demo ? 'demo' : 'live'}</span>
        <span class="pill">${Number(run.itemCount || 0)} items</span>
        <div class="trace-code">${escapeHtml(run.query || '')}</div>
      </li>
    `)
    .join('');

  const mcpTools = (mcp.toolNames || [])
    .slice(0, 16)
    .map((name) => `<span class="pill">${escapeHtml(name)}</span>`)
    .join('');

  const errorItems = errors
    .map((error) => `<li><strong>${escapeHtml(error.query || 'step')}</strong>: ${escapeHtml(error.message || String(error))}</li>`)
    .join('');

  traceBodyEl.innerHTML = `
    <div class="trace-section">
      <h3>Reasoning Summary</h3>
      <p class="muted">
        The agent interpreted the request as <strong>${escapeHtml(plan?.intent?.searchType || result.intent?.searchType || 'search')}</strong>,
        planned ${Number(plan?.steps?.length || 0)} allowed step(s), checked contact memory, inspected prior tool-call cache, executed needed tools, then used Gemini to judge candidates.
        Raw hidden chain-of-thought is not shown; this is the auditable trace.
      </p>
      <div class="tags">
        <span class="pill">Mode: ${result.mode !== 'fast' ? 'Quality' : 'Fast'}</span>
        <span class="pill">Planner: ${planning.geminiUsed ? escapeHtml(planning.model || 'Gemini') : 'fallback'}</span>
        <span class="pill">Validator: ${validation.geminiUsed ? escapeHtml(validation.model || 'Gemini') : 'fallback'}</span>
      </div>
    </div>

    <div class="trace-section">
      <h3>Plan</h3>
      ${planItems ? `<ol class="trace-list">${planItems}</ol>` : '<p class="muted">No plan returned.</p>'}
    </div>

    <div class="trace-section">
      <h3>Tool Calls</h3>
      ${runItems ? `<ol class="trace-list">${runItems}</ol>` : '<p class="muted">No tools called.</p>'}
    </div>

    <div class="trace-section">
      <h3>Memory & Cache</h3>
      <div class="tags">
        <span class="pill">${Number(contactCache.matched || 0)} contact hits</span>
        <span class="pill">${Number(contactCache.saved || 0)} contacts saved</span>
        <span class="pill">${result.cached ? 'old query replay' : 'fresh search'}</span>
      </div>
    </div>

    <div class="trace-section">
      <h3>Apify MCP</h3>
      <p class="muted">${mcp.available ? `Discovered ${Number(mcp.toolCount || 0)} MCP tools.` : `MCP unavailable: ${escapeHtml(mcp.error || 'not configured')}`}</p>
      <div class="tags">${mcpTools}</div>
    </div>

    <div class="trace-section">
      <h3>Gemini Validation</h3>
      <div class="tags">
        <span class="pill">${validation.geminiUsed ? 'Gemini used' : 'Gemini skipped'}</span>
        <span class="pill">${Number(validation.judgedCandidates || 0)} candidates judged</span>
      </div>
      ${validation.error ? `<p class="muted">${escapeHtml(validation.error)}</p>` : ''}
    </div>

    ${errorItems ? `
      <div class="trace-section">
        <h3>Errors</h3>
        <ul class="trace-list">${errorItems}</ul>
      </div>
    ` : ''}
  `;
}

async function loadContacts(q = '') {
  const result = await api(`/api/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  contactsCountEl.textContent = q
    ? `${result.total} match "${q}"`
    : `${result.total} found so far — grows with every search`;
  if (!result.contacts.length) {
    contactsEl.innerHTML = q
      ? '<p class="muted">No one in your list matches that yet.</p>'
      : '<p class="muted">No contacts yet. Run a search — everyone found lands here automatically.</p>';
    return;
  }
  contactsEl.innerHTML = result.contacts.map((contact) => personCard(contact, contact.lead)).join('');
  bindLeadForms(contactsEl);
}

async function loadHistory() {
  const result = await api('/api/searches');
  if (!result.searches.length) {
    historyEl.innerHTML = '<p class="muted">No searches yet.</p>';
    return;
  }

  historyEl.innerHTML = result.searches
    .map((search) => `
      <button class="history-card" type="button" data-key="${escapeAttr(search.searchKey)}" data-query="${escapeAttr(search.query)}" data-mode="${escapeAttr(search.mode || 'fast')}">
        <strong>${escapeHtml(search.query)}</strong>
        <div class="tags">
          <span class="pill">${escapeHtml(search.mode || 'fast')}</span>
          <span class="pill">${Number(search.resultCount || 0)} results</span>
        </div>
        <div class="muted">${escapeHtml(formatRelativeTime(search.updatedAt))}</div>
      </button>
    `)
    .join('');

  historyEl.querySelectorAll('.history-card').forEach((card) => {
    card.addEventListener('click', async () => {
      queryInput.value = card.dataset.query || '';
      setSearchMode(card.dataset.mode === 'fast' ? 'fast' : 'quality');
      setActiveTab('search');
      await loadSearchFromHistory(card.dataset.key);
    });
  });
}

async function loadSearchFromHistory(searchKey) {
  if (!searchKey) return;
  setBusy(true, 'Loading history...');
  resultsEl.innerHTML = '';
  hideAgentTrace();

  try {
    const result = await api(`/api/searches/${encodeURIComponent(searchKey)}`);
    statusEl.textContent = `Loaded from history with ${result.results.length} candidates.`;
    if (result.mode !== 'fast') renderAgentTrace(result);
    renderPeople(result.results, resultsEl);
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

function renderPeople(people, container) {
  if (!people.length) {
    container.innerHTML = '<p class="muted">No candidates found yet. Try a company, role, and Armenian keyword.</p>';
    return;
  }

  const visiblePeople = people.filter((person) => person.displayBucket !== 'reject');
  container.innerHTML = visiblePeople.map((person) => personCard(person, person.lead)).join('');
  bindLeadForms(container);
}

function personCard(person, lead, options = {}) {
  const evidence = (person.evidence || [])
    .slice(0, 3)
    .map((item) => `<li>${escapeHtml(item.text)}</li>`)
    .join('');
  const source = person.sources?.[0];
  const sourceLink = source?.url
    ? `<a href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer">Source</a>`
    : '<span class="muted">No source URL</span>';

  return `
    <article class="card">
      <div class="card-head">
        <div class="card-title-row">
          <h2>${escapeHtml(person.name)}</h2>
        </div>
        <p class="muted headline">${escapeHtml(person.headline || person.role || 'Candidate profile')}</p>
        <div class="tags">
          <span class="pill ${isLikelyArmenian(person) ? 'pill-strong' : 'pill-possible'}">${isLikelyArmenian(person) ? 'likely Armenian' : 'possible lead'}</span>
          ${person.company ? `<span class="pill">${escapeHtml(person.company)}</span>` : ''}
          ${person.location ? `<span class="pill">${escapeHtml(person.location)}</span>` : ''}
          ${lead ? `<span class="pill">${escapeHtml(lead.status)}</span>` : ''}
          ${source?.demo ? '<span class="pill">demo</span>' : ''}
          ${source?.cached ? '<span class="pill">cached</span>' : ''}
        </div>
      </div>

      <div class="evidence-box">
        <ul>${evidence || '<li>Limited evidence. Verify before outreach.</li>'}</ul>
        ${options.review ? '<p class="muted">Shown for recall. Verify before outreach.</p>' : ''}
      </div>

      ${person.outreachAngle ? `<p class="outreach"><strong>Outreach:</strong> ${escapeHtml(person.outreachAngle)}</p>` : '<p class="outreach muted">No outreach angle yet.</p>'}

      <div class="card-footer">
        <p>${sourceLink}</p>
        <form class="lead-form" data-person-id="${escapeAttr(person.id)}">
          <select name="status">
            ${['saved', 'contacted', 'helped', 'not relevant']
              .map((status) => `<option value="${status}" ${lead?.status === status ? 'selected' : ''}>${status}</option>`)
              .join('')}
          </select>
          <textarea name="notes" placeholder="Notes or warm intro idea">${escapeHtml(lead?.notes || '')}</textarea>
          <button class="secondary" type="submit">Save lead</button>
        </form>
      </div>
    </article>
  `;
}

function isLikelyArmenian(person) {
  if (person.displayBucket === 'likely') return true;
  if (person.displayBucket === 'possible' || person.displayBucket === 'reject') return false;
  const evidence = (person.evidence || []).map((item) => item.text).join(' ').toLowerCase();
  const judgment = person.geminiJudgment || {};
  if (judgment.armenianConfidence === 'high' || judgment.armenianConfidence === 'medium') return true;
  return /armenian|armenia|yerevan|hayastan|surname has common armenian|first name has armenian/.test(evidence);
}

function bindLeadForms(root) {
  root.querySelectorAll('.lead-form').forEach((leadForm) => {
    leadForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(leadForm);
      await api('/api/leads', {
        method: 'POST',
        body: JSON.stringify({
          personId: leadForm.dataset.personId,
          status: data.get('status'),
          notes: data.get('notes'),
        }),
      });
      await loadContacts(contactsSearchInput.value.trim());
      statusEl.textContent = 'Saved to your list.';
    });
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

function setBusy(isBusy, message = '') {
  searchButton.disabled = isBusy;
  searchButton.textContent = isBusy ? 'Searching...' : 'Search';
  if (message) statusEl.textContent = message;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

function formatToolName(value) {
  return String(value || 'unknown tool').replaceAll('_', ' ');
}

function formatRelativeTime(value) {
  if (!value) return '';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

init().catch((error) => {
  statusEl.textContent = error.message;
});
