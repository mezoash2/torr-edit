/* ============================================================
   torr-edit — inspect & edit torrents, many at once
   multi-parse engine + per-torrent editor + tracker list
   ============================================================ */

import { Buffer } from 'https://cdn.jsdelivr.net/npm/buffer@6/+esm';
import parseTorrent, { toMagnetURI, toTorrentFile, remote as parseTorrentRemote } from 'https://cdn.jsdelivr.net/npm/parse-torrent@11/+esm';
import bytes from 'https://cdn.jsdelivr.net/npm/bytes@3/+esm';
import mime from 'https://cdn.jsdelivr.net/npm/mime-types@2/+esm';
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3/+esm';

const TRACKERS_FILE = 'trackers.txt';
const TRACKERS_META_FILE = 'trackers-last-updated.txt';
const WSS_TRACKERS = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.fastcast.nz',
];

/* ---------------- state ---------------- */

const state = {
  torrents: new Map(),   // id -> record
  order: [],             // tab order of ids
  activeId: null,
  nextId: 1,
  trackers: [],
  trackersUpdated: null,
  trackersSource: 'newTrackon snapshot',
  wt: null,              // lazy WebTorrent client
};

function recOf(id) { return state.torrents.get(id); }
function activeRec() { return state.activeId ? state.torrents.get(state.activeId) : null; }

/* ---------------- dom refs ---------------- */

const $ = (sel) => document.querySelector(sel);
const inputStage = $('#inputStage');
const workbench = $('#workbench');
const tabbar = $('#tabbar');
const batchbar = $('#batchbar');
const batchCount = $('#batchCount');
const editor = $('#editor');
const dropzone = $('#dropzone');
const filePicker = $('#filePicker');
const pasteBox = $('#pasteBox');
const trackerChip = $('#trackerChip');

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function fmtBytes(n) {
  if (n == null) return '';
  return bytes.format(n, { decimalPlaces: 1, unitSeparator: ' ' });
}

function toast(msg, type = 'info', ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function safeFilename(name) {
  return String(name || 'torrent').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'torrent';
}

/* ---------------- tracker list ---------------- */

async function loadTrackerList() {
  try {
    const res = await fetch(TRACKERS_FILE, { cache: 'no-cache' });
    if (!res.ok) throw new Error('snapshot missing');
    state.trackers = (await res.text()).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    try {
      const meta = await fetch(TRACKERS_META_FILE, { cache: 'no-cache' });
      state.trackersUpdated = meta.ok ? (await meta.text()).trim() : null;
    } catch { state.trackersUpdated = null; }
    state.trackersSource = 'newTrackon snapshot';
  } catch {
    // snapshot unavailable (e.g. file:// or first run) — hit the live API
    try {
      const res = await fetch('https://newtrackon.com/api/stable');
      if (!res.ok) throw new Error('api down');
      state.trackers = (await res.text()).split(/\n{2,}|\r?\n/).map((s) => s.trim()).filter(Boolean);
      state.trackersSource = 'live newTrackon API';
      state.trackersUpdated = null;
    } catch {
      state.trackers = [];
      state.trackersSource = 'unavailable';
    }
  }
  renderTrackerChip();
}

function renderTrackerChip() {
  const n = state.trackers.length;
  const when = state.trackersUpdated
    ? 'updated ' + String(state.trackersUpdated).slice(0, 10)
    : state.trackersSource === 'live newTrackon API' ? 'live feed' : 'none';
  trackerChip.textContent = `${n} trackers · ${when}`;
  trackerChip.title = `Tracker list from ${state.trackersSource} — click to copy all ${n} trackers`;
  const addStableBtn = editor.querySelector('[data-act="add-stable"]');
  if (addStableBtn) addStableBtn.textContent = `+ Add ${n} from tracker list`;
}

trackerChip.addEventListener('click', async () => {
  if (!state.trackers.length) { toast('No tracker list loaded yet.', 'error'); return; }
  const ok = await copyText(state.trackers.join('\n'));
  toast(ok ? `Copied ${state.trackers.length} trackers.` : 'Copy failed.', ok ? 'success' : 'error');
});

/* ---------------- parsing ---------------- */

function makeRec(parsed, source) {
  return {
    id: 't' + state.nextId++,
    parsed,
    source,               // 'file' | 'magnet' | 'url'
    modified: false,
    fetching: false,
  };
}

function addTorrent(rec) {
  state.torrents.set(rec.id, rec);
  state.order.push(rec.id);
  activate(rec.id);
  toast(`Parsed "${rec.parsed.name || rec.parsed.infoHash}"`, 'success', 2500);
}

async function parseOneLine(line) {
  const trimmed = line.trim();
  let parsed;
  let source;
  if (/^magnet:/i.test(trimmed)) {
    parsed = await parseTorrent(trimmed);
    source = 'magnet';
  } else if (/^https?:\/\//i.test(trimmed)) {
    parsed = await remoteParse(trimmed);
    source = 'url';
  } else if (/^[a-fA-F0-9]{40}$/.test(trimmed)) {
    parsed = await parseTorrent('magnet:?xt=urn:btih:' + trimmed);
    source = 'magnet';
  } else {
    parsed = await parseTorrent(trimmed);
    source = 'magnet';
  }
  const rec = makeRec(parsed, source);
  // magnet links sometimes carry xs= — enrich with the remote torrent file
  if (source === 'magnet' && parsed.xs) {
    try {
      const enriched = await remoteParse(parsed.xs);
      rec.parsed = enriched;
      rec.source = 'url';
    } catch { /* xs fetch failed — keep the magnet parse */ }
  }
  return rec;
}

function parseTextLines(text) {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) { toast('Nothing to parse — paste a magnet or URL first.', 'error'); return; }
  // parse everything at the same time
  lines.forEach(async (line, i) => {
    try {
      addTorrent(await parseOneLine(line));
    } catch (err) {
      toast(`Line ${i + 1} failed: ${err.message || err}`, 'error', 6000);
    }
  });
}

