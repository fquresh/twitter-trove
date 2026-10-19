// X Collector - popup.
//
// The popup is a thin view over chrome.storage.local. The content script owns
// the collection and writes its state under the `xlc` key; the popup renders
// that state and re-renders on storage changes. This means closing the popup
// never loses progress and the Download button works after the page reloads.
//
// The popup also owns policy: it classifies the current tab with
// describeXSource() (source.js), refuses to start on X pages that have no post
// timeline, names the download after the source, and keeps a separate download
// folder per kind of source.

const STATE_KEY = 'xlc';        // status + stats, written by the content script
const TWEETS_KEY = 'xlcTweets'; // the collected tweets array
const PREFS_KEY = 'xlcPrefs';   // popup preferences
const KNOWN_KEY = window.X_KNOWN_KEY || 'xlcKnownIds'; // posts earlier runs already have
const VERSION = chrome.runtime.getManifest().version;

const el = {
  version: document.getElementById('version'),
  sourceLabel: document.getElementById('sourceLabel'),
  sourceHint: document.getElementById('sourceHint'),
  statusPill: document.getElementById('statusPill'),
  statusText: document.getElementById('statusText'),
  elapsed: document.getElementById('elapsed'),
  activity: document.getElementById('activity'),
  warning: document.getElementById('warning'),
  count: document.getElementById('count'),
  rate: document.getElementById('rate'),
  imageCount: document.getElementById('imageCount'),
  videoCount: document.getElementById('videoCount'),
  articleCount: document.getElementById('articleCount'),
  lastDate: document.getElementById('lastDate'),
  span: document.getElementById('span'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  clearBtn: document.getElementById('clearBtn'),
  mergeInput: document.getElementById('mergeInput'),
  skipKnownInput: document.getElementById('skipKnownInput'),
  knownStatus: document.getElementById('knownStatus'),
  importBtn: document.getElementById('importBtn'),
  forgetKnownBtn: document.getElementById('forgetKnownBtn'),
  importInput: document.getElementById('importInput'),
  dateFrom: document.getElementById('dateFrom'),
  dateTo: document.getElementById('dateTo'),
  folderInput: document.getElementById('folderInput'),
  options: document.getElementById('options'),
  error: document.getElementById('error'),
};

let state = null;       // mirror of storage[xlc]
let ticker = null;
let pageSource = null;  // describeXSource() for the tab the popup was opened over
let prefs = {};         // storage[xlcPrefs]
let knownIndex = {};    // storage[xlcKnownIds]: ids earlier runs already collected
let knownNotice = '';   // last import/forget result, shown under the known row

el.version.textContent = `v${VERSION}`;

// Boot ------------------------------------------------------------------
(async function init() {
  prefs = (await getStorage(PREFS_KEY)) || {};
  // v1 stored a single `folder`. It only ever applied to the Likes page, so
  // carry it forward as the Likes folder and let other sources take their own.
  if (!prefs.folders) {
    prefs.folders = typeof prefs.folder === 'string' ? { likes: prefs.folder } : {};
  }
  el.dateFrom.value = prefs.dateFrom || '';
  el.dateTo.value = prefs.dateTo || '';
  el.mergeInput.checked = prefs.merge !== false;
  el.skipKnownInput.checked = prefs.skipKnown !== false;
  if (prefs.dateFrom || prefs.dateTo) el.options.open = true;

  knownIndex = normalizeKnownIndex(await getStorage(KNOWN_KEY));

  const tab = await activeTab();
  pageSource = tab && tab.url ? describeXSource(tab.url) : null;
  el.folderInput.value = folderForKind(pageSource ? pageSource.kind : 'likes');

  state = (await getStorage(STATE_KEY)) || null;
  await reconcileWithTab();
  renderSource();
  render();
})();

function folderForKind(kind) {
  const saved = prefs.folders ? prefs.folders[kind] : undefined;
  return typeof saved === 'string' ? saved : defaultFolderFor(kind);
}

// The banner above the buttons: what this tab is, and whether it can be
// collected. Everything the user needs to know before pressing Start.
function renderSource() {
  if (!pageSource) {
    el.sourceLabel.textContent = 'No page detected';
    el.sourceHint.textContent = 'Open a tab on x.com, then reopen this popup.';
    el.sourceLabel.className = 'source-label source-bad';
    return;
  }
  el.sourceLabel.textContent = pageSource.label;
  el.sourceLabel.className = `source-label ${pageSource.timeline ? 'source-ok' : 'source-bad'}`;
  if (pageSource.timeline) {
    el.sourceHint.textContent = `Saves to Downloads/${folderPrefix()}${reportFilename()}`;
  } else {
    el.sourceHint.textContent = pageSource.reason || 'This page has no post timeline.';
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[KNOWN_KEY]) {
    knownIndex = normalizeKnownIndex(changes[KNOWN_KEY].newValue);
    render();
    return;
  }
  if (!changes[STATE_KEY]) return;
  state = changes[STATE_KEY].newValue || null;
  render();
});

