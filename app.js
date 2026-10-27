'use strict';
(() => {
  const BUILD = '2026-10-26-V1.2';
  const VERSION = 'V1.2';
  const S = window.AIInboxSorter, T = window.AIInboxTools, G = window.AIInboxGmail, E = window.AIInboxEdits;
  const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const SCOPE = `${GMAIL_SCOPE} ${DRIVE_SCOPE}`;
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const clientId = String((window.AI_INBOX_CONFIG || {}).clientId || '').trim();
  const hasClientId = /^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId) && !/PASTE|YOUR-CLIENT-ID/i.test(clientId);

  // Stored settings: declared once, before they are loaded. Only the sign-off and the reading setting are kept here; never mail.
  const SETTINGS_KEY = 'ai-inbox-settings-v1';
  const settings = { signoff: 'Mintay', withPromotions: false };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (saved && typeof saved.signoff === 'string') settings.signoff = saved.signoff;
    if (saved && typeof saved.withPromotions === 'boolean') settings.withPromotions = saved.withPromotions;
  } catch (e) { /* storage blocked: defaults stay */ }
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* storage blocked: kept for this visit */ } }
  function deviceStorage() { try { return window.localStorage || null; } catch (e) { return null; } }

  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const PAGE = 100; // rows per list before "Show more": building 200+ rows on every tap cost about 100 ms
  const state = { shown: PAGE, mode: 'demo', backend: null, store: null, view: 'overview', topic: 'all', search: '', me: '', threads: [], items: [], byId: new Map(), labels: {}, userLabels: [], categories: [], archived: new Map(), editsNote: '', driveRefused: false, updatedAt: 0, loading: false, error: '', authNeeded: false, gisReady: false, gisFailed: false, loadSeq: 0 };
  let token = null; // {value, expiresAt}: memory only
  let tokenClient = null;
  let afterToken = [];
  const drafts = new Map(); // threadId → {target, template, text, filled, previous, savedId}: survives re-renders and refreshes
  let draftId = '';
  const editForms = new Map(); // threadId → {title, due, list, note} as typed: survives re-renders, refreshes and a lapsed sign-in
  let editId = '';
  const catForm = { threadId: '', newName: '', renameId: '', renameText: '' }; // the category dialog's typed text
  let catUndo = null; // the dialog's own Undo: the toast's Undo sits behind the open dialog

  const views = [
    { id: 'overview', label: 'Overview', icon: '◫', title: 'Your inbox, in focus.', description: 'Pinned, suggested to-dos and topics to catch up on, from your inbox.' },
    { id: 'needsReply', label: 'Needs reply', icon: '↩', title: 'A reply from you.', description: 'People who wrote to you directly with a question.' },
    { id: 'waitingOn', label: 'Waiting on', icon: '◷', title: 'The ball’s in their court.', description: 'You wrote last, 3 or more days ago, and nobody has answered yet.' },
    { id: 'starred', label: 'Starred', icon: '★', title: 'Your favorites.', description: 'Threads you starred, whatever their age. A star here is the same star in Gmail.' },
    { id: 'important', label: 'Important', icon: '»', title: 'Marked important.', description: 'Open threads with Gmail’s Important marker.' },
    { id: 'done', label: 'Done', icon: '✓', title: 'Done.', description: 'Threads you marked done. A new message in the thread brings it back.' },
    { id: 'all', label: 'All', icon: '▤', title: 'Everything in view.', description: 'Your inbox from the last 30 days, plus what you pinned, starred or kept as a to-do.' }
  ];
  const TOPIC_SYMBOL = { 'Purchases': '◇', 'Deliveries': '▣', 'Travel': '✈', 'Finances and bills': '$', 'Appointments': '◷', 'Events': '✦', 'Work and school': '▧', 'Other': '•' };
  const LIST_TAG = { todo: 'To-do', needsReply: 'Needs reply', waitingOn: 'Waiting on', topic: 'Topic', fyi: 'For reference' };
  const EDIT_LIST_NAME = { todo: 'To-do', needsReply: 'Needs reply', waitingOn: 'Waiting on', fyi: 'FYI' };

  const ctx = () => ({ me: state.me, now: Date.now(), labels: state.labels, edits: state.store ? state.store.doc.threads : {}, categories: state.categories });
  function recompute() {
    const hidden = new Set(state.store ? state.store.hidden() : []);
    state.categories = G.categoryLabels(state.userLabels).filter(c => !hidden.has(c.id));
    if (state.topic.startsWith('cat:') && !state.categories.some(c => `cat:${c.id}` === state.topic)) state.topic = 'all';
    state.items = S.sortThreads(state.threads, ctx());
    state.byId = new Map(state.items.map(i => [i.id, i]));
  }
  const threadById = id => state.threads.find(t => t.id === id);
  const isOpen = i => !i.done && (i.inInbox || i.list === 'waitingOn' || i.todoLabel || i.pinned);
  const inView = (i, view) => view === 'done' ? i.done : view === 'starred' ? i.starred : !isOpen(i) ? false : view === 'needsReply' ? i.needsReply : view === 'waitingOn' ? i.list === 'waitingOn' : view === 'todo' ? i.list === 'todo' : view === 'important' ? i.important : true;
  const searchMatch = i => !state.search || `${i.from} ${i.fromAddress} ${i.subject} ${i.snippet} ${i.action} ${i.note}`.toLowerCase().includes(state.search.toLowerCase());
  const topicMatch = i => state.topic === 'all' || (state.topic.startsWith('cat:') ? !!i.category && `cat:${i.category.id}` === state.topic : !i.category && i.topic === state.topic);
  const topicName = key => key.startsWith('cat:') ? ((state.categories.find(c => `cat:${c.id}` === key) || {}).name || 'Category') : key;
  const live = () => state.mode === 'gmail';
  const linkFor = id => live() ? T.threadLink(state.me, id) : '';

  // Formatters made once: building one per row made a render of 200+ rows slow.
  const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const SHORT_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const DUE_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const FULL_FMT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const timeOf = ms => TIME_FMT.format(new Date(ms));
  const shortDate = ms => SHORT_FMT.format(new Date(ms));
  function age(ms) {
    const diff = Date.now() - ms;
    if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))}m`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h`;
    if (diff < 7 * 86400000) return `${Math.round(diff / 86400000)}d`;
    return shortDate(ms);
  }
  function dueChip(due) {
    const [y, m, d] = due.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const today = S.localDay(Date.now());
    const now = new Date();
    const tomorrow = S.localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const label = due < today ? `Overdue · ${shortDate(date)}` : due === today ? 'Due today' : due === tomorrow ? 'Due tomorrow' : `Due ${DUE_FMT.format(date)}`;
    return `<span class="due ${due < today ? 'overdue' : ''}">${esc(label)}</span>`;
  }

  // ----- rendering -----
  function actionButtons(i) {
    const link = linkFor(i.id);
    const id = esc(i.id);
    const reply = link ? `<a class="chip-btn" data-act="reply" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Reply ↗</a>` : `<button class="chip-btn" type="button" disabled title="Demo: no Gmail thread">Reply ↗</button>`;
    const more = [];
    if (!i.done && !i.todoLabel && i.list !== 'todo') more.push(`<button type="button" data-act="add-todo" data-id="${id}">Add to to-dos</button>`);
    if (!i.done && (i.list === 'todo' || i.needsReply)) more.push(`<button type="button" data-act="remove" data-id="${id}">Remove</button>`);
    more.push(i.important ? `<button type="button" data-act="unimportant" data-id="${id}">Mark not important</button>` : `<button type="button" data-act="important" data-id="${id}">Mark important</button>`);
    more.push(`<button type="button" data-act="category" data-id="${id}">Move to category…</button>`);
    more.push(`<button type="button" data-act="edit" data-id="${id}">Edit…</button>`);
    more.push(i.inInbox ? `<button type="button" data-act="archive" data-id="${id}">Archive</button>` : `<button type="button" data-act="inbox" data-id="${id}">Move to inbox</button>`);
    return `<div class="row-actions">
      <button class="chip-btn" type="button" data-act="view" data-id="${id}">View</button>${reply}
      <button class="chip-btn" type="button" data-act="draft" data-id="${id}">Draft reply</button>
      ${i.done ? `<button class="chip-btn" type="button" data-act="reopen" data-id="${id}">Not done</button>` : `<button class="chip-btn strong" type="button" data-act="done" data-id="${id}">Mark done</button>`}
      <button class="chip-btn ${i.pinned ? 'active' : ''}" type="button" data-act="${i.pinned ? 'unpin' : 'pin'}" data-id="${id}" aria-pressed="${i.pinned}">${i.pinned ? 'Unpin' : 'Pin'}</button>
      <button class="chip-btn star-btn ${i.starred ? 'active' : ''}" type="button" data-act="${i.starred ? 'unstar' : 'star'}" data-id="${id}" aria-label="${i.starred ? 'Unstar' : 'Star'}" aria-pressed="${i.starred}">${i.starred ? '★' : '☆'}</button>
      <details class="more"><summary class="chip-btn">More</summary><div class="more-menu">${more.join('')}</div></details>
    </div>`;
  }
  function rowHtml(i, kind) {
    const actionFirst = kind === 'todo' || ['todo', 'needsReply', 'waitingOn'].includes(i.list) || i.titleEdited;
    const title = actionFirst ? i.action : i.subject;
    const sub = actionFirst ? `${i.subject} · ${i.snippet}` : i.snippet;
    const tags = [
      i.due ? dueChip(i.due) : '',
      kind === 'todo' ? '' : `<span class="tag ${i.list}">${esc(LIST_TAG[i.list])}</span>`,
      `<span class="tag ${i.category ? 'category' : ''}">${esc(i.topic)}</span>`,
      i.done ? '<span class="tag done">Done</span>' : '',
      i.removed && !i.done ? '<span class="tag">Removed from to-dos</span>' : '',
      i.edited ? '<span class="tag edited">Edited</span>' : '',
      !i.inInbox ? '<span class="tag">Archived</span>' : ''
    ].join('');
    const marks = `${i.pinned ? '<span class="mark pin">Pinned</span>' : ''}${i.important ? '<span class="mark important" title="Important" aria-label="Important">»</span>' : ''}${i.starred ? '<span class="mark star" title="Starred" aria-label="Starred">★</span>' : ''}`;
    return `<article class="row ${i.unread ? 'unread' : ''}" data-row="${esc(i.id)}">
      <span class="sender-avatar" aria-hidden="true">${esc(i.initials)}</span>
      <div class="row-main">
        <div class="row-top"><span class="sender-name">${esc(i.from)}${i.count > 1 ? ` <span class="msg-count">${i.count}</span>` : ''}</span>${marks}<span class="row-age" title="${esc(FULL_FMT.format(new Date(i.date)))}">${esc(age(i.date))}</span></div>
        <button class="row-title" type="button" data-act="view" data-id="${esc(i.id)}">${i.unread ? '<span class="unread-dot" aria-label="Unread"></span>' : ''}${esc(title)}</button>
        <p class="row-sub">${esc(sub)}</p>
        ${i.note ? `<p class="row-note">${esc(i.note)}</p>` : ''}
        <div class="row-tags">${tags}</div>
        ${actionButtons(i)}
      </div>
    </article>`;
  }
  function renderNavigation() {
    $('#navigation').innerHTML = views.map(v => {
      const count = v.id === 'overview' ? state.items.filter(i => inView(i, 'todo')).length : state.items.filter(i => inView(i, v.id)).length;
      return `<button class="nav-button ${state.view === v.id ? 'active' : ''}" type="button" data-view="${v.id}" ${state.view === v.id ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${v.icon}</span><span>${v.label}</span><span class="nav-count">${count}</span></button>`;
    }).join('');
    const navButton = (key, symbol, name, n) => `<button class="nav-button ${state.topic === key ? 'active' : ''}" type="button" data-topic="${esc(key)}" aria-pressed="${state.topic === key}"><span class="topic-dot" aria-hidden="true">${esc(symbol)}</span><span>${esc(name)}</span><span class="nav-count">${n}</span></button>`;
    $('#topic-navigation').innerHTML = S.TOPICS.map(t => [t, state.items.filter(i => isOpen(i) && !i.category && i.topic === t).length]).filter(([, n]) => n).map(([t, n]) => navButton(t, TOPIC_SYMBOL[t], t, n)).join('');
    $('#category-navigation').innerHTML = state.categories.map(c => navButton(`cat:${c.id}`, '#', c.name, state.items.filter(i => isOpen(i) && i.category && i.category.id === c.id).length)).join('') || '<p class="nav-empty">None yet</p>';
  }
  function renderAccount() {
    $('#account').innerHTML = live()
      ? `<span class="avatar" aria-hidden="true">${esc(state.me.slice(0, 1).toUpperCase())}</span><div><strong>${esc(state.me)}</strong><small>Gmail · Inbox</small></div>`
      : `<span class="avatar" aria-hidden="true">D</span><div><strong>Demo mailbox</strong><small>Invented messages</small></div>`;
    const signin = $('#signin');
    signin.hidden = live();
    signin.disabled = !hasClientId || !state.gisReady;
    signin.textContent = !hasClientId ? 'Sign-in not set up' : state.gisFailed ? 'Google unavailable' : state.gisReady ? 'Sign in with Google' : 'Loading Google…';
    $('#signout').hidden = !live();
    $('#open-gmail').href = T.inboxLink(live() ? state.me : '');
    $('#refresh').disabled = state.loading;
    $('#updated').textContent = state.loading ? 'Loading…' : live() ? (state.updatedAt ? `Updated ${timeOf(state.updatedAt)}` : '') : 'Demo data';
  }
  function renderNotice() {
    const n = $('#notice');
    let html = '';
    if (live() && state.authNeeded) html = '<strong>Your Google sign-in lapsed.</strong> <span>One tap continues where you left off; nothing you typed is lost.</span> <button class="primary small" type="button" data-act="reauth">Continue</button>';
    else if (live() && state.error) html = `<strong>Could not reach Gmail.</strong> <span>${esc(state.error)}</span> <button class="secondary small" type="button" data-act="refresh">Try again</button>`;
    else if (live() && state.loading && !state.updatedAt) html = `<strong>Loading your inbox…</strong>${state.threads.length ? ` <span>${state.threads.length} threads so far.</span>` : ''}`;
    else if (!live()) html = `<strong>Demo</strong> <span>Invented messages, sorted by the same rules. Gmail links and changes are off; each action says what it would do.${!hasClientId ? ' To connect Gmail, paste your Google Client ID into config.js.' : state.gisFailed ? ' Google sign-in could not load; check the connection and reload.' : ' Sign in with Google to see your own mail.'}</span>`;
    n.innerHTML = html;
    n.hidden = !html;
    n.className = `notice ${live() ? (state.authNeeded || state.error ? 'warn' : '') : 'demo'}`;
  }
  function renderOverview() {
    const shown = state.view === 'overview' && !state.search && state.topic === 'all';
    $('#overview').hidden = !shown;
    $('#message-section').hidden = shown;
    if (!shown) { $('#overview').innerHTML = ''; return; }
    const pinned = state.items.filter(i => i.pinned).sort((a, b) => b.date - a.date);
    const todos = state.items.filter(i => inView(i, 'todo') && !i.pinned);
    const groups = S.groupTopics(state.items.filter(isOpen), state.categories);
    $('#overview').innerHTML = `${pinned.length ? `<div class="section-heading"><div><h2>Pinned</h2><span>${pinned.length}</span></div></div><div class="pinned-list">${pinned.map(i => rowHtml(i, 'list')).join('')}</div>` : ''}
      <div class="section-heading"><div><h2>Suggested to-dos</h2><span>${todos.length} open</span></div><button class="text-button" type="button" data-act="gena" ${state.items.some(i => inView(i, 'todo')) ? '' : 'disabled'}>Copy for Gena</button></div>
      <div class="todo-list">${todos.length ? todos.map(i => rowHtml(i, 'todo')).join('') : '<div class="empty-state"><h3>No suggested to-dos</h3><p>Nothing in your inbox asks for an action right now.</p></div>'}</div>
      <div class="section-heading"><div><h2>Topics to catch up on</h2><span>${groups.length ? `${groups.reduce((n, g) => n + g.count, 0)} threads` : ''}</span></div></div>
      <div class="topic-grid">${groups.length ? groups.map(topicCard).join('') : '<div class="empty-state"><p>No topic mail in view.</p></div>'}</div>`;
  }
  function topicCard(g) {
    const threads = g.items.slice(0, 4).map(i => {
      const link = linkFor(i.id);
      const text = `${esc(i.subject)} <span class="topic-from">${esc(i.from)}</span>`;
      return `<li class="${i.unread ? 'unread' : ''}">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${text}</a>` : `<button type="button" data-act="view" data-id="${esc(i.id)}">${text}</button>`}</li>`;
    }).join('');
    const symbol = g.key.startsWith('cat:') ? '#' : TOPIC_SYMBOL[g.topic];
    return `<article class="topic-card" data-topic-card="${esc(g.key)}">
      <div class="topic-head"><span class="topic-symbol" aria-hidden="true">${esc(symbol)}</span><h3>${esc(g.topic)}</h3><span class="topic-count">${g.count}</span></div>
      <p class="topic-latest"><strong>${esc(g.latest.from)}</strong> · ${esc(g.latest.snippet || g.latest.subject)}</p>
      <ul class="topic-threads">${threads}</ul>
      <div class="topic-actions"><button class="text-button" type="button" data-act="topic-read" data-topic-name="${esc(g.key)}" ${g.unread ? '' : 'disabled'}>Mark all as read${g.unread ? ` (${g.unread})` : ''}</button>${g.count > 4 ? `<button class="text-button" type="button" data-act="topic-all" data-topic-name="${esc(g.key)}">See all ${g.count}</button>` : ''}</div>
    </article>`;
  }
  function renderMessages() {
    if ($('#message-section').hidden) { $('#messages').innerHTML = ''; return; }
    const view = state.view === 'overview' ? 'all' : state.view;
    let list = state.items.filter(i => inView(i, view) && topicMatch(i) && searchMatch(i));
    if (['all', 'done', 'starred'].includes(view)) list = list.slice().sort((a, b) => b.date - a.date);
    $('#list-title').textContent = state.topic !== 'all' ? topicName(state.topic) : state.search && state.view === 'overview' ? 'Search results' : views.find(v => v.id === view).label;
    $('#result-count').textContent = `${list.length} ${list.length === 1 ? 'thread' : 'threads'}`;
    $('#active-filters').innerHTML = `${state.topic !== 'all' ? `<button class="filter-chip" type="button" data-clear="topic">${esc(topicName(state.topic))} ×</button>` : ''}${state.search ? `<button class="filter-chip" type="button" data-clear="search">Search: ${esc(state.search)} ×</button>` : ''}`;
    const more = list.length - state.shown;
    $('#messages').innerHTML = list.length ? `<div class="messages-list">${list.slice(0, state.shown).map(i => rowHtml(i, 'list')).join('')}</div>${more > 0 ? `<button class="secondary show-more" type="button" data-act="show-more">Show ${Math.min(more, PAGE)} more of ${more}</button>` : ''}` : `<div class="empty-state"><h3>Nothing here</h3><p>${state.search || state.topic !== 'all' ? 'Try a different name or word, or clear the filters.' : 'This list is empty right now.'}</p>${state.search || state.topic !== 'all' ? '<button class="secondary" type="button" data-clear="all">Clear filters</button>' : ''}</div>`;
  }
  let listKey = '';
  function render() {
    const key = `${state.view}|${state.topic}|${state.search}`;
    if (key !== listKey) { listKey = key; state.shown = PAGE; }
    const focused = document.activeElement;
    const keep = focused && focused.dataset ? (focused.dataset.view ? `[data-view="${focused.dataset.view}"]` : focused.dataset.act && focused.dataset.id ? `[data-act="${focused.dataset.act}"][data-id="${CSS.escape(focused.dataset.id)}"]` : '') : '';
    const view = views.find(v => v.id === state.view);
    $('#page-title').textContent = view.title;
    $('#page-description').textContent = view.description;
    $('#view-eyebrow').textContent = live() ? state.me : 'Demo mailbox';
    renderAccount(); renderNotice(); renderNavigation(); renderOverview(); renderMessages();
    if (keep && !focused.isConnected) { const again = document.querySelector(keep); if (again) again.focus({ preventScroll: true }); }
  }

  // ----- toast with Undo -----
  let toastTimer = 0, undoFn = null;
  function toast(text, undo) {
    $('#toast-text').textContent = text;
    undoFn = undo || null;
    $('#toast-undo').hidden = !undo;
    $('#toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('#toast').classList.remove('visible'); undoFn = null; }, undo ? 8000 : 4000);
  }

  // ----- Google sign-in (token model; token in memory only) -----
  function getToken() {
    if (!token || Date.now() >= token.expiresAt) throw new G.AuthError();
    return token.value;
  }
  function loadGis() {
    if (!hasClientId) return;
    const script = document.createElement('script');
    script.src = GIS_SRC; script.async = true;
    script.onload = () => {
      try {
        tokenClient = google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPE, callback: onToken, error_callback: onTokenError });
        state.gisReady = true;
      } catch (e) { state.gisFailed = true; }
      render();
    };
    script.onerror = () => { state.gisFailed = true; render(); };
    document.head.appendChild(script);
  }
  // Must run inside the tap's handler: Google opens its window only from a user gesture.
  function requestToken() {
    if (!tokenClient) return;
    const options = token || state.me ? { prompt: '' } : {};
    if (state.me) options.login_hint = state.me;
    if (state.driveRefused) options.scope = GMAIL_SCOPE; // he said no to Drive: do not ask again on every renewal
    tokenClient.requestAccessToken(options);
  }
  function onToken(resp) {
    if (!resp || resp.error) { toast(`Google sign-in did not finish${resp && resp.error ? `: ${resp.error}` : ''}.`); return; }
    const granted = scope => !google.accounts.oauth2.hasGrantedAllScopes || google.accounts.oauth2.hasGrantedAllScopes(resp, scope);
    if (!granted(GMAIL_SCOPE)) { toast('AI Inbox needs the Gmail permission to read and label your mail. Please sign in again and allow it.'); return; }
    token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 60000 };
    state.authNeeded = false;
    if (!live()) {
      state.mode = 'gmail';
      const fetchFn = (url, init) => fetch(url, init);
      const onAuthLost = () => { token = null; };
      state.backend = G.createGmailClient({ getToken, fetchFn, onAuthLost });
      state.driveRefused = !granted(DRIVE_SCOPE);
      const storage = deviceStorage();
      state.store = E.createEditsStore({
        drive: state.driveRefused ? null : E.createDriveFile({ getToken, fetchFn, onAuthLost, AuthError: G.AuthError }),
        local: storage ? E.createLocalFile(storage) : null,
        onNotice: text => { state.editsNote = text; toast(text); }
      });
      if (state.driveRefused) state.store.useDevice('Google Drive was not allowed, so your edits are kept on this device only.');
      state.threads = []; state.items = []; state.byId = new Map(); state.me = ''; state.updatedAt = 0; state.userLabels = []; state.archived.clear();
      load();
    }
    const queued = afterToken; afterToken = [];
    queued.forEach(fn => fn());
    render();
    updateDraftAuth();
  }
  function onTokenError(err) {
    toast(err && err.type === 'popup_failed_to_open' ? 'The Google window was blocked. Allow pop-ups for this page and tap again.' : 'Google sign-in was closed before it finished.');
  }
  function needAuth() {
    token = null;
    state.authNeeded = true;
    render();
    updateDraftAuth();
  }
  // Runs a Gmail or Drive call; when the token has lapsed it waits, queued, until one tap brings a new token, then runs again.
  function run(fn) {
    return new Promise((resolve, reject) => {
      const attempt = () => fn().then(resolve, err => {
        if (err && err.name === 'AuthError') { afterToken.push(attempt); needAuth(); } else reject(err);
      });
      attempt();
    });
  }
  function signOut() {
    const old = token;
    token = null;
    if (old && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(old.value, () => {});
    afterToken = [];
    drafts.clear(); editForms.clear();
    state.authNeeded = false; state.error = ''; state.editsNote = ''; state.driveRefused = false;
    for (const id of ['detail-dialog', 'draft-dialog', 'edit-dialog', 'category-dialog']) if ($(`#${id}`).open) $(`#${id}`).close();
    useDemo();
    toast('Signed out. Your mail has been cleared from this page.');
  }

  // ----- loading -----
  async function load() {
    if (state.loading) return;
    const seq = ++state.loadSeq;
    const backend = state.backend, store = state.store;
    const first = !state.updatedAt;
    const current = () => seq === state.loadSeq && backend === state.backend;
    state.loading = true; render();
    // Edits load beside the mail and before the first render, so nothing flickers from the rules' version to his.
    const editsReady = run(() => store.load()).catch(e => { toast(`Could not read your edits: ${e.message}`); });
    const take = res => { state.me = res.me; state.threads = res.threads; state.labels = res.labels; state.userLabels = (res.userLabels || []).map(l => ({ id: l.id, name: l.name, type: l.type })); };
    try {
      const onBatch = first ? async part => { await editsReady; if (!current()) return; take(part); recompute(); render(); } : null;
      const res = await run(() => backend.load({ needsBody: S.needsBody, ctxFor: (me, labels) => ({ me, now: Date.now(), labels }), withPromotions: settings.withPromotions, onBatch }));
      await editsReady;
      if (!current()) return;
      take(res); state.updatedAt = Date.now(); state.error = '';
    } catch (e) {
      if (seq === state.loadSeq) state.error = e.message || String(e);
    } finally {
      if (seq === state.loadSeq) { state.loading = false; recompute(); render(); }
    }
  }
  function useDemo() {
    state.mode = 'demo';
    state.backend = G.createDemoBackend(() => window.INBOX_DEMO.build(Date.now()));
    state.store = E.createEditsStore({});
    state.loadSeq++; state.loading = false;
    state.threads = []; state.items = []; state.me = ''; state.userLabels = []; state.labels = {}; state.archived.clear();
    if (state.topic.startsWith('cat:')) state.topic = 'all';
    load();
  }

  // ----- label changes: exact per-message ids, applied at once, each with an Undo -----
  const realMessages = t => t.messages.filter(m => !m.labelIds.includes('DRAFT')).sort((a, b) => a.date - b.date);
  // pick: 'latest' (the newest message, as Gmail stars), an array of message ids, or every message.
  function messageIdsFor(threadIds, label, op, pick) {
    const ids = [];
    for (const id of threadIds) {
      const t = threadById(id);
      if (!t) continue;
      let pool = realMessages(t);
      if (pick === 'latest') pool = pool.slice(-1);
      else if (Array.isArray(pick)) pool = pool.filter(m => pick.includes(m.id));
      for (const m of pool) {
        const has = m.labelIds.includes(label);
        if (op === 'add' ? !has : has) ids.push(m.id);
      }
    }
    return ids;
  }
  function applyLocal(steps) {
    for (const s of steps) {
      const set = new Set(s.ids);
      for (const t of state.threads) for (const m of t.messages) {
        if (!set.has(m.id)) continue;
        if (s.op === 'add' && !m.labelIds.includes(s.label)) m.labelIds.push(s.label);
        if (s.op === 'remove') m.labelIds = m.labelIds.filter(l => l !== s.label);
      }
    }
    recompute(); render();
  }
  const flip = s => ({ label: s.label, op: s.op === 'add' ? 'remove' : 'add', ids: s.ids });
  // Sends each step as one messages.batchModify, in order. A failure reports the steps Gmail already took.
  async function sendSteps(steps) {
    const notes = [], sent = [];
    for (const s of steps) {
      try { notes.push(await run(() => state.backend.modify(s.ids, s.op === 'add' ? [s.label] : [], s.op === 'remove' ? [s.label] : []))); }
      catch (e) { e.sent = sent; throw e; }
      sent.push(s);
    }
    return notes.filter(Boolean).join(' ');
  }
  // ops: [{key (an AI Inbox label, made on first use) or label (a Gmail label id), op: 'add'|'remove', pick}].
  // side: optional {apply, undo} for his edits that go with the label change (Move to category).
  async function change({ threadIds, ops, text, undoText, side }) {
    const steps = [];
    for (const o of ops) {
      let label = o.label;
      if (!label) {
        label = state.labels[o.key];
        if (!label) {
          try { label = await run(() => state.backend.ensureLabel(o.key)); } catch (e) { toast(`Could not create the label: ${e.message}`); return; }
          state.labels = Object.assign({}, state.labels, { [o.key]: label });
        }
      }
      const ids = messageIdsFor(threadIds, label, o.op, o.pick);
      if (ids.length) steps.push({ label, op: o.op, ids });
    }
    if (!steps.length && !side) { toast('Already up to date in Gmail.'); return; }
    const undo = async () => {
      const back = steps.map(flip).reverse();
      if (side) side.undo();
      applyLocal(back);
      toast(undoText);
      try { const note = await sendSteps(back); if (note) toast(`${undoText} ${note}`); }
      catch (e) { applyLocal(back.filter(s => !e.sent.includes(s)).map(flip)); toast(`Undo failed: ${e.message}`); }
    };
    if (side) side.apply();
    applyLocal(steps);
    toast(text, undo);
    try { const note = await sendSteps(steps); if (note && undoFn === undo) toast(`${text} ${note}`, undo); }
    catch (e) {
      if (side && !e.sent.length) side.undo();
      applyLocal(steps.filter(s => !e.sent.includes(s)).map(flip));
      toast(`Gmail did not accept the change: ${e.message}`);
    }
  }
  // Move to inbox puts INBOX back on exactly the messages Archive took it from in this visit; otherwise on the messages he received.
  function inboxIds(id) {
    if (state.archived.has(id)) return state.archived.get(id);
    const msgs = realMessages(threadById(id) || { messages: [] });
    const received = msgs.filter(m => !m.labelIds.includes('SENT'));
    return (received.length ? received : msgs.slice(-1)).map(m => m.id);
  }
  function act(kind, id) {
    const item = state.byId.get(id);
    if (!item) return;
    const name = `“${S.shortSubject(item.subject, 40)}”`;
    const one = (ops, text, undoText) => change({ threadIds: [id], ops, text, undoText });
    if (kind === 'done') one([{ key: 'done', op: 'add' }], `Marked ${name} done.`, `${name} is open again.`);
    if (kind === 'reopen') one([{ key: 'done', op: 'remove' }], `${name} is open again.`, `Marked ${name} done.`);
    if (kind === 'remove' && item.todoLabel) one([{ key: 'todo', op: 'remove' }], `Removed ${name} from your to-dos.`, `${name} is back in your to-dos.`);
    else if (kind === 'remove') one([{ key: 'removed', op: 'add' }], `Removed ${name} from your to-dos.`, `${name} is back in your to-dos.`);
    if (kind === 'add-todo') one([{ key: 'todo', op: 'add' }], `Added ${name} to your to-dos.`, `Took ${name} out of your to-dos.`);
    if (kind === 'pin') one([{ key: 'pinned', op: 'add' }], `Pinned ${name}.`, `Unpinned ${name}.`);
    if (kind === 'unpin') one([{ key: 'pinned', op: 'remove' }], `Unpinned ${name}.`, `Pinned ${name}.`);
    if (kind === 'star') one([{ label: 'STARRED', op: 'add', pick: 'latest' }], `Starred ${name}.`, `Took the star off ${name}.`);
    if (kind === 'unstar') one([{ label: 'STARRED', op: 'remove' }], `Took the star off ${name}.`, `Starred ${name}.`);
    if (kind === 'important') one([{ label: 'IMPORTANT', op: 'add' }], `Marked ${name} important.`, `Marked ${name} not important.`);
    if (kind === 'unimportant') one([{ label: 'IMPORTANT', op: 'remove' }], `Marked ${name} not important.`, `Marked ${name} important.`);
    if (kind === 'archive') {
      const ids = messageIdsFor([id], 'INBOX', 'remove');
      if (ids.length) state.archived.set(id, ids);
      one([{ label: 'INBOX', op: 'remove', pick: ids }], `Archived ${name}.`, `${name} is back in the inbox.`);
    }
    if (kind === 'inbox') one([{ label: 'INBOX', op: 'add', pick: inboxIds(id) }], `Moved ${name} to the inbox.`, `Archived ${name} again.`);
  }
  function markTopicRead(key) {
    const group = S.groupTopics(state.items.filter(isOpen), state.categories).find(g => g.key === key);
    if (!group) return;
    const ids = group.items.filter(i => i.unread).map(i => i.id);
    change({ threadIds: ids, ops: [{ label: 'UNREAD', op: 'remove' }], text: `Marked ${ids.length} ${group.topic} thread${ids.length === 1 ? '' : 's'} as read.`, undoText: `${group.topic} threads are unread again.` });
  }

  // ----- his edits: saved to his Drive app data (or this device), each with an Undo -----
  const recordOf = id => { const r = state.store.get(id); if (!r) return {}; const copy = Object.assign({}, r); delete copy.at; return copy; };
  async function persistEdits(text) {
    try {
      const mode = await run(() => state.store.persist());
      recompute(); render();
      if (mode === 'memory' && !live() && text && $('#toast-text').textContent === text) toast(`${text} Demo: in Google Drive this would save your change.`, undoFn);
    } catch (e) { toast(`Could not save your edit: ${e.message}`); }
  }
  function putEdits(id, record, text, undoText) {
    const before = recordOf(id);
    state.store.put(id, record);
    recompute(); render();
    const undo = () => { state.store.put(id, before); recompute(); render(); toast(undoText); persistEdits(undoText); };
    toast(text, undo);
    persistEdits(text);
  }
  function openEdit(id) {
    const i = state.byId.get(id);
    if (!i) return;
    editId = id;
    const form = editForms.get(id) || { title: i.action, due: i.due || '', list: i.list === 'topic' ? 'fyi' : i.list, note: i.note };
    editForms.set(id, form);
    $('#edit-subject').textContent = `${i.from} · ${i.subject}`;
    $('#edit-item-title').value = form.title;
    $('#edit-due').value = form.due;
    $('#edit-list').value = form.list;
    $('#edit-note').value = form.note;
    $('#edit-reset').disabled = !i.edited;
    $('#edit-status').textContent = i.edited ? 'Your edits beat the rules until you reset them.' : 'Starts from what the rules chose.';
    $('#edit-where').textContent = !live() ? 'Demo: nothing is saved.' : state.store.mode === 'drive' ? 'Saved in your Google Drive’s private app-data area, so your Mac and phone agree.' : 'Saved on this device only.';
    if (!$('#edit-dialog').open) $('#edit-dialog').showModal();
  }
  function saveEdit() {
    const i = state.byId.get(editId), form = editForms.get(editId);
    if (!i || !form) return;
    const record = { category: recordOf(editId).category };
    const title = form.title.trim();
    if (title && title !== i.auto.action) record.title = title;
    if ((form.due || '') !== (i.auto.due || '')) record.due = form.due || '';
    if (form.list !== i.auto.list) record.list = form.list;
    if (form.note.trim()) record.note = form.note.trim();
    editForms.delete(editId);
    $('#edit-dialog').close();
    const name = `“${S.shortSubject(i.subject, 40)}”`;
    putEdits(editId, record, `Saved your changes to ${name}.`, `Your changes to ${name} are undone.`);
  }
  function resetEdit() {
    const i = state.byId.get(editId);
    if (!i) return;
    editForms.delete(editId);
    $('#edit-dialog').close();
    const name = `“${S.shortSubject(i.subject, 40)}”`;
    putEdits(editId, { category: recordOf(editId).category }, `${name} is back to automatic.`, `Your changes to ${name} are back.`);
  }

  // ----- categories: Gmail labels; created and renamed on his tap, never deleted -----
  function openCategories(threadId) {
    catForm.threadId = threadId || '';
    catForm.renameId = '';
    renderCategoryDialog('');
    if (!$('#category-dialog').open) $('#category-dialog').showModal();
  }
  // Shows an outcome in the dialog with its own Undo, and in the toast for after the dialog closes; one Undo runs once.
  function catNotice(text, undo) {
    let used = false;
    const once = undo ? () => { if (used) return; used = true; catUndo = null; undo(); } : null;
    catUndo = once;
    toast(text, once);
    if ($('#category-dialog').open) renderCategoryDialog(text, !!once);
  }
  function renderCategoryDialog(status, withUndo) {
    const item = catForm.threadId ? state.byId.get(catForm.threadId) : null;
    const hidden = new Set(state.store.hidden());
    const all = G.categoryLabels(state.userLabels);
    $('#category-eyebrow').textContent = item ? 'Move to category' : 'Categories';
    $('#category-title').textContent = item ? S.shortSubject(item.subject, 60) : 'Your categories';
    let body = '';
    if (item) {
      const current = item.category ? item.category.id : '';
      body = `<p class="field-help">Pick a category. Your choice beats the rules and adds the Gmail label, so Gmail shows it too.</p>
        <div class="category-choices">${state.categories.map(c => `<button class="chip-btn ${current === c.id ? 'active' : ''}" type="button" data-act="pick-category" data-cat="${esc(c.id)}" aria-pressed="${current === c.id}">${esc(c.name)}</button>`).join('')}<button class="chip-btn ${current ? '' : 'active'}" type="button" data-act="pick-category" data-cat="" aria-pressed="${!current}">No category</button></div>`;
    } else {
      body = `<p class="field-help">Categories are Gmail labels: the ones AI Inbox made (under “AI Inbox”) and your own. Hide only hides one here; AI Inbox never deletes a label.</p>
        <ul class="category-manage">${all.map(c => catForm.renameId === c.id
          ? `<li><input id="category-rename" type="text" maxlength="60" aria-label="New name for ${esc(c.name)}" value="${esc(catForm.renameText)}"><button class="primary small" type="button" data-act="save-rename" data-cat="${esc(c.id)}">Save</button><button class="secondary small" type="button" data-act="cancel-rename">Cancel</button></li>`
          : `<li><span class="category-name ${hidden.has(c.id) ? 'muted' : ''}">${esc(c.name)}${c.own ? '' : ' <small>Gmail label</small>'}${hidden.has(c.id) ? ' <small>hidden</small>' : ''}</span><button class="text-button" type="button" data-act="rename-category" data-cat="${esc(c.id)}">Rename</button><button class="text-button" type="button" data-act="${hidden.has(c.id) ? 'show-category' : 'hide-category'}" data-cat="${esc(c.id)}">${hidden.has(c.id) ? 'Show' : 'Hide'}</button></li>`).join('') || '<li class="muted">No categories yet.</li>'}</ul>`;
    }
    body += `<label class="field-label" for="category-new">New category</label><div class="category-new"><input id="category-new" type="text" maxlength="60" autocomplete="off" placeholder="For example: Family, Taxes, House" value="${esc(catForm.newName)}"><button class="secondary" type="button" data-act="create-category">${item ? 'Create and move' : 'Create'}</button></div><p class="inline-status" id="category-status" role="status">${esc(status || '')}${withUndo ? ' <button class="text-button" type="button" data-act="category-undo">Undo</button>' : ''}</p>`;
    $('#category-body').innerHTML = body;
  }
  // Adds the chosen category label, takes off the one AI Inbox set before, and remembers the choice in his edits.
  function moveToCategory(threadId, catId) {
    const item = state.byId.get(threadId);
    if (!item) return;
    const before = recordOf(threadId);
    const ops = [];
    if (catId) {
      ops.push({ label: catId, op: 'add' });
      if (before.category && before.category !== catId) ops.push({ label: before.category, op: 'remove' });
    } else if (item.category) ops.push({ label: item.category.id, op: 'remove' });
    const after = Object.assign({}, before, { category: catId || undefined });
    const cat = state.categories.find(c => c.id === catId);
    const name = `“${S.shortSubject(item.subject, 40)}”`;
    $('#category-dialog').close();
    change({
      threadIds: [threadId], ops,
      text: cat ? `Moved ${name} to ${cat.name}.` : `Took ${name} out of its category.`,
      undoText: `${name} is back where it was.`,
      side: { apply: () => { state.store.put(threadId, after); persistEdits(''); }, undo: () => { state.store.put(threadId, before); persistEdits(''); } }
    });
  }
  async function createCategory() {
    const name = catForm.newName.trim();
    const problem = G.categoryNameProblem(name, state.userLabels);
    if (problem) { $('#category-status').textContent = problem; return; }
    $('#category-status').textContent = 'Creating…';
    let made;
    try { made = await run(() => state.backend.createCategory(name)); } catch (e) { $('#category-status').textContent = `Gmail did not create it: ${e.message}`; return; }
    state.userLabels = state.userLabels.concat({ id: made.id, name: made.name, type: 'user' });
    catForm.newName = '';
    recompute(); render();
    const moveTo = catForm.threadId;
    if (moveTo && state.byId.has(moveTo)) { moveToCategory(moveTo, made.id); return; }
    catNotice(`Created the category ${name}.${made.note ? ` ${made.note}` : ''}`, () => hideCategory(made.id, true, `Hid ${name} in AI Inbox. The Gmail label stays: AI Inbox never deletes.`));
  }
  async function renameCategory(id) {
    const c = G.categoryLabels(state.userLabels).find(x => x.id === id);
    const name = catForm.renameText.trim();
    if (!c) return;
    if (name === c.name) { catForm.renameId = ''; renderCategoryDialog(''); return; }
    if (!c.own && state.userLabels.some(l => l.name.startsWith(`${c.label}/`))) { $('#category-status').textContent = 'This Gmail label has labels inside it; rename it in Gmail so they move with it.'; return; }
    const problem = G.categoryNameProblem(name, state.userLabels, id);
    if (problem) { $('#category-status').textContent = problem; return; }
    const full = c.own ? G.CATEGORY_PREFIX + name : c.label.replace(/[^/]*$/, name);
    const rename = async to => {
      const res = await run(() => state.backend.renameLabel(id, to));
      state.userLabels = state.userLabels.map(l => l.id === id ? Object.assign({}, l, { name: to }) : l);
      recompute(); render();
      return res;
    };
    let res;
    try { res = await rename(full); } catch (e) { $('#category-status').textContent = `Gmail did not rename it: ${e.message}`; return; }
    catForm.renameId = ''; catForm.renameText = '';
    catNotice(`Renamed ${c.name} to ${name}.${res && res.note ? ` ${res.note}` : ''}`, async () => {
      try { await rename(c.label); catNotice(`${name} is ${c.name} again.`); } catch (e) { catNotice(`Undo failed: ${e.message}`); }
    });
  }
  function hideCategory(id, hide, text) {
    state.store.setHidden(id, hide);
    recompute(); render();
    const c = G.categoryLabels(state.userLabels).find(x => x.id === id);
    const msg = text || (c ? `${hide ? 'Hid' : 'Showing'} ${c.name}${hide ? ' in AI Inbox. The Gmail label stays.' : ' again.'}` : '');
    catNotice(msg, () => hideCategory(id, !hide));
    persistEdits(msg);
  }

  // ----- dialogs -----
  function showDetail(id) {
    const i = state.byId.get(id);
    if (!i) return;
    const link = linkFor(id);
    const editBits = i.edited ? `<div class="action-callout edited"><strong>Your edits</strong><p>${esc([i.titleEdited ? `Title: ${i.action}` : '', i.due ? `Due ${i.due}` : '', `List: ${LIST_TAG[i.list]}`].filter(Boolean).join(' · '))}</p>${i.note ? `<p class="detail-note">${esc(i.note)}</p>` : ''}</div>` : '';
    $('#detail-content').innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">${esc(LIST_TAG[i.list])} · ${esc(i.topic)}${i.done ? ' · Done' : ''}${i.pinned ? ' · Pinned' : ''}${i.starred ? ' · Starred' : ''}</p><h2 id="detail-title">${esc(i.subject)}</h2></div><button class="close-button" type="button" data-close="detail-dialog" aria-label="Close thread">×</button></div>
      <div class="detail-main"><div class="detail-meta"><span class="sender-avatar" aria-hidden="true">${esc(i.initials)}</span><div><strong>${esc(i.from)}</strong>${esc(i.fromAddress)} · ${esc(new Date(i.date).toLocaleString())} · ${i.count} message${i.count === 1 ? '' : 's'}</div></div>
      ${['todo', 'needsReply', 'waitingOn'].includes(i.list) ? `<div class="action-callout"><strong>Suggested next step</strong><p>${esc(i.action)}</p>${i.due ? dueChip(i.due) : ''}</div>` : ''}
      ${editBits}
      <p class="detail-summary">${esc(i.snippet)}</p>
      <details open><summary>Why this is here</summary>${i.reasons.map(r => `<p>${esc(r)}</p>`).join('')}<p>Sorted by plain rules in this browser. No AI service reads your mail.</p></details></div>
      <div class="detail-footer">${link ? `<a class="primary link-button" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open in Gmail ↗</a>` : '<button class="secondary" type="button" disabled>Open in Gmail ↗</button>'}<button class="secondary" type="button" data-act="draft" data-id="${esc(id)}">Draft reply</button><button class="secondary" type="button" data-act="edit" data-id="${esc(id)}">Edit</button>${i.done ? '' : `<button class="secondary" type="button" data-act="done" data-id="${esc(id)}">Mark done</button>`}<p>${link ? 'Opens this exact thread.' : 'Demo threads have no Gmail original.'}</p></div>`;
    $('#detail-dialog').showModal();
  }
  function openDraft(id) {
    const i = state.byId.get(id);
    const thread = threadById(id);
    if (!i || !thread) return;
    if (!drafts.has(id)) {
      const target = T.replyTarget(thread, state.me);
      if (!target || !target.to.length) { toast('No one to reply to in this thread.'); return; }
      drafts.set(id, { target, template: '', text: '', filled: '', previous: '', savedId: '', firstName: S.callName(target.to[0]), topic: S.shortSubject(target.subject, 60) });
    }
    draftId = id;
    const d = drafts.get(id);
    if (!d.template) chooseTemplate('thanks', true);
    $('#draft-title').textContent = T.replySubject(d.target.subject);
    $('#draft-to').textContent = `To ${d.target.to.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}`;
    $('#draft-eyebrow').textContent = live() ? 'Draft reply · saved to Gmail Drafts, never sent' : 'Draft reply · demo, nothing is saved';
    renderTemplates();
    $('#draft-text').value = d.text;
    $('#draft-status').textContent = d.savedId ? 'Saved in Gmail Drafts. Changes save over that draft.' : '';
    updateDraftLink();
    $('#draft-save').disabled = false;
    if (!$('#draft-dialog').open) $('#draft-dialog').showModal();
    updateDraftAuth();
  }
  function renderTemplates() {
    const d = drafts.get(draftId);
    $('#template-row').innerHTML = T.TEMPLATES.map(t => `<button type="button" class="chip-btn ${d && d.template === t.id ? 'active' : ''}" data-template="${t.id}" aria-pressed="${d && d.template === t.id}">${esc(t.label)}</button>`).join('');
  }
  function chooseTemplate(id, initial) {
    const d = drafts.get(draftId);
    if (!d) return;
    const filled = T.fillTemplate(id, { name: d.firstName, topic: d.topic, signoff: settings.signoff });
    const edited = d.text && d.text !== d.filled;
    if (edited) d.previous = d.text;
    d.template = id; d.filled = filled; d.text = filled;
    if (initial) return;
    $('#draft-text').value = filled;
    renderTemplates();
    $('#draft-status').innerHTML = edited ? 'The template replaced your text. <button type="button" class="text-button" data-act="restore-draft">Bring my text back</button>' : '';
  }
  function updateDraftLink() {
    const link = linkFor(draftId);
    const d = drafts.get(draftId);
    $('#draft-open').hidden = !(link && d && d.savedId);
    if (link) $('#draft-open').href = link;
  }
  function updateDraftAuth() {
    if (!$('#draft-dialog').open) return;
    const status = $('#draft-status');
    const prompt = status.querySelector('[data-act="reauth"]');
    if (live() && state.authNeeded && !prompt) status.innerHTML = 'Your Google sign-in lapsed. Your text is kept. <button type="button" class="primary small" data-act="reauth">Continue</button>';
    else if (!state.authNeeded && prompt) status.textContent = 'Signed in again. Saving…';
  }
  async function saveDraft() {
    const id = draftId;
    const d = drafts.get(id);
    if (!d) return;
    const raw = T.base64url(T.buildReplyMime({ to: d.target.to, subject: d.target.subject, inReplyTo: d.target.inReplyTo, references: d.target.references, body: d.text }));
    $('#draft-save').disabled = true;
    $('#draft-status').textContent = 'Saving…';
    try {
      const res = await run(() => d.savedId && state.backend.updateDraft ? state.backend.updateDraft(d.savedId, id, raw) : state.backend.createDraft(id, raw));
      if (res && res.id) d.savedId = res.id;
      if (draftId === id) {
        $('#draft-status').textContent = res && res.note ? res.note : 'Saved to Gmail Drafts. Nothing was sent.';
        updateDraftLink();
      }
      toast(res && res.note ? res.note : 'Draft saved in Gmail. Nothing was sent.');
    } catch (e) {
      if (draftId === id) $('#draft-status').textContent = `Could not save the draft: ${e.message}. Your text is kept.`;
    } finally {
      if (draftId === id) $('#draft-save').disabled = false;
    }
  }
  function genaItems() { return state.items.filter(i => inView(i, 'todo')); }
  function openGena() {
    const items = genaItems();
    $('#gena-list').innerHTML = items.map(i => `<label class="gena-item"><input type="checkbox" data-gena="${esc(i.id)}" checked> <span><strong>${esc(i.action)}</strong>${i.due ? ` · ${esc(i.due)}` : ''}</span></label>`).join('');
    updateGenaText();
    $('#gena-status').textContent = live() ? '' : 'Demo: notes carry no Gmail link, because demo threads have none.';
    $('#gena-dialog').showModal();
  }
  function updateGenaText() {
    const checked = new Set([...document.querySelectorAll('[data-gena]:checked')].map(el => el.dataset.gena));
    const items = genaItems().filter(i => checked.has(i.id));
    $('#gena-text').value = items.length ? T.genaExport(items, i => linkFor(i.id)) : '';
    $('#gena-copy').disabled = !items.length;
  }
  async function copyGena() {
    const text = $('#gena-text').value;
    const count = (text.match(/"title"/g) || []).length;
    try { await navigator.clipboard.writeText(text); $('#gena-status').textContent = `Copied ${count} to-do${count === 1 ? '' : 's'}. In Gena, open Import from Claude and paste.`; }
    catch (e) { $('#gena-text').select(); $('#gena-status').textContent = 'Copying was blocked; the text is selected, so copy it with ⌘C.'; }
  }
  function openSettings() {
    $('#signoff').value = settings.signoff;
    $('#with-promotions').checked = settings.withPromotions;
    $('#edits-where').textContent = !live() ? 'Demo: edits stay in this page and are not saved.' : state.store.mode === 'drive' ? 'Your edits (titles, due dates, lists, notes, category choices and hidden categories) are kept in one small file in your Google Drive’s private app-data area. Only AI Inbox can see it, so your Mac and phone agree.' : state.editsNote || 'Your edits are kept on this device only.';
    $('#info-dialog').showModal();
  }

  // ----- events -----
  document.addEventListener('click', event => {
    const el = event.target.closest('button, a.brand, summary');
    if (!el) return;
    if (el.matches('.brand')) { event.preventDefault(); state.view = 'overview'; state.topic = 'all'; state.search = ''; $('#search').value = ''; render(); return; }
    if (el.dataset.view) { state.view = el.dataset.view; render(); return; }
    if (el.dataset.topic) { state.topic = state.topic === el.dataset.topic ? 'all' : el.dataset.topic; if (state.view === 'overview' && state.topic !== 'all') state.view = 'all'; render(); return; }
    if (el.dataset.close) { document.getElementById(el.dataset.close).close(); return; }
    if (el.dataset.template) { chooseTemplate(el.dataset.template); return; }
    if (el.dataset.clear) {
      if (['all', 'topic'].includes(el.dataset.clear)) state.topic = 'all';
      if (['all', 'search'].includes(el.dataset.clear)) { state.search = ''; $('#search').value = ''; }
      render(); return;
    }
    const a = el.dataset.act, id = el.dataset.id;
    if (!a) return;
    const fromDetail = !!el.closest('#detail-dialog');
    if (fromDetail && a !== 'view') $('#detail-dialog').close();
    const menu = el.closest('details.more');
    if (menu) menu.open = false;
    if (a === 'view') showDetail(id);
    else if (a === 'draft') openDraft(id);
    else if (['done', 'reopen', 'remove', 'add-todo', 'archive', 'inbox', 'pin', 'unpin', 'star', 'unstar', 'important', 'unimportant'].includes(a)) act(a, id);
    else if (a === 'edit') openEdit(id);
    else if (a === 'category') openCategories(id);
    else if (a === 'manage-categories') openCategories('');
    else if (a === 'pick-category') moveToCategory(catForm.threadId, el.dataset.cat);
    else if (a === 'create-category') createCategory();
    else if (a === 'rename-category') { const c = G.categoryLabels(state.userLabels).find(x => x.id === el.dataset.cat); catForm.renameId = el.dataset.cat; catForm.renameText = c ? c.name : ''; renderCategoryDialog(''); const input = $('#category-rename'); if (input) input.focus(); }
    else if (a === 'cancel-rename') { catForm.renameId = ''; renderCategoryDialog(''); }
    else if (a === 'save-rename') renameCategory(el.dataset.cat);
    else if (a === 'hide-category' || a === 'show-category') hideCategory(el.dataset.cat, a === 'hide-category');
    else if (a === 'category-undo') { if (catUndo) catUndo(); }
    else if (a === 'topic-read') markTopicRead(el.dataset.topicName);
    else if (a === 'topic-all') { state.topic = el.dataset.topicName; state.view = 'all'; render(); }
    else if (a === 'gena') openGena();
    else if (a === 'show-more') { state.shown += PAGE; render(); }
    else if (a === 'reauth') requestToken();
    else if (a === 'refresh') load();
    else if (a === 'restore-draft') { const d = drafts.get(draftId); if (d && d.previous) { d.text = d.previous; d.previous = ''; $('#draft-text').value = d.text; $('#draft-status').textContent = 'Your text is back.'; } }
  });
  $('#signin').addEventListener('click', requestToken);
  $('#signout').addEventListener('click', signOut);
  $('#refresh').addEventListener('click', () => load());
  $('#toast-undo').addEventListener('click', () => { const fn = undoFn; undoFn = null; $('#toast-undo').hidden = true; if (fn) fn(); });
  $('#draft-text').addEventListener('input', event => { const d = drafts.get(draftId); if (d) d.text = event.target.value; });
  $('#draft-save').addEventListener('click', saveDraft);
  const editField = { 'edit-item-title': 'title', 'edit-due': 'due', 'edit-list': 'list', 'edit-note': 'note' };
  for (const [elId, key] of Object.entries(editField)) for (const type of ['input', 'change']) $(`#${elId}`).addEventListener(type, event => { const f = editForms.get(editId); if (f) f[key] = event.target.value; });
  $('#edit-save').addEventListener('click', saveEdit);
  $('#edit-reset').addEventListener('click', resetEdit);
  $('#category-body').addEventListener('input', event => {
    if (event.target.id === 'category-new') catForm.newName = event.target.value;
    if (event.target.id === 'category-rename') catForm.renameText = event.target.value;
  });
  $('#category-body').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    if (event.target.id === 'category-new') { event.preventDefault(); createCategory(); }
    if (event.target.id === 'category-rename') { event.preventDefault(); renameCategory(catForm.renameId); }
  });
  $('#gena-list').addEventListener('change', updateGenaText);
  $('#gena-copy').addEventListener('click', copyGena);
  $('#search').addEventListener('input', event => { state.search = event.target.value.trim(); render(); });
  $('#privacy-button').addEventListener('click', openSettings);
  $('#signoff').addEventListener('input', event => { settings.signoff = event.target.value; saveSettings(); });
  $('#with-promotions').addEventListener('change', event => {
    settings.withPromotions = event.target.checked; saveSettings();
    toast(live() ? (settings.withPromotions ? 'Also reading Promotions and Social. Refreshing…' : 'Leaving out Promotions and Social. Refreshing…') : 'Demo: with your mail this would reload with the new setting.');
    if (live()) load();
  });
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); $('#search').focus(); }
  });
  for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });

  $('#build-id').textContent = BUILD;
  $('#footer-build').textContent = `AI Inbox ${VERSION} · ${BUILD}`;
  useDemo();
  loadGis();
})();
