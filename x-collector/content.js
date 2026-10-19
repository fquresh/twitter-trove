// X Collector - content script.
//
// Collection engine. Runs inside ANY X page that renders a post timeline -
// Likes, Bookmarks, Home, a profile and its tabs, search results, a list, a
// community, a thread, quotes - walks the virtualized timeline one viewport at
// a time, captures every post that mounts, and persists progress to
// chrome.storage.local so the popup can close and reopen without losing
// anything.
//
// The engine is timeline-agnostic on purpose: every one of those surfaces
// renders the same `article[data-testid="tweet"]` nodes inside the same
// virtualized scroller, so one loop serves them all. Only the labels, the
// download name, and the stop heuristics care which page it is.
//
// Why "one viewport at a time": X renders only a window of posts around the
// viewport. Jumping straight to the bottom of the page skips over posts that
// are never mounted, which is how the old collector lost posts. Stepping by
// ~90% of a viewport guarantees every post passes through the mounted window.
//
// A step is only finished once the DOM has settled (see stepAndSettle): X's
// virtualizer renders the window for the current scroll position
// asynchronously, and on a loaded machine it lags far enough behind a fixed
// cadence that intermediate windows are never mounted at all. Trusting a fixed
// delay is what loses posts; waiting for the mount is what finds them.
//
// The engine also refuses to scroll while the tab is hidden (Chrome freezes
// requestAnimationFrame there, so X stops re-rendering windows and a scroll
// would walk past unmounted posts), and it does not call a run complete unless
// X showed an end-of-timeline marker or a bottom loader that never delivered.
//
// This script never refuses to run based on the page address. The popup owns
// that policy (see source.js), which also lets the headless test harness drive
// the engine against a local fixture.