for (const input of [el.dateFrom, el.dateTo, el.folderInput, el.mergeInput, el.skipKnownInput]) {
  input.addEventListener('change', () => {
    void savePrefs();
    renderSource();
    render();
  });
}

// The already-collected index -------------------------------------------
// Posts from exports you already have are skipped on Start, so re-scanning a
// timeline to pick up the posts an earlier run missed emits only the misses.
function normalizeKnownIndex(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function currentSignature() {
  return pageSource && pageSource.timeline ? xSourceSignature(pageSource) : null;
}

function knownIdsForCurrentSource() {
  const signature = currentSignature();
  return signature ? xKnownIdsFor(knownIndex, signature) : [];
}

el.importBtn.addEventListener('click', () => el.importInput.click());

el.importInput.addEventListener('change', async () => {
  const files = [...(el.importInput.files || [])];
  el.importInput.value = ''; // so the same files can be picked again
  if (files.length === 0) return;

  el.importBtn.disabled = true;
  knownNotice = `Reading ${formatInt(files.length)} file${files.length === 1 ? '' : 's'}…`;
  render();
  try {
    // Merge file by file: a 20 MB export parsed all at once is fine, sixty of
    // them at once is not.
    const next = {};
    for (const key of Object.keys(knownIndex)) {
      if (Array.isArray(knownIndex[key])) next[key] = knownIndex[key].slice();
    }
    let added = 0;
    let unreadable = 0;
    for (const file of files) {
      const text = await file.text();
      const ids = xExtractExportIds(text);
      if (ids.length === 0) {
        unreadable += 1;
        continue;
      }
      const signature = xExportSourceSignature(text);
      const before = new Set(xKnownIdsFor(next, signature)).size;
      const merged = xMergeKnownIds(next, signature, ids);
      const after = xKnownIdsFor(merged, signature);
      added += after.length - before;
      next[signature] = after;
    }
    knownIndex = next;
    await setStorage(KNOWN_KEY, knownIndex);
    const current = knownIdsForCurrentSource().length;
    const unreadableNote = unreadable ? ` ${formatInt(unreadable)} held no posts.` : '';
    knownNotice = `Imported ${formatInt(added)} new ids from ${formatInt(files.length)} file${
      files.length === 1 ? '' : 's'
    }.${unreadableNote} ${formatInt(current)} known for this page.`;
  } catch (err) {
    knownNotice = '';
    showError(`Import failed: ${err.message}`);
  }
  render();
});

el.forgetKnownBtn.addEventListener('click', async () => {
  const signature = currentSignature();
  if (!signature) return;
  const count = xKnownIdsFor(knownIndex, signature).length;
  if (count === 0) return;
  if (!confirm(`Forget ${formatInt(count)} posts already collected from "${pageSource.label}"? A re-scan would collect them again.`)) {
    return;
  }
  const next = { ...knownIndex };
  delete next[signature];
  knownIndex = next;
  await setStorage(KNOWN_KEY, knownIndex);
  knownNotice = `Forgot ${formatInt(count)} ids for this page.`;
  render();
});

// If storage says "collecting" but no content script answers, the page was
// reloaded or closed mid-run. Mark it stopped so the buttons make sense and
// whatever was persisted stays downloadable.
async function reconcileWithTab() {
  if (!state || (state.status !== 'collecting' && state.status !== 'paused')) return;
  const tab = await collectorTab();
  if (!tab) {
    state.status = 'stopped';
    state.stats = state.stats || {};
    state.stats.activity = 'Interrupted (the X tab reloaded or closed). Collected posts were kept.';
    await setStorage(STATE_KEY, state);
  }
}

// Actions ---------------------------------------------------------------
el.startBtn.addEventListener('click', async () => {
  hideError();
  const tab = await activeTab();
  if (!tab || !tab.url) return showError('Cannot read the current tab.');

  // Re-classify at click time: the tab may have navigated since the popup opened.
  pageSource = describeXSource(tab.url);
  renderSource();
  if (pageSource.kind === 'not-x') {
    return showError('Open a page on x.com first. Any timeline works: Likes, Bookmarks, Home, a profile, search results, a list, or a thread.');
  }
  if (!pageSource.timeline) {
    return showError(`${pageSource.label}: ${pageSource.reason} Open a timeline instead - a profile, Likes, Bookmarks, search results, a list, or a thread.`);
  }

  // Collecting one source on top of another would produce a mixed export.
  if (el.mergeInput.checked && state && state.source && state.stats && state.stats.count > 0) {
    const kept = state.source;
    if (xSourceSignature(kept) !== xSourceSignature(pageSource)) {
      return showError(`${formatInt(state.stats.count)} posts from "${kept.label}" are still held. Download them, or press Clear, before collecting ${pageSource.label}. You can also untick "Keep posts already collected".`);
    }
  }

  setBusy('Injecting collector…');

  // X is an SPA; manifest content_scripts often do not fire on in-app
  // navigation, so inject explicitly. The scripts no-op if already present.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['source.js', 'known.js', 'content.js'] });
  } catch (err) {
    console.warn('inject:', err.message);
  }

  const pong = await ping(tab.id, 5);
  if (!pong) {
    render();
    return showError('The collector did not respond. Reload the X tab and try again.');
  }
  if (pong.version !== VERSION) {
    render();
    return showError(`An older collector (v${pong.version}) is still loaded in this tab. Reload the X tab, then press Start.`);
  }

  try {
    await savePrefs();
  } catch (err) {
    console.warn('savePrefs:', err.message); // cosmetic; do not block Start
  }
  const dateRange = {
    from: el.dateFrom.value ? monthStart(el.dateFrom.value).toISOString() : null,
    to: el.dateTo.value ? monthAfter(el.dateTo.value).toISOString() : null,
  };
  if (dateRange.from && dateRange.to && dateRange.from >= dateRange.to) {
    render();
    return showError('"Tweets from" must be before "Tweets to".');
  }

  try {
    await sendToTab(tab.id, {
      action: 'start',
      dateRange,
      merge: el.mergeInput.checked,
      skipKnown: el.skipKnownInput.checked,
    });
  } catch (err) {
    render();
    return showError(`Could not start: ${err.message}`);
  }
});

