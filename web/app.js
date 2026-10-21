'use strict';

// AutoTag GUI front end. All state lives on the server (job folders), so the
// page can be closed and reopened at any time; it just polls api.cgi.

const API = 'api.cgi';
const POLL_VISIBLE = 3000;
const POLL_HIDDEN = 20000;
const STATE_LABELS = {
  starting: 'Starting', running: 'Running', stopping: 'Stopping', finished: 'Finished',
  failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted'
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
  $('threads').max = settings.max_threads;
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
  const full = lastStatus && lastStatus.running >= lastStatus.max_running;
  $('start-button').disabled = !!full;
  $('start-button').title = full ? `The maximum of ${lastStatus.max_running} sessions is running.` : '';
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
    await api('start', { method: 'POST', body: { database: database.value, schemes, isolates, threads: $('threads').value || 1 } });
    try { localStorage.setItem('autotag-database', database.value); } catch (e) { /* ignore */ }
    $('isolates').value = '';
    updateIsolateHint();
    setMessage(`Started tagging ${plural(parsed.count, 'isolate')} in ${database.value}. You can close this page.`, 'ok');
  } catch (error) {
    setMessage(error.message, 'bad');
  }
  await refresh();
}

async function stopJob(job) {
  const force = job.state === 'stopping';
  const question = force
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

// ---- job lists --------------------------------------------------------------

function renderSlots(status) {
  const dots = [];
  for (let i = 0; i < status.max_running; i++) dots.push(el('span', { class: i < status.running ? 'on' : '' }));
  $('slots').replaceChildren(el('div', { class: 'slot-dots', 'aria-hidden': 'true' }, dots),
    `${status.running} of ${status.max_running} sessions running`);
}

function logTail(job) {
  if (!job.tail || !job.tail.length) return null;
  const details = el('details', { ontoggle: (e) => (e.target.open ? openLogs.add(job.id) : openLogs.delete(job.id)) },
    el('summary', {}, 'Latest output'),
    el('pre', { class: 'log' }, job.tail.join('\n')));
  details.open = openLogs.has(job.id);
  return details;
}

function renderRunning(jobs) {
  const container = $('running');
  if (!jobs.length) {
    container.replaceChildren(el('p', { class: 'empty' }, 'No tagging sessions are running.'));
    return;
  }
  container.replaceChildren(...jobs.map((job) => {
    const total = job.isolate_count || 0;
    const done = Math.min(job.done || 0, total);
    const pct = total ? Math.round((done / total) * 100) : 0;
    const started = job.started || job.created;
    const waiting = !job.lines;
    return el('article', { class: 'job' },
      el('div', { class: 'job-head' },
        el('div', {},
          el('div', { class: 'job-title' }, `${job.database_label} `, el('span', { class: `badge ${job.state}` }, STATE_LABELS[job.state] || job.state)),
          el('div', { class: 'job-meta' },
            `${job.database} · ${schemeText(job)} · ${plural(total, 'isolate')}`,
            job.threads > 1 ? ` · ${job.threads} threads` : '',
            ` · started ${when(started)}`, job.user ? ` by ${job.user}` : '')),
        el('div', { class: 'job-buttons' },
          el('a', { class: 'small', href: `${API}?action=log&job=${job.id}`, target: '_blank', rel: 'noopener' }, 'Full log'),
          job.state === 'starting' ? null
            : el('button', { class: 'small danger', type: 'button', onclick: () => stopJob(job) }, job.state === 'stopping' ? 'Force stop' : 'Stop'))),
      el('div', { class: `bar${waiting ? ' indeterminate' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done },
        el('div', { style: `width:${pct}%` })),
      el('div', { class: 'progress-text' },
        el('span', {}, waiting ? 'Preparing (loading isolates and loci)…'
          : [el('strong', {}, `${done.toLocaleString()} / ${total.toLocaleString()}`), ` isolates done (${pct}%)`,
            job.current_isolate ? ` · now at isolate ${job.current_isolate}` : '']),
        el('span', {}, 'Running for ', el('strong', {}, duration(now() - started)))),
      logTail(job));
  }));
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
      ? 'The job stopped unexpectedly (server restart?). Check the log.'
      : job.state === 'failed' ? (job.message || `Exit code ${job.exit_code}`) : job.message;
    return el('tr', {},
      el('td', { class: 'nowrap' }, when(started), job.user ? el('div', { class: 'why' }, job.user) : null),
      el('td', {}, job.database_label, el('div', { class: 'why mono' }, job.database)),
      el('td', {}, job.schemes.join(', ')),
      el('td', { class: 'num' }, (job.isolate_count || 0).toLocaleString(),
        job.state !== 'finished' && job.done ? el('div', { class: 'why' }, `${job.done.toLocaleString()} done`) : null),
      el('td', { class: 'num' }, job.finished ? duration(job.finished - started) : '–'),
      el('td', {}, el('span', { class: `badge ${job.state}` }, STATE_LABELS[job.state] || job.state),
        reason ? el('div', { class: 'why' }, reason) : null),
      el('td', {}, el('a', { href: `${API}?action=log&job=${job.id}`, target: '_blank', rel: 'noopener' }, 'Log')));
  });
  container.replaceChildren(el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ['Started', 'Database', 'Schemes', 'Isolates', 'Duration', 'Status', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, rows))));
}

function render(status) {
  renderSlots(status);
  renderRunning(status.jobs.filter(isActive).reverse());
  renderHistory(status.jobs.filter((job) => !isActive(job)));
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
