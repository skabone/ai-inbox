'use strict';
(() => {
  const BUILD = '2026-10-26-V1.1.1';
  const VERSION = 'V1.1';
  const S = window.AIInboxSorter, T = window.AIInboxTools, G = window.AIInboxGmail;
  const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const clientId = String((window.AI_INBOX_CONFIG || {}).clientId || '').trim();
  const hasClientId = /^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId) && !/PASTE|YOUR-CLIENT-ID/i.test(clientId);

  // Stored settings: declared once, before they are loaded. Only the sign-off is kept on this device; never mail.
  const SETTINGS_KEY = 'ai-inbox-settings-v1';
  const settings = { signoff: 'Mintay' };
  try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); if (saved && typeof saved.signoff === 'string') settings.signoff = saved.signoff; } catch (e) { /* storage blocked: defaults stay */ }
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* storage blocked: kept for this visit */ } }

  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { mode: 'demo', backend: null, view: 'overview', topic: 'all', search: '', me: '', threads: [], items: [], byId: new Map(), labels: {}, updatedAt: 0, loading: false, error: '', authNeeded: false, gisReady: false, gisFailed: false, loadSeq: 0 };
  let token = null; // {value, expiresAt}: memory only
  let tokenClient = null;
  let afterToken = [];
  const drafts = new Map(); // threadId → {target, template, text, filled, previous, savedId}: survives re-renders and refreshes
  let draftId = '';

  const views = [
    { id: 'overview', label: 'Overview', icon: '◫', title: 'Your inbox, in focus.', description: 'Suggested to-dos and topics to catch up on, from your Primary inbox.' },
    { id: 'needsReply', label: 'Needs reply', icon: '↩', title: 'A reply from you.', description: 'People who wrote to you directly with a question.' },
    { id: 'waitingOn', label: 'Waiting on', icon: '◷', title: 'The ball’s in their court.', description: 'You wrote last, 3 or more days ago, and nobody has answered yet.' },
    { id: 'done', label: 'Done', icon: '✓', title: 'Done.', description: 'Threads you marked done. A new message in the thread brings it back.' },
    { id: 'all', label: 'All', icon: '▤', title: 'Everything in view.', description: 'Your Primary inbox from the last 30 days, including mail kept for reference.' }
  ];
  const TOPIC_SYMBOL = { 'Purchases': '◇', 'Deliveries': '▣', 'Travel': '✈', 'Finances and bills': '$', 'Appointments': '◷', 'Events': '✦', 'Work and school': '▧', 'Other': '•' };
  const LIST_TAG = { todo: 'To-do', needsReply: 'Needs reply', waitingOn: 'Waiting on', topic: 'Topic', fyi: 'For reference' };

  const ctx = () => ({ me: state.me, now: Date.now(), labels: state.labels });
  function recompute() { state.items = S.sortThreads(state.threads, ctx()); state.byId = new Map(state.items.map(i => [i.id, i])); }
  const threadById = id => state.threads.find(t => t.id === id);
  const isOpen = i => !i.done && (i.inInbox || i.list === 'waitingOn' || i.todoLabel);
  const inView = (i, view) => view === 'done' ? i.done : !isOpen(i) ? false : view === 'needsReply' ? i.needsReply : view === 'waitingOn' ? i.list === 'waitingOn' : view === 'todo' ? i.list === 'todo' : true;
  const searchMatch = i => !state.search || `${i.from} ${i.fromAddress} ${i.subject} ${i.snippet}`.toLowerCase().includes(state.search.toLowerCase());
  const topicMatch = i => state.topic === 'all' || i.topic === state.topic;
  const live = () => state.mode === 'gmail';
  const linkFor = id => live() ? T.threadLink(state.me, id) : '';

  const timeOf = ms => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  const shortDate = ms => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(ms));
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
    const label = due < today ? `Overdue · ${shortDate(date)}` : due === today ? 'Due today' : due === tomorrow ? 'Due tomorrow' : `Due ${new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(date)}`;
    return `<span class="due ${due < today ? 'overdue' : ''}">${esc(label)}</span>`;
  }

  // ----- rendering -----
  function actionButtons(i) {
    const link = linkFor(i.id);
    const reply = link ? `<a class="chip-btn" data-act="reply" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Reply ↗</a>` : `<button class="chip-btn" type="button" disabled title="Demo: no Gmail thread">Reply ↗</button>`;
    const more = [];
    if (!i.done && !i.todoLabel && i.list !== 'todo') more.push(`<button type="button" data-act="add-todo" data-id="${esc(i.id)}">Add to to-dos</button>`);
    if (!i.done && (i.list === 'todo' || i.needsReply)) more.push(`<button type="button" data-act="remove" data-id="${esc(i.id)}">Remove</button>`);
    if (i.inInbox) more.push(`<button type="button" data-act="archive" data-id="${esc(i.id)}">Archive</button>`);
    return `<div class="row-actions">
      <button class="chip-btn" type="button" data-act="view" data-id="${esc(i.id)}">View</button>${reply}
      <button class="chip-btn" type="button" data-act="draft" data-id="${esc(i.id)}">Draft reply</button>
      ${i.done ? `<button class="chip-btn" type="button" data-act="reopen" data-id="${esc(i.id)}">Not done</button>` : `<button class="chip-btn strong" type="button" data-act="done" data-id="${esc(i.id)}">Mark done</button>`}
      ${more.length ? `<details class="more"><summary class="chip-btn">More</summary><div class="more-menu">${more.join('')}</div></details>` : ''}
    </div>`;
  }
  function rowHtml(i, kind) {
    const actionFirst = kind === 'todo' || ['todo', 'needsReply', 'waitingOn'].includes(i.list);
    const title = actionFirst ? i.action : i.subject;
    const sub = actionFirst ? `${i.subject} · ${i.snippet}` : i.snippet;
    const tags = [
      i.due ? dueChip(i.due) : '',
      kind === 'todo' ? '' : `<span class="tag ${i.list}">${esc(LIST_TAG[i.list])}</span>`,
      `<span class="tag">${esc(i.topic)}</span>`,
      i.done ? '<span class="tag done">Done</span>' : '',
      i.removed && !i.done ? '<span class="tag">Removed from to-dos</span>' : ''
    ].join('');
    return `<article class="row ${i.unread ? 'unread' : ''}" data-row="${esc(i.id)}">
      <span class="sender-avatar" aria-hidden="true">${esc(i.initials)}</span>
      <div class="row-main">
        <div class="row-top"><span class="sender-name">${esc(i.from)}${i.count > 1 ? ` <span class="msg-count">${i.count}</span>` : ''}</span><span class="row-age" title="${esc(new Date(i.date).toLocaleString())}">${esc(age(i.date))}</span></div>
        <button class="row-title" type="button" data-act="view" data-id="${esc(i.id)}">${i.unread ? '<span class="unread-dot" aria-label="Unread"></span>' : ''}${esc(title)}</button>
        <p class="row-sub">${esc(sub)}</p>
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
    const topics = S.TOPICS.map(t => [t, state.items.filter(i => isOpen(i) && i.topic === t).length]).filter(([, n]) => n);
    $('#topic-navigation').innerHTML = topics.map(([t, n]) => `<button class="nav-button ${state.topic === t ? 'active' : ''}" type="button" data-topic="${esc(t)}" aria-pressed="${state.topic === t}"><span class="topic-dot" aria-hidden="true">${esc(TOPIC_SYMBOL[t])}</span><span>${esc(t)}</span><span class="nav-count">${n}</span></button>`).join('');
  }
  function renderAccount() {
    $('#account').innerHTML = live()
      ? `<span class="avatar" aria-hidden="true">${esc(state.me.slice(0, 1).toUpperCase())}</span><div><strong>${esc(state.me)}</strong><small>Gmail · Primary</small></div>`
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
    else if (live() && state.loading && !state.updatedAt) html = '<strong>Loading your Primary inbox…</strong>';
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
    const todos = state.items.filter(i => inView(i, 'todo'));
    const groups = S.groupTopics(state.items.filter(isOpen));
    $('#overview').innerHTML = `<div class="section-heading"><div><h2>Suggested to-dos</h2><span>${todos.length} open</span></div><button class="text-button" type="button" data-act="gena" ${todos.length ? '' : 'disabled'}>Copy for Gena</button></div>
      <div class="todo-list">${todos.length ? todos.map(i => rowHtml(i, 'todo')).join('') : '<div class="empty-state"><h3>No suggested to-dos</h3><p>Nothing in your Primary inbox asks for an action right now.</p></div>'}</div>
      <div class="section-heading"><div><h2>Topics to catch up on</h2><span>${groups.length ? `${groups.reduce((n, g) => n + g.count, 0)} threads` : ''}</span></div></div>
      <div class="topic-grid">${groups.length ? groups.map(topicCard).join('') : '<div class="empty-state"><p>No topic mail in view.</p></div>'}</div>`;
  }
  function topicCard(g) {
    const threads = g.items.slice(0, 4).map(i => {
      const link = linkFor(i.id);
      const text = `${esc(i.subject)} <span class="topic-from">${esc(i.from)}</span>`;
      return `<li class="${i.unread ? 'unread' : ''}">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${text}</a>` : `<button type="button" data-act="view" data-id="${esc(i.id)}">${text}</button>`}</li>`;
    }).join('');
    return `<article class="topic-card" data-topic-card="${esc(g.topic)}">
      <div class="topic-head"><span class="topic-symbol" aria-hidden="true">${esc(TOPIC_SYMBOL[g.topic])}</span><h3>${esc(g.topic)}</h3><span class="topic-count">${g.count}</span></div>
      <p class="topic-latest"><strong>${esc(g.latest.from)}</strong> · ${esc(g.latest.snippet || g.latest.subject)}</p>
      <ul class="topic-threads">${threads}</ul>
      <div class="topic-actions"><button class="text-button" type="button" data-act="topic-read" data-topic-name="${esc(g.topic)}" ${g.unread ? '' : 'disabled'}>Mark all as read${g.unread ? ` (${g.unread})` : ''}</button>${g.count > 4 ? `<button class="text-button" type="button" data-act="topic-all" data-topic-name="${esc(g.topic)}">See all ${g.count}</button>` : ''}</div>
    </article>`;
  }
  function renderMessages() {
    if ($('#message-section').hidden) { $('#messages').innerHTML = ''; return; }
    const view = state.view === 'overview' ? 'all' : state.view;
    let list = state.items.filter(i => inView(i, view) && topicMatch(i) && searchMatch(i));
    if (view === 'all' || view === 'done') list = list.slice().sort((a, b) => b.date - a.date);
    $('#list-title').textContent = state.topic !== 'all' ? state.topic : state.search && state.view === 'overview' ? 'Search results' : views.find(v => v.id === view).label;
    $('#result-count').textContent = `${list.length} ${list.length === 1 ? 'thread' : 'threads'}`;
    $('#active-filters').innerHTML = `${state.topic !== 'all' ? `<button class="filter-chip" type="button" data-clear="topic">${esc(state.topic)} ×</button>` : ''}${state.search ? `<button class="filter-chip" type="button" data-clear="search">Search: ${esc(state.search)} ×</button>` : ''}`;
    $('#messages').innerHTML = list.length ? `<div class="messages-list">${list.map(i => rowHtml(i, 'list')).join('')}</div>` : `<div class="empty-state"><h3>Nothing here</h3><p>${state.search || state.topic !== 'all' ? 'Try a different name or word, or clear the filters.' : 'This list is empty right now.'}</p>${state.search || state.topic !== 'all' ? '<button class="secondary" type="button" data-clear="all">Clear filters</button>' : ''}</div>`;
  }
  function render() {
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
    tokenClient.requestAccessToken(options);
  }
  function onToken(resp) {
    if (!resp || resp.error) { toast(`Google sign-in did not finish${resp && resp.error ? `: ${resp.error}` : ''}.`); return; }
    if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) { toast('AI Inbox needs the Gmail permission to read and label your mail. Please sign in again and allow it.'); return; }
    token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 60000 };
    state.authNeeded = false;
    if (!live()) {
      state.mode = 'gmail';
      state.backend = G.createGmailClient({ getToken, fetchFn: (url, init) => fetch(url, init), onAuthLost: () => { token = null; } });
      state.threads = []; state.items = []; state.byId = new Map(); state.me = ''; state.updatedAt = 0;
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
  // Runs a Gmail call; when the token has lapsed it waits, queued, until one tap brings a new token, then runs again.
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
    drafts.clear();
    state.authNeeded = false; state.error = '';
    useDemo();
    toast('Signed out. Your mail has been cleared from this page.');
  }

  // ----- loading -----
  async function load() {
    if (state.loading) return;
    const seq = ++state.loadSeq;
    const backend = state.backend;
    state.loading = true; render();
    try {
      const res = await run(() => backend.load({ needsBody: S.needsBody, ctxFor: (me, labels) => ({ me, now: Date.now(), labels }) }));
      if (seq !== state.loadSeq || backend !== state.backend) return;
      state.me = res.me; state.threads = res.threads; state.labels = res.labels; state.updatedAt = Date.now(); state.error = '';
    } catch (e) {
      if (seq === state.loadSeq) state.error = e.message || String(e);
    } finally {
      if (seq === state.loadSeq) { state.loading = false; recompute(); render(); }
    }
  }
  function useDemo() {
    state.mode = 'demo';
    state.backend = G.createDemoBackend(() => window.INBOX_DEMO.build(Date.now()));
    state.loadSeq++; state.loading = false;
    state.threads = []; state.items = []; state.me = '';
    load();
  }

  // ----- label changes: exact per-message ids, applied at once, each with an Undo -----
  function messageIdsFor(threadIds, label, op) {
    const ids = [];
    for (const id of threadIds) {
      const t = threadById(id);
      if (!t) continue;
      for (const m of t.messages) {
        if (m.labelIds.includes('DRAFT')) continue;
        const has = m.labelIds.includes(label);
        if (op === 'add' ? !has : has) ids.push(m.id);
      }
    }
    return ids;
  }
  function applyLocal(messageIds, label, op) {
    const set = new Set(messageIds);
    for (const t of state.threads) for (const m of t.messages) {
      if (!set.has(m.id)) continue;
      if (op === 'add' && !m.labelIds.includes(label)) m.labelIds.push(label);
      if (op === 'remove') m.labelIds = m.labelIds.filter(l => l !== label);
    }
    recompute(); render();
  }
  async function labelChange({ threadIds, key, label, op, text, undoText }) {
    if (!label) {
      label = state.labels[key];
      if (!label) {
        try { label = await run(() => state.backend.ensureLabel(key)); } catch (e) { toast(`Could not create the label: ${e.message}`); return; }
        state.labels = Object.assign({}, state.labels, { [key]: label });
      }
    }
    const ids = messageIdsFor(threadIds, label, op);
    if (!ids.length) { toast('Already up to date in Gmail.'); return; }
    const inverse = op === 'add' ? 'remove' : 'add';
    const send = o => run(() => state.backend.modify(ids, o === 'add' ? [label] : [], o === 'remove' ? [label] : []));
    const undo = async () => {
      applyLocal(ids, label, inverse);
      toast(undoText);
      try { const note = await send(inverse); if (note) toast(`${undoText} ${note}`); } catch (e) { applyLocal(ids, label, op); toast(`Undo failed: ${e.message}`); }
    };
    applyLocal(ids, label, op);
    toast(text, undo);
    try { const note = await send(op); if (note && undoFn === undo) toast(`${text} ${note}`, undo); } catch (e) { applyLocal(ids, label, inverse); toast(`Gmail did not accept the change: ${e.message}`); }
  }
  function act(kind, id) {
    const item = state.byId.get(id);
    if (!item) return;
    const name = `“${S.shortSubject(item.subject, 40)}”`;
    if (kind === 'done') labelChange({ threadIds: [id], key: 'done', op: 'add', text: `Marked ${name} done.`, undoText: `${name} is open again.` });
    if (kind === 'reopen') labelChange({ threadIds: [id], key: 'done', op: 'remove', text: `${name} is open again.`, undoText: `Marked ${name} done.` });
    if (kind === 'remove' && item.todoLabel) labelChange({ threadIds: [id], key: 'todo', op: 'remove', text: `Removed ${name} from your to-dos.`, undoText: `${name} is back in your to-dos.` });
    else if (kind === 'remove') labelChange({ threadIds: [id], key: 'removed', op: 'add', text: `Removed ${name} from your to-dos.`, undoText: `${name} is back in your to-dos.` });
    if (kind === 'add-todo') labelChange({ threadIds: [id], key: 'todo', op: 'add', text: `Added ${name} to your to-dos.`, undoText: `Took ${name} out of your to-dos.` });
    if (kind === 'archive') labelChange({ threadIds: [id], label: 'INBOX', op: 'remove', text: `Archived ${name}.`, undoText: `${name} is back in the inbox.` });
  }
  function markTopicRead(topic) {
    const group = S.groupTopics(state.items.filter(isOpen)).find(g => g.topic === topic);
    if (!group) return;
    const ids = group.items.filter(i => i.unread).map(i => i.id);
    labelChange({ threadIds: ids, label: 'UNREAD', op: 'remove', text: `Marked ${ids.length} ${topic} thread${ids.length === 1 ? '' : 's'} as read.`, undoText: `${topic} threads are unread again.` });
  }

  // ----- dialogs -----
  function showDetail(id) {
    const i = state.byId.get(id);
    if (!i) return;
    const link = linkFor(id);
    $('#detail-content').innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">${esc(LIST_TAG[i.list])} · ${esc(i.topic)}${i.done ? ' · Done' : ''}</p><h2 id="detail-title">${esc(i.subject)}</h2></div><button class="close-button" type="button" data-close="detail-dialog" aria-label="Close thread">×</button></div>
      <div class="detail-main"><div class="detail-meta"><span class="sender-avatar" aria-hidden="true">${esc(i.initials)}</span><div><strong>${esc(i.from)}</strong>${esc(i.fromAddress)} · ${esc(new Date(i.date).toLocaleString())} · ${i.count} message${i.count === 1 ? '' : 's'}</div></div>
      ${['todo', 'needsReply', 'waitingOn'].includes(i.list) ? `<div class="action-callout"><strong>Suggested next step</strong><p>${esc(i.action)}</p>${i.due ? dueChip(i.due) : ''}</div>` : ''}
      <p class="detail-summary">${esc(i.snippet)}</p>
      <details open><summary>Why this is here</summary>${i.reasons.map(r => `<p>${esc(r)}</p>`).join('')}<p>Sorted by plain rules in this browser. No AI service reads your mail.</p></details></div>
      <div class="detail-footer">${link ? `<a class="primary link-button" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open in Gmail ↗</a>` : '<button class="secondary" type="button" disabled>Open in Gmail ↗</button>'}<button class="secondary" type="button" data-act="draft" data-id="${esc(id)}">Draft reply</button>${i.done ? '' : `<button class="secondary" type="button" data-act="done" data-id="${esc(id)}">Mark done</button>`}<p>${link ? 'Opens this exact thread.' : 'Demo threads have no Gmail original.'}</p></div>`;
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
    if (a === 'view') showDetail(id);
    else if (a === 'draft') openDraft(id);
    else if (['done', 'reopen', 'remove', 'add-todo', 'archive'].includes(a)) { const menu = el.closest('details'); if (menu) menu.open = false; act(a, id); }
    else if (a === 'topic-read') markTopicRead(el.dataset.topicName);
    else if (a === 'topic-all') { state.topic = el.dataset.topicName; state.view = 'all'; render(); }
    else if (a === 'gena') openGena();
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
  $('#gena-list').addEventListener('change', updateGenaText);
  $('#gena-copy').addEventListener('click', copyGena);
  $('#search').addEventListener('input', event => { state.search = event.target.value.trim(); render(); });
  $('#privacy-button').addEventListener('click', () => { $('#signoff').value = settings.signoff; $('#info-dialog').showModal(); });
  $('#signoff').addEventListener('input', event => { settings.signoff = event.target.value; saveSettings(); });
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