async function parseFiles(fileList) {
  for (const file of fileList) {
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const parsed = await parseTorrent(buf);
      addTorrent(makeRec(parsed, 'file'));
    } catch {
      toast(`Could not parse "${file.name}" — is it a valid .torrent file?`, 'error', 6000);
    }
  }
}

function remoteParse(url) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('remote fetch timed out')), 30000);
    parseTorrentRemote(url, (err, result) => {
      clearTimeout(t);
      err ? reject(err) : resolve(result);
    });
  });
}

/* ---------------- tabs ---------------- */

function activate(id) {
  if (id && !state.torrents.has(id)) return;
  state.activeId = id;
  renderTabs();
  renderBatchBar();
  if (id) { showWorkbench(); renderEditor(); syncHash(); }
}

function showWorkbench() {
  workbench.hidden = false;
  inputStage.hidden = true;
}

function showInputStage() {
  workbench.hidden = true;
  inputStage.hidden = false;
  state.activeId = null;
  syncHash();
  renderResumeBar();
  if (state.order.length === 0) pasteBox.focus();
}

function renderResumeBar() {
  const bar = $('#resumeBar');
  bar.hidden = state.order.length === 0;
  bar.querySelector('.resume-count').textContent = state.order.length;
}

$('#resumeBack').addEventListener('click', () => {
  if (state.order.length) activate(state.order[state.order.length - 1]);
  else showInputStage();
});

function closeTab(id) {
  const rec = state.torrents.get(id);
  if (!rec) return;
  if (rec.fetching && state.wt) { try { state.wt.torrents.forEach((t) => t.destroy()); } catch {} }
  state.torrents.delete(id);
  state.order = state.order.filter((x) => x !== id);
  if (state.order.length === 0) {
    showInputStage();
  } else if (state.activeId === id) {
    activate(state.order[0]);
  } else {
    renderTabs();
    renderBatchBar();
  }
}

