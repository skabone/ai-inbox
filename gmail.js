// AI Inbox Gmail access: a small REST client (read, label changes, drafts) and the same interface over demo fixtures.
// Mail lives in memory only. This file never sends, never deletes and never moves mail to the bin.
(function (root, factory) {
  const api = factory(root.AIInboxTools || (typeof require === 'function' ? require('./tools.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIInboxGmail = api;
})(typeof self !== 'undefined' ? self : this, function (tools) {
  'use strict';

  const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';
  const INBOX_QUERY = 'in:inbox category:primary newer_than:30d';
  const SENT_QUERY = 'in:sent newer_than:30d';
  const MAX_THREADS = 100;
  const HEADERS = ['Subject', 'From', 'To', 'Cc', 'Date', 'Reply-To', 'Message-ID', 'References', 'List-Unsubscribe'];
  const STATE_LABELS = { todo: 'AI Inbox/To-do', done: 'AI Inbox/Done', removed: 'AI Inbox/Removed' };
  const PARENT_LABEL = 'AI Inbox';

  class AuthError extends Error { constructor(message) { super(message || 'Google sign-in needed'); this.name = 'AuthError'; } }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // "Name <a@b>, "Last, First" <c@d>, e@f" → [{name, email}]
  function parseAddressList(value) {
    const out = [];
    let buf = '', quoted = false, angle = 0;
    const flush = () => { const a = parseAddress(buf); if (a.email) out.push(a); buf = ''; };
    for (const ch of String(value || '')) {
      if (ch === '"') quoted = !quoted;
      else if (ch === '<' && !quoted) angle++;
      else if (ch === '>' && !quoted) angle = Math.max(0, angle - 1);
      if (ch === ',' && !quoted && !angle) flush(); else buf += ch;
    }
    flush();
    return out;
  }
  function parseAddress(text) {
    const s = String(text || '').trim();
    const m = s.match(/^(.*)<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim().replace(/^"|"$/g, '').trim(), email: m[2].trim() };
    return { name: '', email: s.replace(/^"|"$/g, '') };
  }
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeEntities(s) {
    return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
      if (code[0] === '#') { const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : all; }
      return ENTITIES[code.toLowerCase()] ?? all;
    });
  }

  function normalizeMessage(m) {
    const h = {};
    for (const x of (m.payload && m.payload.headers) || []) h[x.name.toLowerCase()] = x.value;
    return {
      id: m.id,
      threadId: m.threadId,
      labelIds: (m.labelIds || []).slice(),
      date: Number(m.internalDate) || Date.parse(h.date) || 0,
      from: parseAddress(h.from),
      to: parseAddressList(h.to),
      cc: parseAddressList(h.cc),
      replyTo: h['reply-to'] ? parseAddressList(h['reply-to'])[0] || null : null,
      subject: h.subject || '',
      snippet: decodeEntities(m.snippet),
      messageId: h['message-id'] || '',
      references: h.references || '',
      listUnsubscribe: !!h['list-unsubscribe'],
      body: null
    };
  }
  function normalizeThread(t) { return { id: t.id, messages: (t.messages || []).map(normalizeMessage) }; }

  // Plain text of a format=full message: the text/plain part, else text/html with tags stripped. Capped; kept in memory only.
  function extractPlainText(payload, cap = 5000) {
    const parts = [];
    (function walk(p) { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); })(payload);
    const pick = type => parts.find(p => p.mimeType === type && p.body && p.body.data);
    const plain = pick('text/plain');
    if (plain) return tools.decodeBase64url(plain.body.data).slice(0, cap);
    const html = pick('text/html');
    if (!html) return '';
    return decodeEntities(tools.decodeBase64url(html.body.data).replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim().slice(0, cap);
  }

  // The live client. getToken() returns the in-memory access token or throws AuthError; fetchFn is the browser's fetch.
  function createGmailClient({ getToken, fetchFn, onAuthLost }) {
    async function call(method, path, body) {
      const token = getToken();
      const res = await fetchFn(BASE + path, {
        method,
        headers: Object.assign({ Authorization: `Bearer ${token}` }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
      if (res.status === 401) { if (onAuthLost) onAuthLost(); throw new AuthError('Google sign-in expired'); }
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error.message; } catch (e) { detail = res.statusText; }
        throw new Error(`Gmail ${res.status}: ${detail}`);
      }
      return res.status === 204 ? null : res.json().catch(() => null);
    }
    const qs = params => Object.entries(params).flatMap(([k, v]) => [].concat(v).map(x => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`)).join('&');

    async function listThreadIds(params) {
      const res = await call('GET', `threads?${qs(Object.assign({ maxResults: MAX_THREADS }, params))}`);
      return ((res && res.threads) || []).map(t => t.id);
    }
    async function getThread(id) {
      return normalizeThread(await call('GET', `threads/${encodeURIComponent(id)}?${qs({ format: 'metadata', metadataHeaders: HEADERS })}`));
    }
    async function getBody(messageId) {
      const m = await call('GET', `messages/${encodeURIComponent(messageId)}?format=full`);
      return extractPlainText(m && m.payload);
    }
    async function listLabels() {
      const res = await call('GET', 'labels');
      return (res && res.labels) || [];
    }

    let labelCache = null;
    const api = {
      mode: 'gmail',
      async load({ needsBody, ctxFor }) {
        const profile = await call('GET', 'profile');
        const labels = await listLabels();
        labelCache = labels;
        const ids = labelIdsFrom(labels);
        const lists = await Promise.all([
          listThreadIds({ q: INBOX_QUERY }),
          listThreadIds({ q: SENT_QUERY }),
          ids.todo ? listThreadIds({ labelIds: ids.todo, maxResults: 50 }) : Promise.resolve([])
        ]);
        const unique = [...new Set(lists.flat())];
        const threads = await mapLimit(unique, 4, getThread);
        const ctx = ctxFor(profile.emailAddress, ids);
        const wanting = threads.filter(t => needsBody(t, ctx));
        await mapLimit(wanting, 4, async t => {
          const msg = t.messages.filter(m => !m.labelIds.includes('DRAFT')).sort((a, b) => a.date - b.date).pop();
          if (msg) msg.body = await getBody(msg.id);
        });
        return { me: profile.emailAddress, threads, labels: ids };
      },
      // Creates a state label (and its "AI Inbox" parent) only when missing, only from a tap.
      async ensureLabel(key) {
        if (!labelCache) labelCache = await listLabels();
        const want = STATE_LABELS[key];
        const found = labelCache.find(l => l.name === want);
        if (found) return found.id;
        if (!labelCache.some(l => l.name === PARENT_LABEL)) labelCache.push(await call('POST', 'labels', { name: PARENT_LABEL, labelListVisibility: 'labelShow', messageListVisibility: 'show' }));
        const made = await call('POST', 'labels', { name: want, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
        labelCache.push(made);
        return made.id;
      },
      async modify(messageIds, addLabelIds, removeLabelIds) {
        await call('POST', 'messages/batchModify', { ids: messageIds, addLabelIds, removeLabelIds });
        return '';
      },
      async createDraft(threadId, raw) {
        const res = await call('POST', 'drafts', { message: { threadId, raw } });
        return { id: res && res.id, note: '' };
      },
      async updateDraft(draftId, threadId, raw) {
        const res = await call('PUT', `drafts/${encodeURIComponent(draftId)}`, { id: draftId, message: { threadId, raw } });
        return { id: (res && res.id) || draftId, note: '' };
      }
    };
    return api;
  }
  function labelIdsFrom(labels) {
    const byName = name => (labels.find(l => l.name === name) || {}).id || '';
    return { todo: byName(STATE_LABELS.todo), done: byName(STATE_LABELS.done), removed: byName(STATE_LABELS.removed) };
  }

  // Demo: the same interface over invented fixtures, kept in memory. Each change says what it would do in Gmail.
  function createDemoBackend(fixture) {
    const names = { [STATE_LABELS.todo]: STATE_LABELS.todo, [STATE_LABELS.done]: STATE_LABELS.done, [STATE_LABELS.removed]: STATE_LABELS.removed };
    const shown = id => names[id] || id;
    return {
      mode: 'demo',
      async load() {
        const data = fixture();
        return { me: data.me, threads: data.threads, labels: { todo: STATE_LABELS.todo, done: STATE_LABELS.done, removed: STATE_LABELS.removed } };
      },
      async ensureLabel(key) { return STATE_LABELS[key]; },
      async modify(messageIds, add, remove) {
        const parts = [];
        if (add.length) parts.push(`add ${add.map(shown).join(', ')}`);
        if (remove.length) parts.push(`remove ${remove.map(shown).join(', ')}`);
        return `Demo: in Gmail this would ${parts.join(' and ')} on ${messageIds.length} message${messageIds.length === 1 ? '' : 's'}.`;
      },
      async createDraft() { return { id: '', note: 'Demo: in Gmail this would save the reply to Drafts. Nothing is sent.' }; }
    };
  }

  return { BASE, INBOX_QUERY, SENT_QUERY, HEADERS, STATE_LABELS, AuthError, mapLimit, parseAddressList, parseAddress, decodeEntities, normalizeThread, extractPlainText, createGmailClient, createDemoBackend, labelIdsFrom };
});
