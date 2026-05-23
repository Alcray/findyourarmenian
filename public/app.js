const form = document.querySelector('#search-form');
const queryInput = document.querySelector('#query');
const refreshInput = document.querySelector('#refresh');
const searchButton = document.querySelector('#search-button');
const statusEl = document.querySelector('#status');
const resultsEl = document.querySelector('#results');
const leadsEl = document.querySelector('#leads');
const configEl = document.querySelector('#config');

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

async function init() {
  const config = await api('/api/config');
  configEl.textContent = config.hasApifyToken
    ? `Mode: ${config.mode}. Company actor: ${config.companyEmployeesActor}. Gemini: ${config.hasGeminiKey ? config.geminiModel : 'off'}.`
    : `Mode: demo. Add APIFY_TOKEN for live searches.`;
  await loadLeads();
}

async function runSearch() {
  const query = queryInput.value.trim();
  if (!query) return;

  setBusy(true, 'Searching Apify and local cache...');
  resultsEl.innerHTML = '';

  try {
    const result = await api('/api/search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        refresh: refreshInput.checked,
      }),
    });

    const runSummary = result.runs
      ?.map((run) => `${run.cached ? 'cached' : run.demo ? 'demo' : 'live'}: ${run.itemCount}`)
      .join(' | ');
    const agentSummary = result.agent?.geminiUsed
      ? ` Gemini judged ${result.agent.judgedCandidates || 0} candidates.`
      : result.agent?.error
        ? ` Gemini skipped: ${result.agent.error}`
        : '';
    statusEl.textContent = result.cached
      ? `Loaded cached search with ${result.results.length} candidates.`
      : `Found ${result.results.length} candidates. ${runSummary || ''}${agentSummary}`;
    renderPeople(result.results, resultsEl);
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function loadLeads() {
  const result = await api('/api/leads');
  if (!result.leads.length) {
    leadsEl.innerHTML = '<p class="muted">No saved leads yet.</p>';
    return;
  }

  leadsEl.innerHTML = result.leads
    .map((lead) => personCard(lead.person, lead))
    .join('');
  bindLeadForms(leadsEl);
}

function renderPeople(people, container) {
  if (!people.length) {
    container.innerHTML = '<p class="muted">No candidates found yet. Try a company, role, and Armenian keyword.</p>';
    return;
  }

  container.innerHTML = people.map((person) => personCard(person, person.lead)).join('');
  bindLeadForms(container);
}

function personCard(person, lead) {
  const evidence = (person.evidence || [])
    .slice(0, 4)
    .map((item) => `<li>${escapeHtml(item.text)}</li>`)
    .join('');
  const source = person.sources?.[0];
  const sourceLink = source?.url
    ? `<a href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer">Source</a>`
    : '<span class="muted">No source URL</span>';

  return `
    <article class="card">
      <div class="meta">
        <span class="pill score">${person.confidence}% ${escapeHtml(person.confidenceLabel || '')}</span>
        ${lead ? `<span class="pill">${escapeHtml(lead.status)}</span>` : ''}
      </div>
      <h2>${escapeHtml(person.name)}</h2>
      <p class="muted">${escapeHtml(person.headline || person.role || 'Candidate profile')}</p>
      <div class="tags">
        ${person.company ? `<span class="pill">${escapeHtml(person.company)}</span>` : ''}
        ${person.location ? `<span class="pill">${escapeHtml(person.location)}</span>` : ''}
        ${source?.demo ? '<span class="pill">demo</span>' : ''}
        ${source?.cached ? '<span class="pill">cached</span>' : ''}
      </div>
      <ul class="evidence">${evidence || '<li>Limited evidence. Verify before outreach.</li>'}</ul>
      ${person.outreachAngle ? `<p><strong>Outreach:</strong> ${escapeHtml(person.outreachAngle)}</p>` : ''}
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
    </article>
  `;
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
      await loadLeads();
      statusEl.textContent = 'Lead saved.';
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

init().catch((error) => {
  statusEl.textContent = error.message;
});
