'use strict';

// AutoTag GUI front end. All state lives on the server (job folders), so the
// page can be closed and reopened at any time; it just polls api.cgi.

const API = 'api.cgi';
const POLL_VISIBLE = 3000;
const POLL_HIDDEN = 20000;
const STATE_LABELS = {
  starting: 'Starting', running: 'Running', stopping: 'Stopping', finished: 'Finished',
  failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted', queued: 'Queued', cancelled: 'Cancelled'
};

let settings = null;       // databases/schemes/limits, set once from the first status
let lastStatus = null;
let clockOffset = 0;       // server time minus browser time, in seconds
let pollTimer = null;
const openLogs = new Set(); // job ids whose log tail is expanded

const $ = (id) => document.getElementById(id);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// Same rules as the server: ids separated by commas, semicolons or white space; ranges a-b.
function parseIsolates(text) {
  const ids = new Set();
  const bad = [];
  for (const token of text.replace(/\s*-\s*/g, '-').split(/[\s,;]+/)) {
    if (!token) continue;
    let m;
    if ((m = token.match(/^0*([1-9]\d{0,8})$/))) {
      ids.add(Number(m[1]));
    } else if ((m = token.match(/^0*([1-9]\d{0,8})-0*([1-9]\d{0,8})$/)) && Number(m[1]) <= Number(m[2])) {
      const from = Number(m[1]), to = Number(m[2]);
      if (to - from >= (settings ? settings.max_isolates : 50000)) { bad.push(token); continue; }
      for (let i = from; i <= to; i++) ids.add(i);
    } else {
      bad.push(token);
    }
  }
  return { count: ids.size, bad };
}

function now() { return Date.now() / 1000 + clockOffset; }