(() => {
  const VERSION = '2.1.0';

  // Guard against multiple injections (manifest match + programmatic injection).
  // A stale script from an older extension build stays in the page until reload;
  // the popup compares the version returned by `ping` and asks for a reload.
  if (window._xCollectorVersion === VERSION) {
    return;
  }
  window._xCollectorVersion = VERSION;

  const STATE_KEY = 'xlc';        // small: status + stats + error (written ~1/s)
  const TWEETS_KEY = 'xlcTweets'; // large: the tweets array (written every few seconds)

  // Tunables --------------------------------------------------------------
  // The step is derived per-step from the window X actually has mounted (see
  // nextStep): half of it, so a single unrendered window cannot leave a gap.
  // These two bound the derivation.
  const STEP_MIN_FRACTION = 0.5;        // of innerHeight, the floor when X keeps a tight window
  const STEP_MAX_FRACTION = 1.8;        // of innerHeight, the ceiling for a generous one
  const STEP_FALLBACK_FRACTION = 0.9;   // of innerHeight, when nothing is mounted to measure
  const SETTLE_MIN_MS = 50;             // always give the virtualizer this long after a step
  const SETTLE_QUIET_MS = 80;           // DOM quiet this long after the last mount = the window rendered
  const SETTLE_IDLE_MS = 250;           // no mount yet: only move on if the window already covers the viewport
  const COVERAGE_CHECK_MS = 100;        // throttle for the mounted-window bounding-box measurement
  const SETTLE_MAX_MS = 1500;           // never wait longer than this for one step to render
  const END_MARKER_GRACE_MS = 250;      // at the bottom: trust X's end marker after this long without growth
  const BOTTOM_POLL_MS = 150;           // poll interval while waiting for X to load more
  const STALL_LIMIT_MS = 90000;         // give up on a load that never arrives after this long
  const NUDGE_EVERY_MS = 3000;          // while stalled: click Retry / wiggle scroll
  const PERSIST_STATS_MS = 1000;        // stats throttle
  const PERSIST_TWEETS_MS = 4000;       // tweets array throttle (can be MBs)
  const CONSECUTIVE_OLDER_LIMIT = 50;   // date filter: stop after N older tweets in a row
  const NAV_CONFIRM_CHECKS = 3;         // loop passes on a different source before stopping
  const END_MARKERS = [                 // what X says when a timeline has nothing left
    "you're all caught up",
    'you’re all caught up',
    "you've reached the end",
    'you’ve reached the end',
    "that's everything",
    'that’s everything',
    'no more posts',
    'end of your likes',
  ];

  // State -----------------------------------------------------------------
  let status = 'idle';                  // idle | collecting | paused | complete | stopped | error
  let runToken = 0;
  let tweets = [];
  let ids = new Set();                  // seen this run (incl. merged posts)
  let knownIds = new Set();             // collected by an earlier run: skipped, never re-evaluated
  let dateRange = { from: null, to: null };
  let source = null;                    // describeXSource() snapshot taken at Start
  let sourceSig = '';                   // its signature, to notice SPA navigation
  let offSourceChecks = 0;
  let stats = null;
  let observer = null;
  let scanScheduled = false;
  let lastMutationAt = 0;               // last DOM mount/unmount, drives the settle wait
  let lastStatsPersist = 0;
  let lastTweetsPersist = 0;
  let lastPersistedCount = -1;          // tweets.length at the last storage write
  let writing = false;                  // a storage write is in flight
  let writeDone = null;                 // resolves when it lands
  let consecutiveOlder = 0;

  function freshStats() {
    return {
      count: 0,
      imageCount: 0,
      videoCount: 0,
      articleCount: 0,
      lastDate: '-',
      oldestTimestamp: null,
      newestTimestamp: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      scrolls: 0,
      scrollPx: 0,          // total distance scrolled, to report the average step
      settleMs: 0,          // total time spent waiting for X to render a step
      settleMaxed: 0,       // steps that never rendered and hit the wait cap
      settleIdle: 0,        // steps whose window already covered the new viewport
      bottomWaitMs: 0,      // total time spent at the bottom waiting for the next page
      stalledMs: 0,
      retries: 0,
      skippedOutOfRange: 0,
      skippedKnown: 0,      // posts an earlier run already has, skipped this run
      maxStepLagMs: 0,      // worst delay between a scroll step and X rendering its window
      endVerified: null,    // true: X showed its end marker; false: bottom reached without one
      hiddenMs: 0,
      activity: 'Starting…',
    };
  }

  // Messaging -------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.action) {
      case 'ping':
        sendResponse({ version: VERSION, status, count: tweets.length, source: currentSource() });
        return false;
      case 'start':
        startCollection(message.dateRange || {}, Boolean(message.merge), Boolean(message.skipKnown))
          .catch((err) => fail(`Collector crashed: ${err.message}`));
        sendResponse({ ok: true });
        return false;
      case 'pause':
        if (status === 'collecting') {
          status = 'paused';
          setActivity('Paused');
          void persist(true);
        }
        sendResponse({ ok: true, status });
        return false;
      case 'resume':
        if (status === 'paused') {
          status = 'collecting';
          setActivity('Resuming…');
          void persist(true);
        }
        sendResponse({ ok: true, status });
        return false;
      case 'stop':
        stopCollection('stopped');
        sendResponse({ ok: true, status });
        return false;
      default:
        return false;
    }
  });

  // Source ----------------------------------------------------------------
  // source.js is injected alongside this file. If it is somehow missing, fall
  // back to an "unknown" source rather than failing the run: the engine works
  // the same either way, only the labels get vaguer.
  function currentSource() {
    if (typeof window.describeXSource !== 'function') {
      return { kind: 'unknown', label: 'X timeline', slug: 'timeline', handle: null, query: null, id: null, timeline: true, reason: null, url: location.href };
    }
    return window.describeXSource(location.href);
  }

  function signatureOf(src) {
    if (typeof window.xSourceSignature === 'function') return window.xSourceSignature(src);
    return src ? `${src.kind}|${src.handle || ''}|${src.query || ''}|${src.id || ''}` : '';
  }

  // X is a single-page app, so a click can swap the timeline under us without a
  // page load. Collecting across that boundary would silently mix two sources
  // into one export, so stop instead and keep what was collected.
  function checkStillOnSource() {
    const now = currentSource();
    if (signatureOf(now) === sourceSig) {
      offSourceChecks = 0;
      return true;
    }
    offSourceChecks += 1;
    if (offSourceChecks < NAV_CONFIRM_CHECKS) return true;
    stopCollection(
      'stopped',
      `Stopped: the tab moved from ${source ? source.label : 'the starting page'} to ${now.label}. ${tweets.length} posts kept.`
    );
    return false;
  }

  // Lifecycle -------------------------------------------------------------
  async function startCollection(range, merge, skipKnown) {
    runToken += 1;
    const token = runToken;

    dateRange = {
      from: range.from ? new Date(range.from) : null,
      to: range.to ? new Date(range.to) : null,
    };
    if (dateRange.from && Number.isNaN(dateRange.from.getTime())) dateRange.from = null;
    if (dateRange.to && Number.isNaN(dateRange.to.getTime())) dateRange.to = null;

    tweets = [];
    ids = new Set();
    knownIds = new Set();
    consecutiveOlder = 0;
    source = currentSource();
    sourceSig = signatureOf(source);
    offSourceChecks = 0;
    stats = freshStats();

    // Posts an earlier run already collected are skipped rather than collected
    // again, so re-scanning a timeline for the posts that were missed emits only
    // the misses. Kept separate from `ids` so a merged post (already in the
    // export) can never be suppressed by its own known entry.
    if (skipKnown) {
      const index = await readKnownIndex();
      knownIds = new Set(knownIdsFor(index, sourceSig));
    }

    if (merge) {
      const prior = await readStoredTweets();
      if (Array.isArray(prior)) {
        for (const t of prior) {
          if (t && t.id && !ids.has(t.id)) {
            ids.add(t.id);
            tweets.push(t);
          }
        }
        recomputeStats();
      }
    }

    status = 'collecting';
    const knownNote = knownIds.size ? ` · ${knownIds.size} already collected will be skipped` : '';
    setActivity(
      (merge && tweets.length ? `Resuming ${source.label} with ${tweets.length} kept` : `Scrolling ${source.label} to the top…`) + knownNote
    );
    await persist(true);

    console.log('[XC] start', { source: source.label, dateRange, merge, skipKnown, kept: tweets.length, known: knownIds.size });

    window.scrollTo({ top: 0, behavior: 'instant' });
    await sleep(600);

    const found = await waitForTweets(15000, token);
    if (!alive(token)) return;
    if (!found) {
      fail(
        source.kind === 'profile-media'
          ? 'No posts found. The Media tab renders a photo grid, not posts - use the main profile tab instead.'
          : `No posts found on this page (${source.label}). Scroll it once to make sure posts load, then press Start again.`
      );
      return;
    }

    startObserver();
    try {
      await runLoop(token);
    } finally {
      if (token === runToken) stopObserver();
    }
  }

  function stopCollection(finalStatus, reason) {
    runToken += 1; // invalidates the running loop
    stopObserver();
    if (status === 'collecting' || status === 'paused') {
      status = finalStatus;
      setActivity(reason || (finalStatus === 'complete' ? `Reached the end of ${source ? source.label : 'the timeline'}` : 'Stopped'));
      void persist(true);
      rememberCollected();
      console.log(`[XC] ${finalStatus}:`, tweets.length, 'posts');
    }
  }

  function fail(message) {
    runToken += 1;
    stopObserver();
    status = 'error';
    setActivity(message);
    void persist(true, message);
    rememberCollected();
    console.error('[XC]', message);
  }

  function alive(token) {
    return token === runToken && (status === 'collecting' || status === 'paused');
  }

  // Main loop -------------------------------------------------------------
  async function runLoop(token) {
    let stalledSince = null;
    let lastNudge = 0;
    let lastHeight = pageHeight();
    let lastSeen = seenCount();
    let loaderSeen = false;

    while (alive(token)) {
      if (status === 'paused') {
        await sleep(300);
        continue;
      }

      if (!checkStillOnSource()) return;

      // Chrome freezes requestAnimationFrame in a background tab, and X's
      // virtualized timeline renders through it. Scrolling on would walk past
      // posts that were never mounted, so hold position until the tab is back.
      if (document.hidden) {
        setActivity('Waiting: the X tab is in the background, where Chrome freezes rendering. Bring it to the front to keep collecting.');
        await sleep(1000);
        continue;
      }

      scanDom();
      if (!alive(token)) return;

      // Date filter. A Likes timeline is ordered by like time and search by
      // relevance, so one old post means nothing on either. Only a long run of
      // them is evidence that the useful range is behind us.
      if (dateRange.from && consecutiveOlder >= CONSECUTIVE_OLDER_LIMIT) {
        finish(`Done: ${CONSECUTIVE_OLDER_LIMIT} posts in a row were older than the "from" date`);
        return;
      }

      // A stall in progress means the engine is parked at the bottom waiting for
      // X to deliver the next page. Stay there until it does or the limit runs
      // out - including while a nudge wiggle has the viewport momentarily off
      // the bottom. Stepping here is what used to restart the stall timer
      // forever (the wiggle made the loop think X had grown the timeline).
      if (stalledSince === null && !atBottom()) {
        await stepAndSettle();
        if (!alive(token)) return;
        continue;
      }

      // At the bottom of what X has rendered. Wait for it to load more.
      const height = pageHeight();
      const seen = seenCount();
      if (height > lastHeight || seen > lastSeen) {
        // X delivered a page. Walk down into it before waiting again - arming
        // the stall here instead would park the engine above the new posts.
        stalledSince = null;
        loaderSeen = false; // the loader did its job
        lastHeight = height;
        lastSeen = seen;
        continue;
      }

      const probe = bottomProbe();
      if (probe.loading) loaderSeen = true;

      if (stalledSince === null) {
        stalledSince = Date.now();
        lastNudge = Date.now();
      }
      const stalledFor = Date.now() - stalledSince;
      stats.stalledMs = stalledFor;

      // X says the timeline is over: stop as soon as it does instead of sitting
      // out the whole stall window.
      if (probe.endMarker && stalledFor >= END_MARKER_GRACE_MS) {
        finishAtBottom(loaderSeen);
        return;
      }
      if (stalledFor >= STALL_LIMIT_MS) {
        finishAtBottom(loaderSeen);
        return;
      }

      if (Date.now() - lastNudge >= NUDGE_EVERY_MS) {
        lastNudge = Date.now();
        nudge();
      }

      setActivity(
        stalledFor < 3000
          ? 'Waiting for X to load more…'
          : `Waiting for X to load more… ${Math.round(stalledFor / 1000)}s (gives up at ${STALL_LIMIT_MS / 1000}s)`
      );
      void persist(false);
      const waitStart = Date.now();
      await sleep(BOTTOM_POLL_MS);
      stats.bottomWaitMs += Date.now() - waitStart;
    }
  }

  // Posts the engine has evaluated this run: collected, skipped as already
  // collected, or skipped as out of range. Any of those means X handed over a
  // page, which is what the stall timer is really watching for - the collected
  // count alone would sit still through a page of already-known posts.
  function seenCount() {
    return tweets.length + stats.skippedKnown + stats.skippedOutOfRange;
  }

  // Scroll one step, then wait until X has actually rendered the window for the
  // new position before scanning. The old engine slept a fixed 120 ms and
  // trusted the DOM to have caught up; when the virtualizer lags (a busy main
  // thread, a big page), whole windows were never mounted and their posts were
  // lost. Waiting for the mount is what finds them.
  //
  // Speed comes from two places: the step is as large as the mounted window
  // safely allows, and the wait ends as soon as the mount lands instead of
  // running out a fixed timer.
  async function stepAndSettle() {
    const step = nextStep();
    lastMutationAt = 0;
    const startedAt = Date.now();
    window.scrollBy({ top: step, behavior: 'instant' });
    stats.scrolls += 1;
    stats.scrollPx += step;
    setActivity(`Scrolling… ${stats.scrolls} steps`);
    void persist(false);

    let outcome = 'maxed';
    let lastCoverageCheck = 0;
    for (;;) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= SETTLE_MAX_MS) break;
      if (elapsed >= SETTLE_MIN_MS) {
        const now = Date.now();
        if (lastMutationAt && now - lastMutationAt >= SETTLE_QUIET_MS) {
          // A quiet DOM is not enough on its own: X can commit a window it
          // measured for an earlier scroll position, which would read as a
          // render for this one. The window has to actually reach the bottom of
          // the viewport before this step counts as landed.
          if (now - lastCoverageCheck >= COVERAGE_CHECK_MS) {
            lastCoverageCheck = now;
            if (viewportCovered()) {
              outcome = 'settled';
              break;
            }
          }
        } else if (!lastMutationAt && elapsed >= SETTLE_IDLE_MS && viewportCovered()) {
          outcome = 'idle';
          break;
        }
      }
      await settleTick();
    }

    const settledMs = Date.now() - startedAt;
    stats.settleMs += settledMs;
    if (outcome === 'maxed') stats.settleMaxed += 1;
    else if (outcome === 'idle') stats.settleIdle += 1;
    if (lastMutationAt) {
      stats.maxStepLagMs = Math.max(stats.maxStepLagMs, lastMutationAt - startedAt);
    }
    scanDom();
  }

  // How far to move: half of the window X has mounted. Every post is mounted
  // for a span of scroll positions as tall as that window, so stepping by half
  // of it survives a step whose render never lands (the neighbouring windows
  // still cover the posts in between) while going as fast as X's own overscan
  // permits. X keeps more mounted on a desktop timeline than the old fixed 0.9
  // viewport assumed, so this is usually the larger step.
  function nextStep() {
    const floor = Math.round(window.innerHeight * STEP_MIN_FRACTION);
    const ceiling = Math.round(window.innerHeight * STEP_MAX_FRACTION);
    const span = mountedBounds().span;
    const wanted = span > 0 ? Math.round(span / 2) : Math.round(window.innerHeight * STEP_FALLBACK_FRACTION);
    const room = pageHeight() - window.innerHeight - window.scrollY;
    return Math.max(1, Math.min(ceiling, Math.max(floor, wanted), Math.max(floor, room)));
  }

  // Bounding box of the posts X currently has mounted, in viewport coordinates.
  // Measured over every mounted post rather than the first and last in DOM
  // order, which X does not promise.
  function mountedBounds() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    let top = Infinity;
    let bottom = -Infinity;
    for (const article of articles) {
      const rect = article.getBoundingClientRect();
      if (rect.top < top) top = rect.top;
      if (rect.bottom > bottom) bottom = rect.bottom;
    }
    const span = articles.length ? bottom - top : 0;
    return { span: span > 0 ? span : 0, bottom: articles.length ? bottom : -Infinity };
  }

  // True when what X has mounted reaches the bottom of the viewport, which is
  // what a render for the current scroll position looks like.
  function viewportCovered() {
    return mountedBounds().bottom >= window.innerHeight;
  }

  // requestAnimationFrame is the cheapest way to notice a mount; the timeout
  // keeps the loop alive if the tab goes hidden mid-step, where rAF stops.
  function settleTick() {
    return Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => resolve())),
      sleep(50),
    ]);
  }

  function finish(reason) {
    scanDom();
    stopCollection('complete', reason);
  }

  // Nothing new at the bottom for the whole stall window. Say which kind of
  // "done" this is instead of always claiming the end of the timeline.
  function finishAtBottom(loaderSeen) {
    scanDom();
    const label = source ? source.label : 'the timeline';
    if (bottomProbe().endMarker) {
      stats.endVerified = true;
      stopCollection('complete', `Reached the end of ${label}: X showed its end-of-timeline marker. ${tweets.length} posts kept.`);
      return;
    }
    if (loaderSeen || bottomProbe().loading) {
      stopCollection(
        'stopped',
        `Stopped at the bottom of ${label}: X kept showing a loading indicator but delivered nothing new for ${Math.round(
          STALL_LIMIT_MS / 1000
        )}s. ${tweets.length} posts kept - press Start with "Keep posts already collected" to carry on from here.`
      );
      return;
    }
    stats.endVerified = false; // reached the bottom, but X never confirmed it
    stopCollection(
      'complete',
      `Reached the bottom of ${label}: X had nothing more to load for ${Math.round(STALL_LIMIT_MS / 1000)}s and showed no end-of-timeline marker. ${
        tweets.length
      } posts kept - press Start with "Keep posts already collected" if you expected more.`
    );
  }

  // What is under the bottom of the viewport: X's end-of-timeline marker, or a
  // loader that is still waiting for a page. Only meaningful at the bottom of
  // the document, where the engine calls it.
  function bottomProbe() {
    const probe = { endMarker: false, loading: false };
    if (!atBottom()) return probe;
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight - 6);
    for (const el of document.elementsFromPoint(x, y)) {
      // Post text is not a timeline marker, and a video's progress bar is not a
      // loader waiting for a page.
      if (el.closest('article[data-testid="tweet"]')) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (text && text.length <= 140 && END_MARKERS.some((marker) => text.includes(marker))) probe.endMarker = true;
      if (el.matches('[role="progressbar"], [data-testid="spinner"]')) probe.loading = true;
    }
    return probe;
  }

  function atBottom() {
    return window.innerHeight + window.scrollY >= pageHeight() - 40;
  }

  function pageHeight() {
    return Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  }

  // X sometimes replaces the loader with "Something went wrong. Retry". Click
  // it. Otherwise nudge the scroll position so the intersection observer that
  // drives X's infinite loader fires again. The wiggle stays small and is
  // restored at once: the loop polls faster than a long restore, and a big jump
  // would read as the reader having scrolled away from the bottom.
  function nudge() {
    const buttons = document.querySelectorAll('[role="button"]');
    for (const b of buttons) {
      const text = (b.textContent || '').trim().toLowerCase();
      if (text === 'retry' || text === 'try again') {
        stats.retries += 1;
        console.log('[XC] clicking Retry');
        b.click();
        return;
      }
    }
    const back = window.scrollY;
    window.scrollBy({ top: -Math.round(window.innerHeight * 0.25), behavior: 'instant' });
    setTimeout(() => window.scrollTo({ top: back, behavior: 'instant' }), 60);
  }

  function waitForTweets(timeoutMs, token) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function check() {
        if (!alive(token)) return resolve(false);
        if (document.querySelector('article[data-testid="tweet"]')) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 250);
      })();
    });
  }

  // DOM observation -------------------------------------------------------
  // Every article that mounts is scanned right away, independent of the
  // scroll cadence, so nothing slips through between loop iterations.
  function startObserver() {
    stopObserver();
    observer = new MutationObserver(() => {
      lastMutationAt = Date.now();
      if (scanScheduled) return;
      scanScheduled = true;
      requestAnimationFrame(() => {
        scanScheduled = false;
        if (status === 'collecting') scanDom();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function scanDom() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      // Cheap first pass: the id comes off the timestamp link, so an article
      // that is already captured (or already known from an earlier run) costs
      // one querySelector instead of a full extraction. Without this the engine
      // re-extracts every mounted post on every animation frame, which is what
      // starves X's own rendering on a large timeline.
      const id = tweetIdOf(article);
      if (!id || ids.has(id)) continue;
      if (knownIds.has(id)) {
        stats.skippedKnown += 1;
        ids.add(id); // never re-evaluate
        continue;
      }

      let data;
      try {
        data = extractTweetData(article, id);
      } catch (err) {
        console.error('[XC] extract failed', err);
        continue;
      }
      if (!data || ids.has(data.id)) continue;

      if (dateRange.from || dateRange.to) {
        const when = new Date(data.timestamp);
        if (dateRange.from && when < dateRange.from) {
          consecutiveOlder += 1;
          stats.skippedOutOfRange += 1;
          ids.add(data.id); // never re-evaluate
          continue;
        }
        consecutiveOlder = 0;
        if (dateRange.to && when >= dateRange.to) {
          stats.skippedOutOfRange += 1;
          ids.add(data.id);
          continue;
        }
      }

      // `sourceIndex` is the position in whatever timeline was collected, 0
      // first. `likeIndex` is the same number under its original name, kept
      // because the three export readers already parse it.
      data.sourceIndex = tweets.length;
      data.likeIndex = tweets.length;
      ids.add(data.id);
      tweets.push(data);
      bump(data);
    }
  }

  function bump(t) {
    stats.count = tweets.length;
    if (t.images && t.images.length) stats.imageCount += 1;
    if (t.hasVideo) stats.videoCount += 1;
    if (t.isArticle) stats.articleCount += 1;
    stats.lastDate = t.date || '-';
    if (t.timestamp) {
      if (!stats.oldestTimestamp || t.timestamp < stats.oldestTimestamp) stats.oldestTimestamp = t.timestamp;
      if (!stats.newestTimestamp || t.timestamp > stats.newestTimestamp) stats.newestTimestamp = t.timestamp;
    }
  }

  function recomputeStats() {
    // Carry the counter that describes the run rather than the posts.
    const skippedKnown = stats ? stats.skippedKnown : 0;
    stats = freshStats();
    stats.skippedKnown = skippedKnown;
    for (const t of tweets) bump(t);
  }

  // Extraction ------------------------------------------------------------
  // The post id, off the timestamp link. Promoted posts and placeholders have
  // no <time>, so they come back null and are ignored. Cheap enough to run on
  // every mounted article before deciding whether a full extraction is needed.
  function tweetIdOf(article) {
    const timeElement = article.querySelector('time');
    if (!timeElement) return null;
    const linkElement = timeElement.closest('a');
    if (!linkElement) return null;
    const tweetId = (linkElement.href || '').split('/status/')[1]?.split(/[?/]/)[0];
    return tweetId && /^\d+$/.test(tweetId) ? tweetId : null;
  }

  function extractTweetData(article, tweetId) {
    const timeElement = article.querySelector('time');
    if (!timeElement) return null; // promoted posts and placeholders have no timestamp

    const linkElement = timeElement.closest('a');
    if (!linkElement) return null;

    const tweetLink = linkElement.href;
    if (!tweetId || !/^\d+$/.test(tweetId)) return null;

    // X long-form articles: a card linking to /{handle}/article/{same id}.
    let isArticle = false;
    let articleTitle = '';
    for (const anchor of article.querySelectorAll('a[href*="/article/"]')) {
      const m = (anchor.getAttribute('href') || '').match(/\/article\/(\d+)/);
      if (m && m[1] === tweetId) {
        isArticle = true;
        const titleText = textWithEmoji(anchor).replace(/\s+/g, ' ').trim();
        if (titleText) articleTitle = titleText.slice(0, 300);
        break;
      }
    }

    const { username, handle } = extractAuthor(article);

    const tweetTextElement = article.querySelector('[data-testid="tweetText"]');
    const tweetText = tweetTextElement ? textWithEmoji(tweetTextElement) : '';

    const timestamp = timeElement.getAttribute('datetime');
    const date = timestamp
      ? new Date(timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : '';

    const images = extractImages(article, tweetId);

    const hasVideo =
      article.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"], video') !== null;

    return {
      id: tweetId,
      username: username || 'Unknown',
      handle: handle || 'unknown',
      text: tweetText,
      link: tweetLink,
      timestamp,
      date,
      images: images.length > 0 ? images : null,
      hasVideo,
      isArticle,
      articleTitle,
      likeCount: readCount(article, 'like'),
      retweetCount: readCount(article, 'retweet'),
    };
  }

  // A real X handle is 1-15 of [A-Za-z0-9_]. Display names are free text and
  // can start with "@", so anything read from link text must pass this check.
  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
  function validHandle(raw) {
    const h = String(raw || '').trim().replace(/^@/, '');
    return HANDLE_RE.test(h) ? h : '';
  }
  function handleFromHref(href) {
    const m = href && href.match(/^\/([A-Za-z0-9_]{1,15})(?:[/?]|$)/);
    return m ? m[1] : '';
  }

  // Display name + @handle. Prefer the handle in the profile link's href (it
  // cannot be spoofed by a display name); fall back to validated link text.
  function extractAuthor(article) {
    let username = '';
    let handle = '';

    const userName = article.querySelector('[data-testid="User-Name"]');
    if (userName) {
      const links = userName.querySelectorAll('a[role="link"]');
      for (const link of links) {
        handle = handleFromHref(link.getAttribute('href'));
        if (handle) break;
      }
      for (const link of links) {
        const text = textWithEmoji(link).replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.startsWith('@')) {
          if (!handle) handle = validHandle(text);
        } else if (!username) {
          username = text;
        }
        if (username && handle) break;
      }
      if (!handle) {
        const profile = userName.querySelector('a[href^="/"]');
        handle = handleFromHref(profile ? profile.getAttribute('href') : '');
      }
    }

    if (!username || !handle) {
      for (const link of article.querySelectorAll('a[role="link"]')) {
        const href = link.getAttribute('href');
        if (!href || !href.startsWith('/') || href.includes('/status/')) continue;
        if (!handle) handle = handleFromHref(href);
        for (const span of link.querySelectorAll('span')) {
          const text = span.textContent.trim();
          if (text && text.startsWith('@')) {
            if (!handle) handle = validHandle(text);
          } else if (text && !username) {
            username = text;
          }
        }
        if (username && handle) break;
      }
    }
    return { username, handle };
  }

  // Photos attached to THIS tweet are wrapped in /status/{id}/photo/N links.
  // Photos inside a quoted tweet are not, so this excludes them. Fall back to
  // the broad selector if X changes the markup, still skipping anything inside
  // a quoted-tweet container (a div[role="link"]).
  function extractImages(article, tweetId) {
    const out = [];
    const seen = new Set();
    const push = (img) => {
      const src = img.getAttribute('src') || '';
      if (!src.includes('pbs.twimg.com/media') || src.includes('profile_images')) return;
      const url = src.split('?')[0] + '?format=jpg&name=medium';
      if (!seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    };
    for (const img of article.querySelectorAll(`a[href*="/status/${tweetId}/photo/"] img`)) push(img);
    if (out.length === 0) {
      for (const img of article.querySelectorAll('img[src*="pbs.twimg.com/media"]')) {
        if (!img.closest('div[role="link"]')) push(img);
      }
    }
    return out;
  }

  function readCount(article, testId) {
    const button = article.querySelector(`[data-testid="${testId}"], [data-testid="un${testId}"]`);
    const label = button && button.getAttribute('aria-label');
    if (!label) return 0;
    const m = label.match(/(\d+(?:,\d+)*(?:\.\d+)?[KMB]?)/i);
    return m ? parseEngagementCount(m[1]) : 0;
  }

  function parseEngagementCount(str) {
    if (!str) return 0;
    str = str.replace(/,/g, '');
    const multipliers = { K: 1e3, M: 1e6, B: 1e9 };
    const suffix = str.slice(-1).toUpperCase();
    if (multipliers[suffix]) return Math.round(parseFloat(str.slice(0, -1)) * multipliers[suffix]);
    return parseInt(str, 10) || 0;
  }

  // X renders emoji as <img alt="😀">. textContent drops them; this keeps them.
  function textWithEmoji(root) {
    let out = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue;
      } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG') {
        out += node.getAttribute('alt') || '';
      }
      node = walker.nextNode();
    }
    return out;
  }

  // Persistence -----------------------------------------------------------
  const KNOWN_KEY = (typeof window.X_KNOWN_KEY === 'string' && window.X_KNOWN_KEY) || 'xlcKnownIds';

  function setActivity(text) {
    if (stats) stats.activity = text;
  }

  function readStoredTweets() {
    return new Promise((resolve) => {
      chrome.storage.local.get(TWEETS_KEY, (result) => resolve(result[TWEETS_KEY] || null));
    });
  }

  // Ids of posts collected by earlier runs, keyed by source signature. The popup
  // writes it when you import old exports; the engine folds every run's ids back
  // in when the run ends, so a later re-scan emits only what was missing.
  function readKnownIndex() {
    return new Promise((resolve) => {
      chrome.storage.local.get(KNOWN_KEY, (result) => {
        if (chrome.runtime.lastError) return resolve({});
        const index = result && result[KNOWN_KEY];
        resolve(index && typeof index === 'object' ? index : {});
      });
    });
  }

  function writeKnownIndex(index) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [KNOWN_KEY]: index }, () => {
        if (chrome.runtime.lastError) console.error('[XC] already-collected index write failed', chrome.runtime.lastError);
        resolve();
      });
    });
  }

  function knownIdsFor(index, signature) {
    return typeof window.xKnownIdsFor === 'function' ? window.xKnownIdsFor(index, signature) : [];
  }

  function rememberCollected() {
    if (!sourceSig || tweets.length === 0) return;
    const collected = tweets.map((t) => t.id);
    void (async () => {
      try {
        const index = await readKnownIndex();
        const merge = typeof window.xMergeKnownIds === 'function' ? window.xMergeKnownIds : null;
        await writeKnownIndex(merge ? merge(index, sourceSig, collected) : index);
      } catch (err) {
        console.warn('[XC] could not update the already-collected index', err);
      }
    })();
  }

  // Chrome throttles timers in hidden tabs (down to once per minute after a
  // few minutes), and drops requestAnimationFrame entirely, which stalls both
  // the scroll loop and X's rendering. Track it so the popup can say why a run
  // was slow, and clear the observer's rAF latch when the tab comes back.
  let hiddenSince = document.hidden ? Date.now() : null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenSince = Date.now();
      return;
    }
    if (hiddenSince !== null) {
      if (stats) stats.hiddenMs += Date.now() - hiddenSince;
      hiddenSince = null;
    }
    scanScheduled = false;
    if (status === 'collecting') scanDom();
  });

  // Stats are cheap and go out every second. The tweets array can be many MB
  // for a large archive, so it lives under its own key, is written only when it
  // has actually grown, and never blocks the scroll loop: while a write is in
  // flight the throttled calls are dropped instead of queueing behind it. A
  // forced call (a state change) waits for the write already running.
  async function persist(force, error) {
    if (!stats) return;
    const now = Date.now();
    const writeStats = force || now - lastStatsPersist >= PERSIST_STATS_MS;
    const writeTweets = force || (now - lastTweetsPersist >= PERSIST_TWEETS_MS && tweets.length !== lastPersistedCount);
    if (!writeStats && !writeTweets) return;
    if (writing) {
      if (!force) return;
      await writeDone;
    }

    stats.updatedAt = now;
    if (hiddenSince !== null) {
      stats.hiddenMs += now - hiddenSince;
      hiddenSince = now;
    }
    const patch = {
      [STATE_KEY]: {
        version: VERSION,
        status,
        stats,
        source: source || null,
        error: error || null,
        dateRange: {
          from: dateRange.from ? dateRange.from.toISOString() : null,
          to: dateRange.to ? dateRange.to.toISOString() : null,
        },
      },
    };
    lastStatsPersist = now;
    if (writeTweets) {
      patch[TWEETS_KEY] = tweets;
      lastTweetsPersist = now;
      lastPersistedCount = tweets.length;
    }

    writing = true;
    writeDone = new Promise((resolve) => {
      chrome.storage.local.set(patch, () => {
        if (chrome.runtime.lastError) console.error('[XC] storage write failed', chrome.runtime.lastError);
        writing = false;
        resolve();
      });
    });
    await writeDone;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  console.log(`[XC] content script v${VERSION} loaded`);
})();
