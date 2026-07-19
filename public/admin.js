const SVG_NS = 'http://www.w3.org/2000/svg';
const numberFormatter = new Intl.NumberFormat();
const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const elements = {
  status: document.querySelector('#dashboard-status'),
  generatedTime: document.querySelector('#generated-time'),
  refreshButton: document.querySelector('#refresh-button'),
  logoutButton: document.querySelector('#logout-button'),
  windowButtons: [...document.querySelectorAll('[data-window]')],
  dailyBody: document.querySelector('#daily-body'),
  trendChart: document.querySelector('#trend-chart'),
  chartEmpty: document.querySelector('#chart-empty'),
  trendCaption: document.querySelector('#trend-caption'),
  stats: {
    visitors: document.querySelector('#stat-visitors'),
    views: document.querySelector('#stat-views'),
    searches: document.querySelector('#stat-searches'),
    opens: document.querySelector('#stat-opens'),
    success: document.querySelector('#stat-success'),
    noResults: document.querySelector('#stat-no-results'),
    failed: document.querySelector('#stat-failed'),
  },
  details: {
    visitors: document.querySelector('#detail-visitors'),
    views: document.querySelector('#detail-views'),
    searches: document.querySelector('#detail-searches'),
    opens: document.querySelector('#detail-opens'),
    success: document.querySelector('#detail-success'),
    noResults: document.querySelector('#detail-no-results'),
    failed: document.querySelector('#detail-failed'),
  },
};

let analytics = null;
let selectedWindow = 30;

for (const button of elements.windowButtons) {
  button.addEventListener('click', () => {
    const nextWindow = Number(button.dataset.window);
    if (![7, 30, 90].includes(nextWindow)) return;
    selectedWindow = nextWindow;
    updateWindowButtons();
    render();
  });
}

elements.refreshButton.addEventListener('click', () => loadAnalytics({ announce: true }));
elements.logoutButton.addEventListener('click', logout);

await loadAnalytics();