function renderTabs() {
  tabbar.innerHTML = '';
  for (const id of state.order) {
    const rec = state.torrents.get(id);
    const name = rec.parsed.name || rec.parsed.infoHash.slice(0, 12) || 'unnamed';
    const short = rec.parsed.infoHash ? rec.parsed.infoHash.slice(0, 7) : '';
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab' + (id === state.activeId ? ' active' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(id === state.activeId));
    tab.dataset.tab = id;
    tab.title = `${rec.parsed.name || 'unnamed'}\n${rec.parsed.infoHash || ''}`;
    tab.innerHTML =
      (rec.modified ? '<span class="tab-dot" title="edited"></span>' : '') +
      `<span class="tab-name">${esc(name)}</span>` +
      (short ? `<span class="tab-hash">${esc(short)}</span>` : '') +
      `<span class="tab-close" data-close="${id}" role="button" aria-label="Close tab">✕</span>`;
    tabbar.appendChild(tab);
  }
}

tabbar.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) {
    e.stopPropagation();
    closeTab(close.dataset.close);
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) activate(tab.dataset.tab);
});

$('#newTab').addEventListener('click', showInputStage);

/* ---------------- batch bar ---------------- */

function renderBatchBar() {
  const n = state.order.length;
  batchbar.hidden = n < 1;
  batchCount.textContent = n + (n === 1 ? ' torrent loaded' : ' torrents loaded');
}

$('#batchTrackers').addEventListener('click', () => {
  if (!state.trackers.length) { toast('No tracker list loaded.', 'error'); return; }
  let added = 0;
  for (const rec of state.torrents.values()) {
    const cur = rec.parsed.announce || [];
    const merged = Array.from(new Set([...cur, ...state.trackers]));
    if (merged.length !== cur.length) { rec.parsed.announce = merged; markModified(rec); added++; }
  }
  if (added) renderEditor();
  toast(`Added ${state.trackers.length} trackers to ${added} torrent${added === 1 ? '' : 's'}.`, added ? 'success' : 'info');
});

