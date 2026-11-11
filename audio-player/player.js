const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const columnOptionsEl = document.getElementById('columnOptions');
const player = document.getElementById('player');
const pageSizeEl = document.getElementById('pageSize');
const pageInfoEl = document.getElementById('pageInfo');
const firstPageEl = document.getElementById('firstPage');
const previousPageEl = document.getElementById('previousPage');
const nextPageEl = document.getElementById('nextPage');
const lastPageEl = document.getElementById('lastPage');
statusEl.textContent = 'Starting Grist connection…';
let rows = [];
let queue = [];
let index = -1;
let access = null;
let accessExpiresAt = 0;
let generation = 0;
let gapTimer = null;
let availableColumns = [];
let visibleColumns = [];
const PAGE_SIZES = [10, 25, 50, 100, 200];
let pageSize = 25;
let currentPage = 0;

function cancelGap() {
  if (gapTimer !== null) clearTimeout(gapTimer);
  gapTimer = null;
}

function setStatus(message) {
  statusEl.textContent = message;
}

async function refreshAccess() {
  const result = await grist.docApi.getAccessToken({ readOnly: true });
  access = result;
  accessExpiresAt = Date.now() + result.ttlMsecs;
  render();
  return result;
}

async function currentAccess() {
  if (access && Date.now() < accessExpiresAt - 30000) return access;
  return refreshAccess();
}

function attachmentUrl(id, tokenInfo) {
  const base = tokenInfo.baseUrl.replace(/\/$/, '');
  return `${base}/attachments/${encodeURIComponent(id)}/download?auth=${encodeURIComponent(tokenInfo.token)}`;
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    const items = value[0] === 'L' ? value.slice(1) : value;
    return items.map(displayValue).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderColumnPicker() {
  columnOptionsEl.replaceChildren();
  for (const column of availableColumns) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = visibleColumns.includes(column);
    checkbox.addEventListener('change', async () => {
      visibleColumns = checkbox.checked
        ? [...visibleColumns, column]
        : visibleColumns.filter(name => name !== column);
      render();
      try {
        await grist.setOption('audioQueueVisibleColumns', visibleColumns);
        setStatus('Columns updated. Click Save in Grist to keep this selection.');
      } catch (err) {
        setStatus(`Could not save column choice: ${err.message}`);
      }
    });
    label.append(checkbox, document.createTextNode(column));
    columnOptionsEl.append(label);
  }
}

function showRowPage(rowId) {
  const position = rows.findIndex(row => row.id === rowId);
  if (position >= 0) currentPage = Math.floor(position / pageSize);
}

function render() {
  listEl.replaceChildren();
  countEl.textContent = `${rows.length} rows`;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  currentPage = Math.min(Math.max(0, currentPage), pageCount - 1);
  const start = currentPage * pageSize;
  const end = Math.min(start + pageSize, rows.length);
  pageSizeEl.value = String(pageSize);
  pageInfoEl.textContent = rows.length
    ? `Rows ${start + 1}–${end} of ${rows.length} · Page ${currentPage + 1} of ${pageCount}`
    : 'No rows';
  firstPageEl.disabled = previousPageEl.disabled = currentPage === 0;
  nextPageEl.disabled = lastPageEl.disabled = currentPage === pageCount - 1;
  for (const [offset, row] of rows.slice(start, end).entries()) {
    const position = start + offset;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'item' + (queue[index]?.rowId === row.id ? ' active' : '');
    button.disabled = !access;
    const fields = visibleColumns.filter(column => availableColumns.includes(column))
      .map(column => displayValue(row.values[column]));
    button.textContent = `${position + 1} · ${fields.join(' · ') || 'Untitled'} (${row.audioIds.length} audio${row.audioIds.length === 1 ? '' : 's'})`;
    button.addEventListener('click', () => startFrom(row.id));
    listEl.append(button);
  }
}

// Page navigation changes only the displayed slice, not the playback queue.
firstPageEl.addEventListener('click', () => { currentPage = 0; render(); });
previousPageEl.addEventListener('click', () => { currentPage--; render(); });
nextPageEl.addEventListener('click', () => { currentPage++; render(); });
lastPageEl.addEventListener('click', () => {
  currentPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  render();
});
pageSizeEl.addEventListener('change', async () => {
  const selected = Number(pageSizeEl.value);
  if (!PAGE_SIZES.includes(selected)) return;
  pageSize = selected;
  currentPage = 0;
  render();
  try {
    await grist.setOption('audioQueuePageSize', pageSize);
  } catch (err) {
    setStatus(`Could not save rows per page: ${err.message}`);
  }
});

function stop() {
  generation++;
  cancelGap();
  queue = [];
  index = -1;
  player.pause();
  player.removeAttribute('src');
  player.load();
  render();
  setStatus('Stopped. Choose a row to play from.');
}