function duration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return '–';
  seconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function when(epoch) {
  if (!epoch) return '–';
  const d = new Date(epoch * 1000);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })} ${time}`;
}

const isActive = (job) => ['starting', 'running', 'stopping'].includes(job.state);
const isPending = (job) => job.state === 'queued' || isActive(job);
const schemeText = (job) => `scheme${job.schemes.length > 1 ? 's' : ''} ${job.schemes.join(', ')}`;
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

async function api(action, { method = 'GET', job, body } = {}) {
  const url = `${API}?action=${action}${job ? `&job=${encodeURIComponent(job)}` : ''}`;
  const options = { method, cache: 'no-store', headers: {} };
  if (method === 'POST') {
    options.headers['X-Requested-With'] = 'autotag-gui';
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body || {});
  }
  const response = await fetch(url, options);
  let data;
  try { data = await response.json(); } catch (e) {
    throw new Error(`The server returned an unexpected response (HTTP ${response.status}).`);
  }
  if (!data.ok) throw new Error(data.error || 'Unknown error.');
  return data;
}

// ---- form -----------------------------------------------------------------

function buildForm() {
  const databases = $('databases');
  databases.replaceChildren(...settings.databases.map((db, i) => el('div', { class: 'choice' },
    el('input', { type: 'radio', name: 'database', id: `db-${i}`, value: db.name }),
    el('label', { for: `db-${i}` }, db.label, el('small', { class: 'mono' }, db.name)))));
  const schemes = $('schemes');
  schemes.replaceChildren(...settings.schemes.map((s) => el('label', {},
    el('input', { type: 'checkbox', name: 'scheme', value: s.id, checked: s.default }),
    s.label)));
  try {
    const remembered = localStorage.getItem('autotag-database');
    const input = [...document.querySelectorAll('input[name=database]')].find((i) => i.value === remembered);
    if (input) input.checked = true;
  } catch (e) { /* storage unavailable */ }
}

function updateIsolateHint() {
  const text = $('isolates').value;
  const hint = $('isolate-hint');
  if (!text.trim()) {
    hint.textContent = 'Separate ids with commas, spaces or new lines.';
    hint.className = 'hint';
    return;
  }
  const { count, bad } = parseIsolates(text);
  if (bad.length) {
    hint.textContent = `Not valid: ${bad.slice(0, 5).join(' ')}${bad.length > 5 ? ' …' : ''}`;
    hint.className = 'hint bad';
  } else {
    hint.textContent = `${plural(count, 'isolate')} recognised.`;
    hint.className = 'hint';
  }
}

function setMessage(text, kind) {
  const message = $('form-message');
  message.textContent = text || '';
  message.className = `message ${kind || ''}`;
}

function updateStartButton() {
  if (!lastStatus) return;
  const slotsFull = lastStatus.running >= lastStatus.max_running;
  const queueFull = slotsFull && lastStatus.queued >= lastStatus.max_queued;
  const button = $('start-button');
  button.disabled = queueFull;
  button.textContent = slotsFull ? 'Add to queue' : 'Start tagging';
  button.title = queueFull ? `The queue is full (${lastStatus.max_queued} sessions waiting).`
    : slotsFull ? `${lastStatus.max_running} sessions are running; this one starts automatically when one finishes.` : '';
}

async function startJob(event) {
  event.preventDefault();
  const database = document.querySelector('input[name=database]:checked');
  const schemes = [...document.querySelectorAll('input[name=scheme]:checked')].map((i) => i.value);
  const isolates = $('isolates').value;
  const parsed = parseIsolates(isolates);
  if (!database) return setMessage('Choose a database.', 'bad');
  if (!schemes.length) return setMessage('Tick at least one scheme.', 'bad');
  if (!parsed.count) return setMessage('Enter at least one isolate id.', 'bad');
  if (parsed.bad.length) return setMessage(`Not valid isolate id(s): ${parsed.bad.slice(0, 5).join(' ')}`, 'bad');

  const button = $('start-button');
  button.disabled = true;
  setMessage('Starting…');
  try {
    const result = await api('start', { method: 'POST', body: { database: database.value, schemes, isolates } });
    try { localStorage.setItem('autotag-database', database.value); } catch (e) { /* ignore */ }
    $('isolates').value = '';
    updateIsolateHint();
    setMessage(result.queued
      ? `Queued ${plural(parsed.count, 'isolate')} in ${database.value} (position ${result.queued}). It starts automatically when a running session finishes. You can close this page.`
      : `Started tagging ${plural(parsed.count, 'isolate')} in ${database.value}. You can close this page.`, 'ok');
  } catch (error) {
    setMessage(error.message, 'bad');
  }
  await refresh();
}

async function stopJob(job) {
  const question = job.state === 'queued'
    ? `Remove this session (${plural(job.isolate_count, 'isolate')} in ${job.database}) from the queue?`
    : job.state === 'stopping'
      ? 'The job has not stopped yet. Kill it now? (Only works 30 seconds after the first stop.)'
      : `Stop tagging ${plural(job.isolate_count, 'isolate')} in ${job.database}? Alleles tagged so far are kept.`;
  if (!confirm(question)) return;
  try {
    await api('stop', { method: 'POST', job: job.id });
  } catch (error) {
    alert(error.message);
  }
  await refresh();
}

// Writes ids compactly, e.g. "988-1002, 1005".
function compressIds(ids) {
  const sorted = [...ids].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.join(', ');
}

// Copies the settings of an earlier session into the form (all isolates, or only those not done yet).
async function runAgain(job, onlyRemaining) {
  let ids;
  try {
    ids = (await api('isolates', { job: job.id })).isolates;
  } catch (error) {
    alert(error.message);
    return;
  }
  if (onlyRemaining && job.current_isolate) ids = ids.filter((id) => id >= job.current_isolate);
  const radio = [...document.querySelectorAll('input[name=database]')].find((i) => i.value === job.database);
  if (!radio) {
    alert(`Database ${job.database} is no longer available.`);
    return;
  }
  radio.checked = true;
  const schemes = job.schemes.map(String);
  document.querySelectorAll('input[name=scheme]').forEach((i) => { i.checked = schemes.includes(i.value); });
  $('isolates').value = compressIds(ids);
  updateIsolateHint();
  setMessage(`Copied from the session of ${when(job.started || job.created)}${onlyRemaining ? ', only the isolates that were not done' : ''}. Check the settings and press the button to start.`, 'ok');
  $('new-title').scrollIntoView({ behavior: 'smooth' });
  $('isolates').focus({ preventScroll: true });
}

// ---- job lists --------------------------------------------------------------

function bytes(n) {
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function renderSlots(status) {
  const dots = [];
  for (let i = 0; i < status.max_running; i++) dots.push(el('span', { class: i < status.running ? 'on' : '' }));
  $('slots').replaceChildren(el('div', { class: 'slot-dots', 'aria-hidden': 'true' }, dots),
    `${status.running} of ${status.max_running} sessions running`, status.queued ? ` · ${status.queued} queued` : '');
}

function renderLoad(load) {
  const container = $('load');
  if (!load || load.load === undefined) {
    container.replaceChildren();
    return;
  }
  const ratio = load.cores ? load.load / load.cores : 0;
  const level = ratio >= 1 ? 'bad' : ratio >= 0.75 ? 'warn' : 'ok';
  container.replaceChildren(el('span', { class: `level ${level}`, 'aria-hidden': 'true' }),
    `CPU load ${load.load.toFixed(1)}${load.cores ? ` of ${load.cores} cores` : ''}`,
    load.memory_available ? ` · ${bytes(load.memory_available)} of ${bytes(load.memory_total)} memory free` : '');
  container.title = 'CPU load is the 1-minute load average: roughly how many cores are busy.';
}

// "1,234 alleles tagged in 12 isolates · 3 missing loci · 1 error"
function summaryParts(job) {
  const s = job.summary;
  if (!s) return [];
  const parts = [];
  if (s.tagged) parts.push(`${plural(s.tagged, 'allele')} tagged in ${plural(s.isolates_tagged, 'isolate')}`);
  else if (job.state === 'finished') parts.push('Nothing new to tag');
  if (s.missing) parts.push(`${s.missing.toLocaleString()} missing ${s.missing === 1 ? 'locus' : 'loci'}`);
  if (s.errors) parts.push(el('span', { class: 'bad-text' }, plural(s.errors, 'error')));
  return parts.flatMap((part, i) => (i ? [' · ', part] : [part]));
}

// Isolates done, including how far the current isolate is: its locus lines so far compared
// with the number of lines a complete isolate gave (in this run or earlier ones).
function progressOf(job) {
  const total = job.isolate_count || 0;
  const done = Math.min(job.done || 0, total);
  let current = 0;
  if (job.expected_lines && job.current_lines && done < total) {
    current = Math.min(job.current_lines / job.expected_lines, 0.99);
  }
  return { total, done, current, value: done + current };
}

// Seconds left, from the speed since the first isolate; null while there is too little to go on.
function timeLeft(job) {
  const { total, value } = progressOf(job);
  if (!job.first_isolate_at || value < 0.02 || value >= total) return null;
  const elapsed = now() - job.first_isolate_at;
  if (elapsed < 30) return null;
  return (elapsed / value) * (total - value);
}

function approximately(seconds) {
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  return `about ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function logTail(job) {
  if (!job.tail || !job.tail.length) return null;
  const details = el('details', { ontoggle: (e) => (e.target.open ? openLogs.add(job.id) : openLogs.delete(job.id)) },
    el('summary', {}, 'Latest output'),
    el('pre', { class: 'log' }, job.tail.join('\n')));
  details.open = openLogs.has(job.id);
  return details;
}