$('#batchZip').addEventListener('click', async () => {
  if (!state.order.length) return;
  const btn = $('#batchZip');
  btn.disabled = true;
  btn.textContent = 'Zipping…';
  try {
    const zip = new JSZip();
    for (const id of state.order) {
      const rec = state.torrents.get(id);
      const data = toTorrentFile(rec.parsed);
      zip.file(safeFilename(rec.parsed.name || rec.parsed.infoHash) + '.torrent', data);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(blob, 'torr-edit-export.zip');
    toast(`Exported ${state.order.length} torrent${state.order.length === 1 ? '' : 's'} as zip.`, 'success');
  } catch (err) {
    toast('Could not build the zip: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download all as .zip';
  }
});

$('#batchMagnets').addEventListener('click', async () => {
  const magnets = state.order.map((id) => toMagnetURI(state.torrents.get(id).parsed));
  const ok = await copyText(magnets.join('\n'));
  toast(ok ? `Copied ${magnets.length} magnet link${magnets.length === 1 ? '' : 's'}.` : 'Copy failed.', ok ? 'success' : 'error');
});

/* ---------------- editor ---------------- */

function markModified(rec) {
  if (!rec.modified) {
    rec.modified = true;
    rec.parsed.created = new Date();
    rec.parsed.createdBy = 'torr-edit';
  }
}

function syncHash() {
  const rec = activeRec();
  if (rec) {
    try { history.replaceState(null, '', '#' + encodeURIComponent(toMagnetURI(rec.parsed))); } catch {}
  } else {
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  }
}

function renderEditor() {
  const rec = activeRec();
  if (!rec) { editor.innerHTML = ''; return; }
  const p = rec.parsed;

  const cells = Array.from({ length: 10 }, (_, i) => {
    const chunk = p.infoHash.slice(i * 4, i * 4 + 4);
    const edited = rec.modified && i < 3 ? ' edited' : '';
    return `<span class="fp-cell${edited}" data-copy-hash title="Copy info hash"><span class="mono">${esc(chunk)}</span><span class="idx">${i}</span></span>`;
  }).join('');

  const magnet = toMagnetURI(p);
  const hasFiles = p.files && p.files.length > 0;

  const createdText = p.created
    ? p.created.toISOString().slice(0, 19).replace('T', ' ')
    : 'creation time unspecified';
  const createdByText = p.createdBy ? `<span class="by"> · ${esc(p.createdBy)}</span>` : '';

  const piecesText = p.pieces
    ? `${p.pieces.length.toLocaleString()} × ${fmtBytes(p.pieceLength)} pieces (last ${fmtBytes(p.lastPieceLength)})`
    : 'not included in magnet';

  const trackersRows = (p.announce || []).map((tr, i) => `
    <div class="row">
      <span class="row-num">${i + 1}</span>
      <input type="text" value="${esc(tr)}" data-ann="${i}" spellcheck="false" aria-label="Tracker URL ${i + 1}" />
      <button type="button" class="row-btn" data-del-ann="${i}" aria-label="Remove tracker ${i + 1}" title="Remove">✕</button>
    </div>`).join('');

  const webseedRows = (p.urlList || []).map((ws, i) => `
    <div class="row">
      <span class="row-num">${i + 1}</span>
      <input type="text" value="${esc(ws)}" data-url="${i}" spellcheck="false" aria-label="Webseed URL ${i + 1}" />
      <button type="button" class="row-btn" data-del-url="${i}" aria-label="Remove webseed ${i + 1}" title="Remove">✕</button>
    </div>`).join('');

  const trackerSection = trackersRows
    ? `<div class="rows">${trackersRows}</div>`
    : `<div class="empty-hint">No trackers in this torrent — add the working list below for better peer discovery.</div>`;

  const webseedSection = webseedRows
    ? `<div class="rows">${webseedRows}</div>`
    : `<div class="empty-hint">No webseeds in this torrent.</div>`;

  let filesSection;
  if (hasFiles) {
    const limit = 100;
    const rows = p.files.slice(0, limit).map((f) => {
      const label = fileChipFor(f.name);
      return `<tr><td><span class="file-chip ${label.cls}">${label.text}</span></td><td class="fname">${esc(f.name)}</td><td class="fsize">${fmtBytes(f.length)}</td></tr>`;
    }).join('');
    const more = p.files.length > limit
      ? `<tr class="frow-more"><td></td><td>…and another ${p.files.length - limit} files</td><td></td></tr>` : '';
    filesSection = `
      <table class="filetable">
        <thead><tr><th></th><th>file</th><th class="fsize">size</th></tr></thead>
        <tbody>${rows}${more}
          <tr class="frow-total"><td></td><td>total</td><td class="fsize">${fmtBytes(p.length)}</td></tr>
        </tbody>
      </table>`;
  } else if (rec.fetching) {
    filesSection = `<div class="empty-hint">Contacting peers for the file list…</div>`;
  } else {
    filesSection = `
      <div class="empty-hint">File list is not in the magnet — fetch it live from peers via WebTorrent.</div>
      <button type="button" class="btn btn-ghost btn-sm fetch-files" data-act="fetch-files">Fetch file list from peers</button>`;
  }

  editor.innerHTML = `
    <div class="editor-head">
      <div class="fp-wrap">
        <div class="fp">${cells}</div>
        <div class="fp-meta">
          <span class="chip chip-source">${esc(sourceLabel(rec.source))}</span>
          <span class="chip chip-dirty" ${rec.modified ? '' : 'hidden'}>edited</span>
        </div>
      </div>
      <div class="head-actions">
        <a class="btn btn-ghost btn-sm" href="${esc(magnet)}" target="_blank" rel="noopener">Open in client</a>
        <button type="button" class="btn btn-ghost btn-sm" data-act="copy-magnet">Copy magnet</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="copy-link">Copy share link</button>
        <button type="button" class="btn btn-primary btn-sm" data-act="download" ${hasFiles ? '' : 'disabled title="File metadata is needed to build a .torrent — fetch the file list first"'}>Download .torrent</button>
      </div>
    </div>

    <div class="editor-grid">

      <section class="prop">
        <label for="name">Name</label>
        <input id="name" type="text" data-field="name" value="${esc(p.name || '')}" placeholder="unnamed torrent" dir="auto" />
      </section>

      <section class="prop">
        <label>Created</label>
        <div class="ro">${esc(createdText)}${createdByText}</div>
      </section>

      <section class="prop prop-wide">
        <label for="comment">Comment</label>
        <input id="comment" type="text" data-field="comment" value="${esc(p.comment || '')}" placeholder="no comment in this torrent" dir="auto" />
      </section>

      <section class="prop prop-wide">
        <div class="prop-head">
          <label>Trackers</label>
          <div class="prop-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-act="add-tracker">+ Add</button>
            <button type="button" class="btn btn-ghost btn-sm trace" data-act="add-stable">+ Add ${state.trackers.length} from tracker list</button>
            <button type="button" class="btn btn-ghost btn-sm danger" data-act="clear-announce">Remove all</button>
          </div>
        </div>
        ${trackerSection}
      </section>

      <section class="prop prop-wide">
        <div class="prop-head">
          <label>Webseeds</label>
          <div class="prop-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-act="add-webseed">+ Add</button>
            <button type="button" class="btn btn-ghost btn-sm danger" data-act="clear-urllist">Remove all</button>
          </div>
        </div>
        ${webseedSection}
      </section>

      <section class="prop">
        <label>Pieces</label>
        <div class="ro">${esc(piecesText)}</div>
      </section>

      <section class="prop">
        <label>Info hash</label>
        <div class="ro">${esc(p.infoHash)}</div>
      </section>

      <section class="prop prop-wide">
        <div class="prop-head"><label>Files</label></div>
        ${filesSection}
      </section>

    </div>`;

  // wire field inputs
  editor.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('input', onFieldInput);
  });
  editor.querySelectorAll('[data-ann], [data-url]').forEach((el) => {
    el.addEventListener('input', onRowInput);
  });
}