function startFrom(rowId) {
  const first = rows.findIndex(row => row.id === rowId);
  if (first < 0) return;
  generation++;
  const run = generation;
  cancelGap();
  player.pause();
  queue = rows.slice(first).flatMap(row => row.audioIds.map((id, number) => ({
    rowId: row.id, title: row.Title || 'Untitled', id, number: number + 1
  })));
  index = 0;
  if (!queue.length) {
    stop();
    setStatus('There are no audio attachments from this row onward.');
    return;
  }
  // Access is loaded before buttons become clickable, so play() happens
  // directly within the click handler. This satisfies browser audio policy.
  const item = queue[0];
  if (Date.now() < accessExpiresAt - 30000) {
    showRowPage(item.rowId);
    player.src = attachmentUrl(item.id, access);
    render();
    setStatus(`Playing ${item.title} · audio ${item.number} of this row`);
    player.play().catch(() => setStatus('Press play in the audio controls to continue.'));
  } else {
    playCurrent(run);
  }
}

async function playCurrent(run = generation) {
  if (index >= queue.length) {
    queue = [];
    index = -1;
    render();
    setStatus('Finished.');
    return;
  }
  const item = queue[index];
  try {
    const tokenInfo = await currentAccess();
    if (run !== generation) return;
    showRowPage(item.rowId);
    player.src = attachmentUrl(item.id, tokenInfo);
    render();
    setStatus(`Playing ${item.title} · audio ${item.number} of this row`);
    await player.play();
  } catch (err) {
    if (run !== generation) return;
    setStatus(`Playback paused: ${err.message || 'press play in the audio controls.'}`);
  }
}

function next() {
  if (index < 0) return;
  generation++;
  cancelGap();
  player.pause();
  index++;
  playCurrent(generation);
}

player.addEventListener('ended', () => {
  if (index < 0) return;
  // There is no pause after the final audio.
  if (index + 1 >= queue.length) {
    next();
    return;
  }
  const seconds = Number.isFinite(player.duration) && player.duration >= 0
    ? player.duration : (Number.isFinite(player.currentTime) ? player.currentTime : 0);
  const waitMs = Math.round(seconds * 1000 + 500);
  const run = generation;
  setStatus(`Waiting ${(waitMs / 1000).toFixed(1)} seconds before the next audio…`);
  cancelGap();
  gapTimer = setTimeout(() => {
    gapTimer = null;
    if (run === generation) next();
  }, waitMs);
});
player.addEventListener('error', () => {
  if (index >= 0) setStatus('Audio could not be loaded. Click Next audio to skip it.');
});
document.getElementById('stop').addEventListener('click', stop);
document.getElementById('next').addEventListener('click', next);
document.getElementById('retry').addEventListener('click', () => {
  refreshAccess().then(() => setStatus('Choose a row to play from.'))
    .catch(err => setStatus(`Still no access: ${err.message}. Change Access level on the Custom widget in Grist's right-hand panel.`));
});

grist.ready({ requiredAccess: 'full' });
grist.onOptions((options, interaction) => {
  const savedPageSize = options?.audioQueuePageSize;
  if (PAGE_SIZES.includes(savedPageSize) && savedPageSize !== pageSize) {
    pageSize = savedPageSize;
    currentPage = 0;
    render();
  }
  if (Array.isArray(options?.audioQueueVisibleColumns)) {
    visibleColumns = options.audioQueueVisibleColumns;
    renderColumnPicker();
    render();
  }
  // An options update from the Builder can omit or misreport access_level.
  // Keep a working attachment token when only the column choice changed.
  if (access) return;
  if (interaction?.access_level && interaction.access_level !== 'full') {
    setStatus('This widget needs Full document access. Set Access level in Grist’s right-hand Creator Panel.');
    return;
  }
  refreshAccess().then(() => {
    if (index < 0) setStatus('Choose a row to play from.');
  }).catch(err => setStatus(`Cannot access attachments: ${err.message}. Click Retry access after changing the widget’s Access level.`));
});
grist.onRecords(records => {
  availableColumns = [...new Set(records.flatMap(record => Object.keys(record)))]
    .filter(name => !['id', 'manualSort', 'Audio'].includes(name)
      && !name.startsWith('gristHelper_'));
  renderColumnPicker();
  rows = records.map(record => ({
    id: record.id,
    manualSort: Number(record.manualSort),
    Title: record.Title,
    values: record,
    audioIds: Array.isArray(record.Audio)
      ? record.Audio.filter(id => Number.isInteger(id) && id > 0)
      : []
  })).sort((a, b) => a.manualSort - b.manualSort || a.id - b.id);
  render();
  if (access && index < 0) setStatus('Choose a row to play from.');
}, { includeColumns: 'all' });

// The Builder may not deliver an onOptions event when access was already granted.
// Try once after ready, independently of that event.
setTimeout(() => {
  if (access) return;
  refreshAccess().then(() => {
    if (index < 0) setStatus('Choose a row to play from.');
  }).catch(err => setStatus(`Cannot access attachments: ${err.message}. Check Full document access, then click Retry access.`));
}, 750);