function jobHead(job, detail, buttons) {
  return el('div', { class: 'job-head' },
    el('div', {},
      el('div', { class: 'job-title' }, `${job.database_label} `,
        el('span', { class: `badge ${job.state}` }, STATE_LABELS[job.state] || job.state,
          job.queue_position ? ` #${job.queue_position}` : '')),
      el('div', { class: 'job-meta' },
        `${job.database} · ${schemeText(job)} · ${plural(job.isolate_count || 0, 'isolate')} · ${detail}`,
        job.user ? ` by ${job.user}` : '')),
    el('div', { class: 'job-buttons' }, buttons));
}

function renderRunning(jobs) {
  const container = $('running');
  if (!jobs.length) {
    container.replaceChildren(el('p', { class: 'empty' }, 'No tagging sessions are running.'));
    return;
  }
  container.replaceChildren(...jobs.map((job) => {
    const { total, done, current, value } = progressOf(job);
    const pct = total ? Math.round((value / total) * 100) : 0;
    const started = job.started || job.created;
    const waiting = !job.lines;
    const left = timeLeft(job);
    const summary = summaryParts(job);
    return el('article', { class: 'job' },
      jobHead(job, `started ${when(started)}`, [
        el('a', { class: 'small', href: `${API}?action=log&job=${job.id}`, target: '_blank', rel: 'noopener' }, 'Full log'),
        job.state === 'starting' ? null
          : el('button', { class: 'small danger', type: 'button', onclick: () => stopJob(job) }, job.state === 'stopping' ? 'Force stop' : 'Stop')]),
      el('div', { class: `bar${waiting ? ' indeterminate' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': Math.round(value * 100) / 100 },
        el('div', { style: `width:${pct}%` })),
      el('div', { class: 'progress-text' },
        el('span', {}, waiting ? 'Preparing (loading isolates and loci)…'
          : [el('strong', {}, `${done.toLocaleString()} / ${total.toLocaleString()}`), ' isolates done · ',
            el('strong', {}, `${pct}%`), ' overall',
            job.current_isolate ? ` · now at isolate ${job.current_isolate}` : '',
            current && total > 1 ? ` (about ${Math.round(current * 100)}% of its loci)` : '']),
        el('span', {}, 'Running for ', el('strong', {}, duration(now() - started)),
          waiting ? '' : [' · ', left === null ? 'estimating time left…' : el('strong', {}, `${approximately(left)} left`)])),
      summary.length ? el('div', { class: 'progress-text summary' }, el('span', {}, summary, ' so far')) : null,
      logTail(job));
  }));
}

function renderQueue(jobs) {
  $('queue-section').hidden = !jobs.length;
  $('queue').replaceChildren(...jobs.map((job) => el('article', { class: 'job queued' },
    jobHead(job, `added ${when(job.created)}`, [
      el('button', { class: 'small danger', type: 'button', onclick: () => stopJob(job) }, 'Cancel')]),
    el('div', { class: 'progress-text queue-text' },
      el('span', {}, job.queue_position === 1 ? 'Next in line: starts automatically when a running session finishes.'
        : `${job.queue_position - 1} session${job.queue_position === 2 ? '' : 's'} ahead in the queue.`),
      el('span', {}, 'Waiting for ', el('strong', {}, duration(now() - job.created)))))));
}

function renderHistory(jobs) {
  const container = $('history');
  if (!jobs.length) {
    container.replaceChildren(el('p', { class: 'empty' }, 'No finished sessions yet.'));
    return;
  }
  const rows = jobs.map((job) => {
    const started = job.started || job.created;
    const reason = job.state === 'interrupted'
      ? 'Stopped unexpectedly (server restart?). See the log.'
      : job.state === 'failed' ? (job.message || `Exit code ${job.exit_code}`) : job.message;
    const partial = ['stopped', 'interrupted', 'failed'].includes(job.state) && job.current_isolate
      && (job.done || 0) < (job.isolate_count || 0);
    return el('tr', {},
      el('td', { class: 'nowrap' }, when(started), job.user ? el('div', { class: 'why' }, job.user) : null),
      el('td', { title: job.database }, job.database_label),
      el('td', {}, job.schemes.join(', ')),
      el('td', { class: 'num' }, (job.isolate_count || 0).toLocaleString(),
        job.state !== 'finished' && job.done ? el('div', { class: 'why' }, `${job.done.toLocaleString()} done`) : null),
      el('td', { class: 'num' }, job.finished && job.started ? duration(job.finished - started) : '–'),
      el('td', {}, el('span', { class: `badge ${job.state}` }, STATE_LABELS[job.state] || job.state),
        reason ? el('div', { class: 'why' }, reason) : null),
      el('td', { class: 'result' }, summaryParts(job)),
      el('td', { class: 'row-actions' },
        el('a', { href: `${API}?action=log&job=${job.id}`, target: '_blank', rel: 'noopener' }, 'Log'),
        el('button', { class: 'link', type: 'button', onclick: () => runAgain(job, false) }, 'Run again'),
        partial ? el('button', { class: 'link', type: 'button', onclick: () => runAgain(job, true) }, 'Run remaining') : null));
  });
  container.replaceChildren(el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ['Started', 'Database', 'Schemes', 'Isolates', 'Duration', 'Status', 'Result', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, rows))));
}

function render(status) {
  renderSlots(status);
  renderLoad(status.load);
  renderRunning(status.jobs.filter(isActive).reverse());
  renderQueue(status.jobs.filter((job) => job.state === 'queued').sort((a, b) => a.queue_position - b.queue_position));
  renderHistory(status.jobs.filter((job) => !isPending(job)));
  updateStartButton();
  $('foot').textContent = `Updated ${new Date().toLocaleTimeString()}${status.user ? ` · signed in as ${status.user}` : ''}`;
}

async function refresh() {
  clearTimeout(pollTimer);
  try {
    const status = await api('status');
    clockOffset = status.now - Date.now() / 1000;
    lastStatus = status;
    if (!settings) {
      settings = status;
      buildForm();
    }
    render(status);
  } catch (error) {
    $('running').replaceChildren(el('p', { class: 'empty' }, `Cannot load status: ${error.message}`));
  }
  pollTimer = setTimeout(refresh, document.hidden ? POLL_HIDDEN : POLL_VISIBLE);
}

$('start-form').addEventListener('submit', startJob);
$('isolates').addEventListener('input', updateIsolateHint);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
refresh();
