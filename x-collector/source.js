// Shared X page classifier.
//
// Loaded by BOTH the popup (to decide whether Start is allowed and to name the
// download) and the content script (to record what was collected and to notice
// when the single-page app navigates away mid-run). Keep it dependency-free:
// it runs as a plain script tag in the popup and as an injected content script
// file in the tab.
//
// Division of responsibility: this file only DESCRIBES a URL. The popup decides
// policy (refuse to start on a page with no post timeline). The content script
// never refuses based on the URL, so the headless test harness can drive it on
// a file:// fixture.

(() => {
  if (typeof window.describeXSource === 'function') return;

  // First path segment values that are X features, never account handles.
  const RESERVED = new Set([
    'i', 'home', 'explore', 'search', 'notifications', 'messages', 'settings',
    'compose', 'intent', 'login', 'logout', 'signup', 'account', 'tos', 'privacy',
    'about', 'download', 'jobs', 'hashtag', 'topics', 'bookmarks', 'lists',
    'communities', 'premium', 'premium_sign_up', 'verified_choose', 'following',
    'followers', 'share', 'widgets', 'oauth', 'session',
  ]);

  // Profile sub-tabs that list PEOPLE, not posts.
  const PEOPLE_TABS = new Set([
    'followers', 'following', 'verified_followers', 'followers_you_follow',
    'creator-subscriptions', 'subscriptions',
  ]);

  const unsupported = (label, reason) => ({
    kind: 'unsupported', label, slug: 'unsupported', handle: null, query: null,
    id: null, timeline: false, reason,
  });

  function slugify(s, max = 40) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '');
  }

  /**
   * Classify an X URL.
   * @returns {{kind:string,label:string,slug:string,handle:?string,query:?string,
   *            id:?string,timeline:boolean,reason:?string,url:string}}
   *   `timeline` is true when the page renders a scrollable list of posts the
   *   collector can walk. `slug` names the download file. `label` is shown to
   *   the user. `reason` explains a false `timeline`.
   */
  window.describeXSource = function describeXSource(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      const bad = unsupported('Unknown page', 'This tab has no readable address.');
      bad.kind = 'not-x';
      bad.url = String(rawUrl || '');
      return bad;
    }

    const base = { handle: null, query: null, id: null, timeline: true, reason: null, url: url.href };

    if (!/(^|\.)(x|twitter)\.com$/i.test(url.hostname)) {
      return Object.assign(base, {
        kind: 'not-x', label: 'Not an X page', slug: 'unknown', timeline: false,
        reason: 'Open a page on x.com first.',
      });
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const [first, second, third, fourth] = segments;

    // Root and Home.
    if (segments.length === 0 || first === 'home') {
      return Object.assign(base, { kind: 'home', label: 'Home timeline', slug: 'home' });
    }

    // /i/... feature routes.
    if (first === 'i') {
      if (second === 'history' && third === 'likes') {
        return Object.assign(base, { kind: 'likes', label: 'Your Likes', slug: 'likes' });
      }
      if (second === 'bookmarks') {
        const folder = third || null;
        return Object.assign(base, {
          kind: 'bookmarks',
          label: folder ? `Bookmark folder ${folder}` : 'Your Bookmarks',
          slug: folder ? `bookmarks-${slugify(folder)}` : 'bookmarks',
          id: folder,
        });
      }
      if (second === 'lists' && third) {
        return Object.assign(base, { kind: 'list', label: `List ${third}`, slug: `list-${slugify(third)}`, id: third });
      }
      if (second === 'communities' && third) {
        return Object.assign(base, {
          kind: 'community', label: `Community ${third}`, slug: `community-${slugify(third)}`, id: third,
        });
      }
      if (second === 'topics' && third) {
        return Object.assign(base, { kind: 'topic', label: `Topic ${third}`, slug: `topic-${slugify(third)}`, id: third });
      }
      if (second === 'timeline') {
        return Object.assign(base, { kind: 'home', label: 'Home timeline', slug: 'home' });
      }
      return unsupported(`X page /i/${second || ''}`, 'This X page does not show a post timeline.');
    }

    // Search.
    if (first === 'search') {
      const q = (url.searchParams.get('q') || '').trim();
      return Object.assign(base, {
        kind: 'search',
        label: q ? `Search: ${q}` : 'Search',
        slug: q ? `search-${slugify(q)}` : 'search',
        query: q || null,
      });
    }

    if (first === 'hashtag' && second) {
      return Object.assign(base, {
        kind: 'search', label: `Hashtag #${second}`, slug: `hashtag-${slugify(second)}`, query: `#${second}`,
      });
    }

    if (first === 'explore') {
      return Object.assign(base, { kind: 'explore', label: 'Explore', slug: 'explore' });
    }

    if (first === 'notifications') {
      return Object.assign(base, {
        kind: 'notifications',
        label: second === 'mentions' ? 'Notifications: mentions' : 'Notifications',
        slug: second === 'mentions' ? 'mentions' : 'notifications',
      });
    }

    if (RESERVED.has(first)) {
      return unsupported(`X page /${first}`, 'This X page does not show a post timeline.');
    }

    // Everything else starts with an account handle.
    const handle = first;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      return unsupported('Unknown X page', 'This X page does not show a post timeline.');
    }

    // Single post and its conversation.
    if (second === 'status' || second === 'statuses') {
      const postId = (third || '').replace(/\D/g, '');
      if (!postId) return unsupported(`@${handle}`, 'This X page does not show a post timeline.');
      if (fourth === 'quotes') {
        return Object.assign(base, {
          kind: 'quotes', label: `Quotes of ${postId}`, slug: `quotes-${postId}`, handle, id: postId,
        });
      }
      if (fourth === 'retweets' || fourth === 'likes') {
        return unsupported(`Post ${postId} · ${fourth}`, `This tab lists accounts, not posts.`);
      }
      return Object.assign(base, {
        kind: 'thread', label: `Thread by @${handle}`, slug: `thread-${slugify(handle)}-${postId}`, handle, id: postId,
      });
    }

    if (second && PEOPLE_TABS.has(second)) {
      return unsupported(`@${handle} · ${second}`, 'This tab lists accounts, not posts.');
    }

    if (second === 'lists' || second === 'communities' || second === 'photo' || second === 'header_photo') {
      return unsupported(`@${handle} · ${second}`, 'This X page does not show a post timeline.');
    }

    // Profile tabs.
    const tab = second || '';
    if (tab === 'likes') {
      return Object.assign(base, {
        kind: 'likes', label: `Likes of @${handle}`, slug: `likes-${slugify(handle)}`, handle,
      });
    }
    if (tab === 'with_replies') {
      return Object.assign(base, {
        kind: 'profile-replies', label: `@${handle} · posts and replies`,
        slug: `${slugify(handle)}-replies`, handle,
      });
    }
    if (tab === 'media') {
      return Object.assign(base, {
        kind: 'profile-media', label: `@${handle} · media`, slug: `${slugify(handle)}-media`, handle,
      });
    }
    if (tab === 'highlights') {
      return Object.assign(base, {
        kind: 'profile-highlights', label: `@${handle} · highlights`, slug: `${slugify(handle)}-highlights`, handle,
      });
    }
    if (tab === 'articles') {
      return Object.assign(base, {
        kind: 'profile-articles', label: `@${handle} · articles`, slug: `${slugify(handle)}-articles`, handle,
      });
    }
    if (tab === '' || tab === 'superfollows' || tab === 'affiliates') {
      return Object.assign(base, {
        kind: 'profile', label: `@${handle} · profile`, slug: slugify(handle), handle,
      });
    }

    return unsupported(`@${handle} · ${tab}`, 'This X page does not show a post timeline.');
  };

  /** Stable identity of a source, so a mid-run navigation can be detected. */
  window.xSourceSignature = function xSourceSignature(src) {
    if (!src) return '';
    return [src.kind, src.handle || '', src.query || '', src.id || ''].join('|');
  };

  /**
   * Default Downloads subfolder for a source kind. Every kind shares the one
   * `trove` folder, so the Python pipeline reads all exports from a single
   * place (link Downloads/trove to the repo's exports/ folder). The `kind`
   * argument stays so a user can still set a different folder per kind.
   */
  window.defaultFolderFor = function defaultFolderFor(kind) {
    return 'trove';
  };
})();