function sourceLabel(src) {
  return { file: 'torrent file', magnet: 'magnet link', url: 'remote torrent file' }[src] || src;
}

function fileChipFor(name) {
  const mt = mime.lookup(name) || '';
  let text = 'FILE', cls = '';
  if (!name) { text = 'DIR'; cls = 'dir'; }
  else if (mt.includes('video')) { text = 'VID'; }
  else if (mt.includes('audio')) { text = 'AUD'; }
  else if (mt.includes('image')) { text = 'IMG'; }
  else if (mt.includes('pdf')) { text = 'PDF'; cls = 'dir'; }
  else if (mt.includes('zip') || mt.includes('7z-') || mt.includes('iso') || mt.includes('octet-stream') || mt.includes('tar')) { text = 'ZIP'; }
  else if (mt.includes('text') || mt.includes('subrip') || mt.includes('vtt') || mt.includes('json') || mt.includes('xml') || mt.includes('javascript') || mt.includes('html')) { text = 'TXT'; }
  else if (mt.includes('word') || mt.includes('opendocument.text') || mt.includes('rtf')) { text = 'DOC'; }
  else if (mt.includes('excel') || mt.includes('spreadsheet') || mt.includes('csv')) { text = 'XLS'; }
  else if (mt.includes('powerpoint') || mt.includes('presentation')) { text = 'PPT'; }
  else if (mt.includes('font')) { text = 'FNT'; }
  else { text = 'FILE'; }
  return { text, cls };
}

/* ---------------- field editing ---------------- */

function onFieldInput(e) {
  const rec = activeRec();
  if (!rec) return;
  const field = e.target.dataset.field;
  if (field === 'name') rec.parsed.name = e.target.value || undefined;
  if (field === 'comment') rec.parsed.comment = e.target.value || undefined;
  if (e.target.value) {
    markModified(rec);
    // created/createdBy may have just appeared — refresh the read-only cell
    const ro = editor.querySelector('.editor-grid .prop:nth-child(2) .ro');
    if (ro && rec.parsed.created) {
      ro.innerHTML = `${esc(rec.parsed.created.toISOString().slice(0, 19).replace('T', ' '))}<span class="by"> · torr-edit</span>`;
    }
    renderDirtyUI(rec);
  }
}

