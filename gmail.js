// AI Inbox Gmail access: a small REST client (read, label changes, drafts) and the same interface over demo fixtures.
// Mail lives in memory only. This file never sends, never deletes and never moves mail to the bin.
(function (root, factory) {
  const api = factory(root.AIInboxTools || (typeof require === 'function' ? require('./tools.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIInboxGmail = api;
})(typeof self !== 'undefined' ? self : this, function (tools) {
  'use strict';

  const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';
  // Every inbox tab except Promotions and Social, unless his setting adds those two.
  const INBOX_QUERY = 'in:inbox newer_than:30d -category:promotions -category:social';
  const INBOX_QUERY_ALL_TABS = 'in:inbox newer_than:30d';
  const SENT_QUERY = 'in:sent newer_than:30d';
  const MAX_THREADS = 100;
  const MAX_INBOX = 200;
  const MAX_KEPT = 50; // starred, pinned and to-do threads, whatever their age
  const BATCH = 50; // threads read between renders
  const HEADERS = ['Subject', 'From', 'To', 'Cc', 'Date', 'Reply-To', 'Message-ID', 'References', 'List-Unsubscribe'];
  const STATE_LABELS = { todo: 'AI Inbox/To-do', done: 'AI Inbox/Done', removed: 'AI Inbox/Removed', pinned: 'AI Inbox/Pinned' };
  const PARENT_LABEL = 'AI Inbox';
  const CATEGORY_PREFIX = 'AI Inbox/';
  const inboxQuery = withPromotions => withPromotions ? INBOX_QUERY_ALL_TABS : INBOX_QUERY;
  const NEW_LABEL = { labelListVisibility: 'labelShow', messageListVisibility: 'show' };

  // His user labels offered as categories: not system labels, not the "AI Inbox" parent, not Done, Removed, To-do or Pinned.
  function categoryLabels(labels) {
    const reserved = new Set([PARENT_LABEL, ...Object.values(STATE_LABELS)]);
    return (labels || []).filter(l => l && l.type === 'user' && l.name && !reserved.has(l.name))
      .map(l => ({ id: l.id, name: l.name.startsWith(CATEGORY_PREFIX) ? l.name.slice(CATEGORY_PREFIX.length) : l.name, label: l.name, own: l.name.startsWith(CATEGORY_PREFIX) }))
      .sort((a, b) => (b.own - a.own) || a.name.localeCompare(b.name));
  }
  // A category name he types: one line, no slash (that would nest it), not a reserved or existing name. Returns an error text or ''.
  function categoryNameProblem(name, labels, exceptId) {
    const n = String(name || '').trim();
    if (!n) return 'Type a name.';
    if (n.length > 60) return 'Keep it under 60 characters.';
    if (/[\/\r\n]/.test(n)) return 'A category name cannot contain a slash.';
    const full = (CATEGORY_PREFIX + n).toLowerCase();
    if (Object.values(STATE_LABELS).some(v => v.toLowerCase() === full)) return 'That name is used by AI Inbox itself.';
    if ((labels || []).some(l => l.id !== exceptId && (l.name.toLowerCase() === full || l.name.toLowerCase() === n.toLowerCase()))) return 'A label with that name already exists.';
    return '';
  }

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
    async function parentLabel() {
      if (!labelCache) labelCache = await listLabels();
      if (!labelCache.some(l => l.name === PARENT_LABEL)) labelCache.push(await call('POST', 'labels', Object.assign({ name: PARENT_LABEL }, NEW_LABEL)));
    }
    const api = {
      mode: 'gmail',
      // Reads 4 threads at a time; onBatch (when given) sees the threads read so far after every 50, so the page renders once per batch.
      async load({ needsBody, ctxFor, withPromotions, onBatch }) {
        const profile = await call('GET', 'profile');
        const labels = await listLabels();
        labelCache = labels;
        const ids = labelIdsFrom(labels);
        const kept = id => id ? listThreadIds({ labelIds: id, maxResults: MAX_KEPT }) : Promise.resolve([]);
        const lists = await Promise.all([
          listThreadIds({ q: inboxQuery(withPromotions), maxResults: MAX_INBOX }),
          listThreadIds({ q: SENT_QUERY }),
          kept('STARRED'),
          kept(ids.pinned),
          kept(ids.todo)
        ]);
        const unique = [...new Set(lists.flat())];
        const threads = [];
        for (let i = 0; i < unique.length; i += BATCH) {
          threads.push(...await mapLimit(unique.slice(i, i + BATCH), 4, getThread));
          if (onBatch) await onBatch({ me: profile.emailAddress, threads: threads.slice(), labels: ids, userLabels: labels });
        }
        const ctx = ctxFor(profile.emailAddress, ids);
        const wanting = threads.filter(t => needsBody(t, ctx));
        await mapLimit(wanting, 4, async t => {
          const msg = t.messages.filter(m => !m.labelIds.includes('DRAFT')).sort((a, b) => a.date - b.date).pop();
          if (msg) msg.body = await getBody(msg.id);
        });
        return { me: profile.emailAddress, threads, labels: ids, userLabels: labels };
      },
      // Creates a state label (and its "AI Inbox" parent) only when missing, only from a tap.
      async ensureLabel(key) {
        if (!labelCache) labelCache = await listLabels();
        const want = STATE_LABELS[key];
        const found = labelCache.find(l => l.name === want);
        if (found) return found.id;
        await parentLabel();
        const made = await call('POST', 'labels', Object.assign({ name: want }, NEW_LABEL));
        labelCache.push(made);
        return made.id;
      },
      // A new category is the Gmail label "AI Inbox/<name>". Returns the new label.
      async createCategory(name) {
        await parentLabel();
        const made = await call('POST', 'labels', Object.assign({ name: CATEGORY_PREFIX + String(name).trim() }, NEW_LABEL));
        labelCache.push(made);
        return made;
      },
      // Renames a label in Gmail (labels.patch, name only). Returns the label as Gmail now has it.
      async renameLabel(id, fullName) {
        const res = await call('PATCH', `labels/${encodeURIComponent(id)}`, { name: fullName });
        if (labelCache) labelCache = labelCache.map(l => l.id === id ? Object.assign({}, l, { name: fullName }) : l);
        return res && res.id ? res : { id, name: fullName, type: 'user' };
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
    return { todo: byName(STATE_LABELS.todo), done: byName(STATE_LABELS.done), removed: byName(STATE_LABELS.removed), pinned: byName(STATE_LABELS.pinned) };
  }

  // Demo: the same interface over invented fixtures, kept in memory. Each change says what it would do in Gmail.
  // Demo state labels use their names as ids; demo user labels (categories) live in this backend, so a refresh keeps them.
  function createDemoBackend(fixture) {
    let userLabels = null;
    let made = 0;
    const shown = id => { const l = (userLabels || []).find(x => x.id === id); return l ? l.name : id; };
    return {
      mode: 'demo',
      async load() {
        const data = fixture();
        if (!userLabels) userLabels = data.labels.slice();
        return { me: data.me, threads: data.threads, labels: Object.assign({}, STATE_LABELS), userLabels: userLabels.slice() };
      },
      async ensureLabel(key) { return STATE_LABELS[key]; },
      async createCategory(name) { const l = { id: `Label_demo_${++made}`, name: CATEGORY_PREFIX + String(name).trim(), type: 'user' }; userLabels.push(l); return Object.assign({ note: `Demo: in Gmail this would create the label ${l.name}.` }, l); },
      async renameLabel(id, fullName) { userLabels = userLabels.map(l => l.id === id ? Object.assign({}, l, { name: fullName }) : l); return { id, name: fullName, type: 'user', note: `Demo: in Gmail this would rename the label to ${fullName}.` }; },
      async modify(messageIds, add, remove) {
        const parts = [];
        if (add.length) parts.push(`add ${add.map(shown).join(', ')}`);
        if (remove.length) parts.push(`remove ${remove.map(shown).join(', ')}`);
        return `Demo: in Gmail this would ${parts.join(' and ')} on ${messageIds.length} message${messageIds.length === 1 ? '' : 's'}.`;
      },
      async createDraft() { return { id: '', note: 'Demo: in Gmail this would save the reply to Drafts. Nothing is sent.' }; }
    };
  }

  return { BASE, INBOX_QUERY, INBOX_QUERY_ALL_TABS, SENT_QUERY, MAX_INBOX, HEADERS, STATE_LABELS, CATEGORY_PREFIX, inboxQuery, categoryLabels, categoryNameProblem, AuthError, mapLimit, parseAddressList, parseAddress, decodeEntities, normalizeThread, extractPlainText, createGmailClient, createDemoBackend, labelIdsFrom };
});
