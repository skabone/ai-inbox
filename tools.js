// AI Inbox pure helpers: the Gmail thread link, reply templates, the RFC 2822 draft and the Gena export. No DOM, no network.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIInboxTools = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The one place a Gmail URL is built. API thread ids open in the #all/ fragment for that signed-in account.
  function threadLink(address, threadId) {
    if (!address || !threadId) return '';
    return `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(address)}#all/${encodeURIComponent(threadId)}`;
  }
  function inboxLink(address) {
    return address ? `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(address)}#inbox` : 'https://mail.google.com/mail/u/0/#inbox';
  }

  const TEMPLATES = [
    { id: 'thanks', label: 'Thanks, got it', body: 'Hi {name},\n\nThanks, got it. I appreciate the update on {topic}.\n\n{signoff}' },
    { id: 'confirm', label: 'Confirm', body: 'Hi {name},\n\nConfirming {topic}. That works for me.\n\nThanks,\n{signoff}' },
    { id: 'reschedule', label: 'Ask to reschedule', body: 'Hi {name},\n\nSomething came up, so I need to reschedule {topic}. Could we find another time? A few options that work for me:\n\n- \n- \n\nSorry for the change,\n{signoff}' },
    { id: 'more-time', label: 'Need more time', body: 'Hi {name},\n\nThanks for your patience on {topic}. I need a little more time and will get back to you by .\n\n{signoff}' },
    { id: 'blank', label: 'Blank', body: 'Hi {name},\n\n\n\n{signoff}' }
  ];
  function fillTemplate(id, values) {
    const tpl = TEMPLATES.find(t => t.id === id) || TEMPLATES[TEMPLATES.length - 1];
    const v = { name: values.name || 'there', topic: values.topic || 'this', signoff: values.signoff || 'Mintay' };
    return tpl.body.replace(/\{(name|topic|signoff)\}/g, (_, key) => v[key]);
  }

  function utf8Bytes(text) { return new TextEncoder().encode(String(text)); }
  function base64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function base64url(text) { return base64(utf8Bytes(text)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function decodeBase64url(data) {
    const b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
  }

  const oneLine = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  function encodeHeader(value) {
    const v = oneLine(value);
    return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${base64(utf8Bytes(v))}?=`;
  }
  function formatAddress(addr) {
    const email = oneLine(addr.email).replace(/[<>,]/g, '');
    const name = oneLine(addr.name).replace(/"/g, '');
    if (!name) return email;
    const shown = /^[\x20-\x7e]*$/.test(name) ? (/[(),.:;<>@[\]\\]/.test(name) ? `"${name}"` : name) : encodeHeader(name);
    return `${shown} <${email}>`;
  }
  function replySubject(subject) {
    const s = oneLine(subject);
    return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
  }

  // RFC 2822 reply. Header values lose any line breaks so typed text cannot add headers.
  function buildReplyMime({ to, cc, subject, inReplyTo, references, body }) {
    const lines = [`To: ${(to || []).map(formatAddress).join(', ')}`];
    if (cc && cc.length) lines.push(`Cc: ${cc.map(formatAddress).join(', ')}`);
    lines.push(`Subject: ${encodeHeader(replySubject(subject))}`);
    if (inReplyTo) {
      lines.push(`In-Reply-To: ${oneLine(inReplyTo)}`);
      lines.push(`References: ${oneLine([references, inReplyTo].filter(Boolean).join(' '))}`);
    }
    lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit');
    return `${lines.join('\r\n')}\r\n\r\n${String(body || '').replace(/\r?\n/g, '\r\n')}`;
  }

  // Who a reply goes to, and what it threads under: the newest message from someone else (Reply-To first), or, when he wrote last, his recipients.
  function replyTarget(thread, me) {
    const mine = a => !!me && String(a && a.email || '').toLowerCase() === String(me).toLowerCase();
    const msgs = (thread.messages || []).filter(m => !(m.labelIds || []).includes('DRAFT')).slice().sort((a, b) => a.date - b.date);
    const latest = msgs[msgs.length - 1];
    if (!latest) return null;
    const others = msgs.filter(m => !mine(m.from));
    const lastOther = others[others.length - 1];
    const to = mine(latest.from) || !lastOther ? (latest.to || []).filter(a => !mine(a)) : [lastOther.replyTo || lastOther.from];
    return { to, subject: (msgs.find(m => m.subject) || latest).subject || '', inReplyTo: latest.messageId || '', references: latest.references || '' };
  }

  // Gena's "Import from Claude" input: one fenced json block of tasks; no day, so dateless tasks land on Someday.
  function genaExport(items, linkFor) {
    const tasks = items.map(item => {
      const task = { title: item.action };
      if (item.due) task.due = item.due;
      const link = linkFor ? linkFor(item) : '';
      task.notes = `From ${item.from}: ${item.subject}${link ? `\n${link}` : ''}`;
      return task;
    });
    return '```json\n' + JSON.stringify({ tasks }, null, 2) + '\n```';
  }

  return { threadLink, inboxLink, TEMPLATES, fillTemplate, base64url, decodeBase64url, encodeHeader, formatAddress, replySubject, buildReplyMime, replyTarget, genaExport };
});