function onRowInput(e) {
  const rec = activeRec();
  if (!rec) return;
  const i = e.target.dataset.ann;
  if (i != null) {
    rec.parsed.announce[i] = e.target.value;
  } else {
    const j = e.target.dataset.url;
    rec.parsed.urlList[j] = e.target.value;
  }
  markModified(rec);
  renderDirtyUI(rec);
}

function renderDirtyUI(rec) {
  if (!rec.modified) return;
  editor.querySelectorAll('.fp-cell').forEach((c, i) => i < 3 && c.classList.add('edited'));
  const chip = editor.querySelector('.chip-dirty');
  if (chip) chip.hidden = false;
  renderTabs();          // show dirty dots on tabs
  syncHash();
}

/* ---------------- editor actions (delegated) ---------------- */

editor.addEventListener('click', async (e) => {
  const rec = activeRec();
  if (!rec) return;

  if (e.target.closest('[data-copy-hash]')) {
    const ok = await copyText(rec.parsed.infoHash);
    toast(ok ? 'Info hash copied.' : 'Copy failed.', ok ? 'success' : 'error');
    return;
  }

  const act = e.target.closest('[data-act]');
  if (!act) return;
  const a = act.dataset.act;

  switch (a) {
    case 'copy-magnet': {
      const ok = await copyText(toMagnetURI(rec.parsed));
      toast(ok ? 'Magnet link copied.' : 'Copy failed.', ok ? 'success' : 'error');
      break;
    }
    case 'copy-link': {
      const link = location.origin + location.pathname + '#' + encodeURIComponent(toMagnetURI(rec.parsed));
      const ok = await copyText(link);
      toast(ok ? 'Share link copied.' : 'Copy failed.', ok ? 'success' : 'error');
      break;
    }
    case 'download': {
      try {
        const data = toTorrentFile(rec.parsed);
        triggerDownload(new Blob([data], { type: 'application/x-bittorrent' }), safeFilename(rec.parsed.name || rec.parsed.infoHash) + '.torrent');
        toast('Torrent file downloaded.', 'success');
      } catch (err) {
        toast('Could not build the .torrent: ' + err.message, 'error');
      }
      break;
    }
    case 'add-tracker':
      rec.parsed.announce = rec.parsed.announce || [];
      rec.parsed.announce.unshift('');
      renderEditor();
      editor.querySelector('[data-ann="0"]')?.focus();
      break;
    case 'add-webseed':
      rec.parsed.urlList = rec.parsed.urlList || [];
      rec.parsed.urlList.unshift('');
      renderEditor();
      editor.querySelector('[data-url="0"]')?.focus();
      break;
    case 'clear-announce':
      rec.parsed.announce = [];
      markModified(rec);
      renderEditor();
      break;
    case 'clear-urllist':
      rec.parsed.urlList = [];
      markModified(rec);
      renderEditor();
      break;
    case 'add-stable': {
      if (!state.trackers.length) { toast('No tracker list loaded.', 'error'); break; }
      const cur = rec.parsed.announce || [];
      const merged = Array.from(new Set([...cur, ...state.trackers]));
      rec.parsed.announce = merged;
      markModified(rec);
      renderEditor();
      toast(`Added ${state.trackers.length} trackers (${state.trackersSource}).`, 'success');
      break;
    }
    case 'fetch-files':
      fetchFilesFromPeers(rec);
      break;
  }
});

/* ---------------- delete rows (delegated) ---------------- */

editor.addEventListener('click', (e) => {
  const rec = activeRec();
  if (!rec) return;
  const delAnn = e.target.closest('[data-del-ann]');
  if (delAnn) {
    rec.parsed.announce.splice(+delAnn.dataset.delAnn, 1);
    markModified(rec);
    renderEditor();
    return;
  }
  const delUrl = e.target.closest('[data-del-url]');
  if (delUrl) {
    rec.parsed.urlList.splice(+delUrl.dataset.delUrl, 1);
    markModified(rec);
    renderEditor();
  }
});