async function loadAnalytics({ announce = false } = {}) {
  elements.refreshButton.disabled = true;
  setStatus(announce ? 'Refreshing analytics…' : 'Loading analytics…');

  try {
    const response = await fetch('/api/admin/analytics', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (response.status === 401) {
      window.location.replace('/admin/login');
      return;
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(textValue(body.error) || 'Analytics could not be loaded.');

    analytics = normalizeAnalytics(body);
    render();
    setStatus('Private analytics loaded.');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Analytics could not be loaded.', true);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function logout() {
  elements.logoutButton.disabled = true;
  setStatus('Logging out…');

  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    if (!response.ok) throw new Error('Log out failed. Please try again.');
    window.location.replace('/admin/login');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Log out failed. Please try again.', true);
    elements.logoutButton.disabled = false;
  }
}

function normalizeAnalytics(value) {
  const daily = Array.isArray(value?.daily)
    ? value.daily.map(normalizeDay).filter(Boolean).sort((left, right) => left.date.localeCompare(right.date))
    : [];
  const generatedAt = validDate(value?.generatedAt) || new Date();
  return {
    retentionDays: safeInteger(value?.retentionDays),
    totals: normalizeTotals(value?.totals),
    daily,
    generatedAt,
  };
}

function normalizeDay(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(textValue(value.date))) return null;
  return {
    date: value.date,
    uniqueVisitors: safeInteger(value.uniqueVisitors),
    pageViews: safeInteger(value.pageViews),
    searches: safeInteger(value.searches),
    resultOpens: safeInteger(value.resultOpens),
    searchOutcomes: normalizeOutcomes(value.searchOutcomes),
  };
}

function normalizeTotals(value) {
  return {
    uniqueVisitors: safeInteger(value?.uniqueVisitors),
    pageViews: safeInteger(value?.pageViews),
    searches: safeInteger(value?.searches),
    resultOpens: safeInteger(value?.resultOpens),
    searchOutcomes: normalizeOutcomes(value?.searchOutcomes),
  };
}

function normalizeOutcomes(value) {
  return {
    success: safeInteger(value?.success),
    noResults: safeInteger(value?.noResults),
    failed: safeInteger(value?.failed),
  };
}

function render() {
  if (!analytics) return;

  const days = daysInWindow(analytics.daily, analytics.generatedAt, selectedWindow);
  const totals = sumDays(days);
  const selectedCoversRetention = selectedWindow >= analytics.retentionDays && analytics.retentionDays > 0;
  const uniqueVisitors = selectedCoversRetention
    ? analytics.totals.uniqueVisitors
    : totals.uniqueVisitors;

  setMetric(elements.stats.visitors, uniqueVisitors);
  setMetric(elements.stats.views, totals.pageViews);
  setMetric(elements.stats.searches, totals.searches);
  setMetric(elements.stats.opens, totals.resultOpens);
  setMetric(elements.stats.success, totals.searchOutcomes.success);
  setMetric(elements.stats.noResults, totals.searchOutcomes.noResults);
  setMetric(elements.stats.failed, totals.searchOutcomes.failed);

  elements.details.visitors.textContent = selectedCoversRetention
    ? `Exact across the ${analytics.retentionDays}-day retained period`
    : 'Daily uniques, summed; returning browsers can repeat across days';
  elements.details.views.textContent = ratioDetail(totals.pageViews, uniqueVisitors, 'per browser');
  elements.details.searches.textContent = ratioDetail(totals.searches, uniqueVisitors, 'per browser');
  elements.details.opens.textContent = ratioDetail(totals.resultOpens, totals.searchOutcomes.success, 'per successful search');
  elements.details.success.textContent = percentDetail(totals.searchOutcomes.success, totals.searches, 'of searches');
  elements.details.noResults.textContent = percentDetail(totals.searchOutcomes.noResults, totals.searches, 'of searches');
  elements.details.failed.textContent = percentDetail(totals.searchOutcomes.failed, totals.searches, 'of searches');

  elements.generatedTime.textContent = `Generated ${timestampFormatter.format(analytics.generatedAt)}`;
  elements.trendCaption.textContent = `Page views and searches across the last ${selectedWindow} days`;
  renderTrend(fillWindowDays(days, analytics.generatedAt, selectedWindow));
  renderTable(days);
}

function updateWindowButtons() {
  for (const button of elements.windowButtons) {
    const active = Number(button.dataset.window) === selectedWindow;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function daysInWindow(daily, generatedAt, windowDays) {
  const cutoff = utcDateKey(addUtcDays(generatedAt, -(windowDays - 1)));
  const end = utcDateKey(generatedAt);
  return daily.filter((day) => day.date >= cutoff && day.date <= end);
}

function fillWindowDays(days, generatedAt, windowDays) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const result = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = utcDateKey(addUtcDays(generatedAt, -offset));
    result.push(byDate.get(date) || {
      date,
      uniqueVisitors: 0,
      pageViews: 0,
      searches: 0,
      resultOpens: 0,
      searchOutcomes: { success: 0, noResults: 0, failed: 0 },
    });
  }
  return result;
}

function sumDays(days) {
  const totals = normalizeTotals({});
  for (const day of days) {
    totals.uniqueVisitors += day.uniqueVisitors;
    totals.pageViews += day.pageViews;
    totals.searches += day.searches;
    totals.resultOpens += day.resultOpens;
    totals.searchOutcomes.success += day.searchOutcomes.success;
    totals.searchOutcomes.noResults += day.searchOutcomes.noResults;
    totals.searchOutcomes.failed += day.searchOutcomes.failed;
  }
  return totals;
}

function renderTable(days) {
  elements.dailyBody.replaceChildren();
  if (!days.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'empty-cell';
    cell.textContent = 'No activity in this window yet.';
    row.append(cell);
    elements.dailyBody.append(row);
    return;
  }

  for (const day of [...days].reverse()) {
    const row = document.createElement('tr');
    appendCell(row, formatDay(day.date));
    appendCell(row, numberFormatter.format(day.uniqueVisitors));
    appendCell(row, numberFormatter.format(day.pageViews));
    appendCell(row, numberFormatter.format(day.searches));
    appendCell(row, numberFormatter.format(day.resultOpens));
    elements.dailyBody.append(row);
  }
}

function appendCell(row, value) {
  const cell = document.createElement('td');
  cell.textContent = value;
  row.append(cell);
}

function renderTrend(days) {
  elements.trendChart.replaceChildren();
  const width = 760;
  const height = 255;
  const inset = { top: 18, right: 12, bottom: 31, left: 40 };
  const plotWidth = width - inset.left - inset.right;
  const plotHeight = height - inset.top - inset.bottom;
  const maximum = Math.max(0, ...days.flatMap((day) => [day.pageViews, day.searches]));
  const scaleMaximum = Math.max(1, niceMaximum(maximum));

  elements.trendChart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  elements.trendChart.setAttribute('preserveAspectRatio', 'none');
  elements.chartEmpty.hidden = maximum > 0;

  for (let index = 0; index <= 4; index += 1) {
    const y = inset.top + (plotHeight * index) / 4;
    const value = scaleMaximum - (scaleMaximum * index) / 4;
    appendSvg('line', {
      x1: inset.left,
      x2: width - inset.right,
      y1: y,
      y2: y,
      stroke: 'rgba(255,255,255,0.085)',
      'stroke-width': '1',
    });
    const label = appendSvg('text', {
      x: inset.left - 8,
      y: y + 4,
      fill: '#817983',
      'font-size': '10',
      'text-anchor': 'end',
    });
    label.textContent = compactNumberFormatter.format(Math.round(value));
  }

  const baseline = inset.top + plotHeight;
  const xFor = (index) => inset.left + (days.length <= 1 ? plotWidth / 2 : (plotWidth * index) / (days.length - 1));
  const yFor = (value) => baseline - (safeInteger(value) / scaleMaximum) * plotHeight;
  const viewPoints = days.map((day, index) => `${xFor(index)},${yFor(day.pageViews)}`).join(' ');
  const searchPoints = days.map((day, index) => `${xFor(index)},${yFor(day.searches)}`).join(' ');

  if (viewPoints) {
    appendSvg('polyline', {
      points: viewPoints,
      fill: 'none',
      stroke: '#ff7555',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '3',
      'vector-effect': 'non-scaling-stroke',
    });
    appendSvg('polyline', {
      points: searchPoints,
      fill: 'none',
      stroke: '#6f99ff',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '3',
      'vector-effect': 'non-scaling-stroke',
    });
  }

  const labelIndexes = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])].filter((index) => index >= 0);
  for (const index of labelIndexes) {
    const label = appendSvg('text', {
      x: xFor(index),
      y: height - 8,
      fill: '#817983',
      'font-size': '10',
      'text-anchor': index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle',
    });
    label.textContent = formatDay(days[index].date);
  }
}

function appendSvg(tag, attributes) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  elements.trendChart.append(element);
  return element;
}

function setMetric(element, value) {
  element.textContent = numberFormatter.format(safeInteger(value));
}

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', error);
}

function ratioDetail(numerator, denominator, suffix) {
  if (!denominator) return `No measurable ${suffix} yet`;
  const ratio = numerator / denominator;
  return `${ratio.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${suffix}`;
}

function percentDetail(value, total, suffix) {
  if (!total) return `0% ${suffix}`;
  return `${Math.round((value / total) * 100)}% ${suffix}`;
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function textValue(value) {
  return typeof value === 'string' ? value : '';
}

function validDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function addUtcDays(value, amount) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date;
}

function utcDateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function formatDay(dateKey) {
  return dateFormatter.format(new Date(`${dateKey}T00:00:00.000Z`));
}

function niceMaximum(value) {
  if (value <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const rounded = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return rounded * magnitude;
}