el.pauseBtn.addEventListener('click', async () => {
  if (!state) return;
  const action = state.status === 'paused' ? 'resume' : 'pause';
  const tab = await collectorTab();
  try {
    if (!tab) throw new Error('no collector is running in any X tab');
    await sendToTab(tab.id, { action });
  } catch (err) {
    showError(`Could not ${action}: ${err.message}. Reload the X tab.`);
  }
});

el.stopBtn.addEventListener('click', async () => {
  const tab = await collectorTab();
  try {
    if (!tab) throw new Error('gone');
    await sendToTab(tab.id, { action: 'stop' });
  } catch {
    // Content script is gone; stop locally so the UI is usable.
    if (state) {
      state.status = 'stopped';
      await setStorage(STATE_KEY, state);
    }
  }
});

el.downloadBtn.addEventListener('click', async () => {
  hideError();
  const stored = await getStorage(TWEETS_KEY);
  const tweets = Array.isArray(stored) ? stored : [];
  if (tweets.length === 0) return showError('No posts to download yet.');

  el.downloadBtn.disabled = true;
  el.activity.textContent = `Building HTML for ${tweets.length} posts…`;
  try {
    const filename = await downloadReport(tweets);
    render();
    el.activity.textContent = `Saved ${tweets.length} posts to Downloads/${filename}`;
  } catch (err) {
    render();
    showError(`Download failed: ${err.message}`);
  }
});