/* ---------------- fetch files from peers ---------------- */

function ensureWT() {
  if (!state.wt && window.WebTorrent) state.wt = new window.WebTorrent();
  return state.wt;
}

function fetchFilesFromPeers(rec) {
  if (rec.fetching) return;
  if (!window.WebTorrent) { toast('WebTorrent failed to load from CDN — check your connection.', 'error'); return; }
  rec.fetching = true;
  renderEditor();

  const announce = Array.from(new Set([...(rec.parsed.announce || []), ...WSS_TRACKERS]));
  const magnet = toMagnetURI(Object.assign({}, rec.parsed, { announce }));

  let done = false;
  const finish = (msg) => {
    if (done) return;
    done = true;
    rec.fetching = false;
    if (msg) toast(msg, 'error');
    renderEditor();
  };

  setTimeout(() => finish('Could not reach peers within 45s.'), 45000);

  try {
    const client = ensureWT();
    client.add(magnet, (torrent) => {
      if (done) { try { torrent.destroy(); } catch {} return; }
      done = true;
      rec.parsed.files = torrent.files;
      rec.parsed.length = torrent.length;
      rec.parsed.lastPieceLength = torrent.lastPieceLength;
      rec.parsed.info = Object.assign({}, torrent.info);
      rec.parsed.infoBuffer = torrent.infoBuffer;
      rec.fetching = false;
      try { torrent.destroy(); } catch {}
      markModified(rec);
      renderEditor();
      toast('File list fetched from peers.', 'success');
    });
  } catch (err) {
    finish('WebTorrent error: ' + err.message);
  }
}

/* ---------------- input stage wiring ---------------- */

pasteBox.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('#pasteAdd').click(); }
});
$('#pasteAdd').addEventListener('click', () => {
  parseTextLines(pasteBox.value);
  pasteBox.value = '';
});

dropzone.addEventListener('click', () => filePicker.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); filePicker.click(); }
});
filePicker.addEventListener('change', () => {
  if (filePicker.files.length) parseFiles(filePicker.files);
  filePicker.value = '';
});

['dragover', 'dragenter'].forEach((ev) => {
  document.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
});
['dragleave', 'drop'].forEach((ev) => {
  document.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); });
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.name.endsWith('.torrent') || f.type === 'application/x-bittorrent');
  if (files.length) parseFiles(files);
});

$('#exMagnet').addEventListener('click', () => {
  parseTextLines('magnet:?xt=urn:btih:2aa4f5a7e209e54b32803d43670971c4c8caaa05&dn=ubuntu-24.04-desktop-amd64.iso&tr=https%3A%2F%2Ftorrent.ubuntu.com%2Fannounce&tr=https%3A%2F%2Fipv6.torrent.ubuntu.com%2Fannounce');
});
$('#exRemote').addEventListener('click', () => {
  parseTextLines('https://webtorrent.io/torrents/wired-cd.torrent');
});
$('#exMany').addEventListener('click', () => {
  parseTextLines(
    'magnet:?xt=urn:btih:2aa4f5a7e209e54b32803d43670971c4c8caaa05&dn=ubuntu-24.04-desktop-amd64.iso&tr=https%3A%2F%2Ftorrent.ubuntu.com%2Fannounce\n' +
    'magnet:?xt=urn:btih:a91aa7d9e3ef9f7c8a1f1e2b3c4d5e6f7a8b9c0d&dn=debian-12.5.0-amd64-netinst.iso&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce'
  );
});

/* ---------------- boot ---------------- */

async function boot() {
  loadTrackerList();
  if (location.hash && location.hash.length > 15) {
    try {
      const magnet = decodeURIComponent(location.hash.slice(1));
      parseTextLines(magnet);
    } catch { /* bad shared hash — show the input stage */ }
  }
}

boot();