el.clearBtn.addEventListener('click', async () => {
  const count = (state && state.stats && state.stats.count) || 0;
  if (count > 0 && !confirm(`Discard ${count} collected posts? Download first if you want to keep them.`)) return;
  try {
    await chrome.storage.local.remove([STATE_KEY, TWEETS_KEY]);
  } catch (err) {
    return showError(`Could not clear the collected posts: ${err.message}`);
  }
  state = null;
  hideError();
  renderSource();
  render();
});

// Download --------------------------------------------------------------
// The file is named after the source the posts CAME FROM (recorded in state by
// the content script), not the tab the popup happens to sit over now.
function collectedSource() {
  if (state && state.source) return state.source;
  if (pageSource && pageSource.timeline) return pageSource;
  return { kind: 'unknown', label: 'X timeline', slug: 'timeline' };
}

async function downloadReport(tweets) {
  const src = collectedSource();
  const html = buildReportHtml(tweets, {
    version: VERSION,
    source: src,
    collectedAt: new Date().toISOString(),
    count: tweets.length,
    skippedKnown: (state && state.stats && state.stats.skippedKnown) || 0,
  });
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const filename = folderPrefix() + reportFilename();
  try {
    await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  } finally {
    // Give the browser a moment to open the blob before revoking it.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  return filename;
}

function reportFilename() {
  const slug = collectedSource().slug || 'timeline';
  return `x-${slug}-${new Date().toISOString().split('T')[0]}.html`;
}

function folderPrefix() {
  const folder = (el.folderInput.value || '').trim().replace(/^[/\\]+|[/\\]+$/g, '');
  return folder ? `${folder}/` : '';
}

// Rendering -------------------------------------------------------------
function render() {
  const status = state ? state.status : 'idle';
  const stats = (state && state.stats) || {};
  const tweetCount = stats.count || 0;
  const active = status === 'collecting' || status === 'paused';

  const pillLabel = {
    idle: 'Ready',
    collecting: 'Collecting',
    paused: 'Paused',
    complete: 'Complete',
    stopped: 'Stopped',
    error: 'Error',
  }[status] || 'Ready';
  el.statusPill.className = `pill pill-${status in { idle: 1, collecting: 1, paused: 1, complete: 1, stopped: 1, error: 1 } ? status : 'idle'}`;
  el.statusText.textContent = pillLabel;

  el.activity.textContent =
    stats.activity || (state ? '' : 'Open any X timeline, then press Start.');

  el.count.textContent = formatInt(tweetCount);
  el.imageCount.textContent = formatInt(stats.imageCount || 0);
  el.videoCount.textContent = formatInt(stats.videoCount || 0);
  el.articleCount.textContent = formatInt(stats.articleCount || 0);
  el.lastDate.textContent = stats.lastDate || '–';

  const parts = [];
  if (stats.oldestTimestamp && stats.newestTimestamp) {
    parts.push(`Post dates ${shortDate(stats.oldestTimestamp)} → ${shortDate(stats.newestTimestamp)}`);
  }
  if (stats.skippedKnown) parts.push(`${formatInt(stats.skippedKnown)} already collected, skipped`);
  if (stats.skippedOutOfRange) parts.push(`${formatInt(stats.skippedOutOfRange)} outside date range`);
  if (stats.retries) parts.push(`${stats.retries} retries`);
  el.span.textContent = parts.join(' · ');

  // Warnings that explain a slow, stalled, or possibly incomplete run.
  const warnings = [];
  if (stats.hiddenMs > 5000) {
    warnings.push(`The X tab spent ${formatDuration(stats.hiddenMs)} in the background. Chrome freezes rendering in hidden tabs, so collection waits there; keep the tab visible.`);
  }
  if (stats.maxStepLagMs > 1500) {
    warnings.push(`X took up to ${formatDuration(stats.maxStepLagMs)} to render each scroll step. Collection is slow but complete: it waits for the posts to appear.`);
  }
  if (status === 'error' && state.error) warnings.push(state.error);
  if (status === 'complete' && stats.endVerified === false && tweetCount > 0) {
    warnings.push('X never showed an end-of-timeline marker, so this may not be the whole timeline. Press Start again with "Keep posts already collected" ticked to continue from here.');
  }
  if (
    !active && tweetCount > 0 && state && state.source && pageSource &&
    pageSource.timeline && xSourceSignature(state.source) !== xSourceSignature(pageSource)
  ) {
    warnings.push(`Held posts came from "${state.source.label}". Download or Clear them before collecting this page.`);
  }
  el.warning.textContent = warnings.join(' ');
  el.warning.classList.toggle('hidden', warnings.length === 0);

  const knownHere = knownIdsForCurrentSource();
  if (knownNotice) {
    el.knownStatus.textContent = knownNotice;
  } else if (!pageSource || !pageSource.timeline) {
    el.knownStatus.textContent = '';
  } else if (knownHere.length) {
    el.knownStatus.textContent = `${formatInt(knownHere.length)} posts from earlier exports are known for this page; Start skips them and exports only new ones.`;
  } else {
    el.knownStatus.textContent = 'No earlier exports imported for this page yet. Import one to skip posts you already have.';
  }
  el.importBtn.disabled = active;
  el.forgetKnownBtn.disabled = active || knownHere.length === 0;

  const collectable = !pageSource || pageSource.timeline; // unknown tab: let Start explain
  el.startBtn.disabled = active || !collectable;
  el.startBtn.textContent =
    !active && knownHere.length && el.skipKnownInput.checked
      ? `Start (skip ${formatInt(knownHere.length)} known)`
      : !active && tweetCount > 0 && el.mergeInput.checked
        ? 'Start (keep collected)'
        : 'Start';
  el.pauseBtn.disabled = !active;
  el.pauseBtn.textContent = status === 'paused' ? 'Resume' : 'Pause';
  el.stopBtn.disabled = !active;
  el.downloadBtn.disabled = tweetCount === 0;
  el.clearBtn.disabled = active || tweetCount === 0;
  for (const input of [el.dateFrom, el.dateTo, el.mergeInput, el.skipKnownInput]) input.disabled = active;

  renderElapsed();
  if (active && !ticker) ticker = setInterval(renderElapsed, 1000);
  if (!active && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function renderElapsed() {
  const stats = (state && state.stats) || null;
  if (!stats || !stats.startedAt) {
    el.elapsed.textContent = '';
    el.rate.textContent = '–';
    return;
  }
  const active = state.status === 'collecting' || state.status === 'paused';
  const end = active ? Date.now() : stats.updatedAt || Date.now();
  const ms = Math.max(0, end - stats.startedAt);
  el.elapsed.textContent = formatDuration(ms);
  const minutes = ms / 60000;
  el.rate.textContent = minutes >= 0.25 ? formatInt(Math.round((stats.count || 0) / minutes)) : '–';
}

function setBusy(text) {
  el.startBtn.disabled = true;
  el.activity.textContent = text;
}

function showError(message) {
  el.error.textContent = message;
  el.error.classList.remove('hidden');
}

function hideError() {
  el.error.classList.add('hidden');
}

// Helpers ---------------------------------------------------------------
async function savePrefs() {
  const kind = pageSource ? pageSource.kind : 'likes';
  prefs = {
    ...prefs,
    dateFrom: el.dateFrom.value || '',
    dateTo: el.dateTo.value || '',
    merge: el.mergeInput.checked,
    skipKnown: el.skipKnownInput.checked,
    folders: { ...(prefs.folders || {}), [kind]: el.folderInput.value },
  };
  delete prefs.folder; // superseded by `folders`
  await setStorage(PREFS_KEY, prefs);
}

function monthStart(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(y, m - 1, 1);
}

function monthAfter(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(y, m, 1);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// The X tab where a collector is running or paused, whichever window it is
// in. The popup may be opened from another tab while collection continues.
async function collectorTab() {
  const candidates = [];
  const active = await activeTab();
  if (active) candidates.push(active);
  try {
    const xTabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    for (const t of xTabs) if (!active || t.id !== active.id) candidates.push(t);
  } catch {
    // no host access; fall back to the active tab only
  }
  for (const tab of candidates) {
    const pong = await ping(tab.id);
    if (pong && (pong.status === 'collecting' || pong.status === 'paused')) return tab;
  }
  return null;
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function ping(tabId, attempts = 1) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      if (res && res.version) return res;
    } catch {
      // not injected yet
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

function getStorage(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, (r) => resolve(r[key])));
}

function setStorage(key, value) {
  return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve));
}

function formatInt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(sec).padStart(2, '0')}`;
}

function shortDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
}
