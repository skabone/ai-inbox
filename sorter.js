// AI Inbox rules sorter. Pure functions: no DOM, no network, no storage. Loads in the browser (window.AIInboxSorter) and in Node (require).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIInboxSorter = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LISTS = ['todo', 'needsReply', 'waitingOn', 'topic', 'fyi'];
  const TOPICS = ['Purchases', 'Deliveries', 'Travel', 'Finances and bills', 'Appointments', 'Events', 'Work and school', 'Other'];
  const DAY = 86400000;
  const WAITING_DAYS = 3;

  // Sender type: an address whose local part reads like a machine, or list mail, is not a person.
  const MACHINE_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|info|news|newsletters?|updates?|mailer(?:-daemon)?|billing|bills?|support|help|orders?|order-updates?|shipping|shipment|delivery|account|accounts|team|hello|marketing|receipts?|service|customerservice|auto(?:mated)?|bounce|postmaster|reminders?|statements?|digest|events?|rsvp|calendar|bookings?|reservations?|admin|system|security|store|shop|sales|deals|offers|feedback|survey|community|members?|membership|travel|trips?|flights?|appointments?|scheduling|frontdesk|office|payments?|invoices?)(?:[-_.+]|$)/i;
  const MACHINE_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'CATEGORY_UPDATES'];

  const ASK = /\b(?:can you|could you|would you|will you|are you|do you|did you|have you|let me know|please (?:let me know|reply|respond|advise|send|review|choose|decide)|what do you think|your thoughts|get back to me|when (?:are|can|would|will) you|any chance|which (?:one|option) (?:do|would) you)\b/;
  const CONFIRM = /\b(?:please confirm|confirm (?:your|the|that|whether|if|by|attendance)|can you confirm|reply to confirm|confirmation (?:is )?needed|are you (?:still )?coming|will you attend|let us know (?:if|whether|by)|accept or decline|keep (?:the|your) (?:reservation|hold|booking))\b/;
  const RSVP = /\b(?:rsvp|r\.s\.v\.p|you(?:'re| are) invited|invitation to)\b/;
  const APPOINTMENT = /\b(?:appointment|appt|check-?up|dentist|dental|clinic|doctor|consultation|your visit|cleaning|physical exam|reschedul\w*)\b|\bdr\.\s/;
  const MONEY = /\$\s?\d|\bamount due\b|\bbalance due\b|\bpayment (?:is )?due\b|\bminimum payment\b/;
  const BILL_WORD = /\b(?:bill|invoice|statement|payment|amount due|balance)\b/;
  const PAID = /\b(?:autopay (?:is )?(?:on|scheduled|enabled)|automatic payment|payment (?:received|scheduled|confirmed|posted)|thank you for your payment|has been paid|paid in full|no action (?:is )?needed)\b/;

  const TOPIC_RULES = [
    ['Deliveries', /\b(?:shipped|has shipped|out for delivery|delivered|delivery|tracking (?:number|info)|package|arriving|on its way|on the way|shipment)\b/],
    ['Travel', /\b(?:flight|boarding|itinerary|airline|airport|hotel|check-?in|trip|rental car|confirmation code|departure|gate|seat assignment)\b/],
    ['Appointments', APPOINTMENT],
    ['Finances and bills', /\b(?:bill|statement|payment|invoice|balance|bank|autopay|tax(?:es)?|credit card|transfer|deposit|amount due)\b/],
    ['Purchases', /\b(?:order(?:ed)?|receipt|purchase[sd]?|refund|return label|subscription renew\w*)\b/],
    ['Events', /\b(?:event|rsvp|invitation|invited|tickets?|concert|party|webinar|meetup|festival|lunch|dinner|gathering|celebration|room hold|reservation)\b/],
    ['Work and school', /\b(?:class(?:es)?|course|assignment|syllabus|students?|semester|quarter|grades?|grading|office hours|lecture|campus|canvas|meeting|project|workshop|agenda|budget|faculty|department|proposal|report|draft)\b/]
  ];

  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const WD = '(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?';
  const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  const DATE = `(today|tonight|tomorrow|(?:(?:this|next)\\s+)?${WD}(?:,?\\s+${MON}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)?|${MON}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)`;
  const CUE = '(?:by|due(?:\\s+(?:on|by|date(?:\\s+is)?))?|before|until|deadline(?:\\s+is)?|expires?(?:\\s+on)?|ends?(?:\\s+on)?|no later than|pay by|closes?(?:\\s+on)?)';
  const DUE_RE = new RegExp(`\\b${CUE}:?\\s+(?:the\\s+)?(?:end of\\s+)?${DATE}\\b`, 'i');
  const DAY_RE = new RegExp(`\\b(?:on\\s+|for\\s+)?${DATE}\\b`, 'i');

  const lower = s => String(s || '').toLowerCase();
  const stripUrls = s => String(s || '').replace(/https?:\/\/\S+/g, ' ');
  const pad = n => String(n).padStart(2, '0');

  // Calendar day from local getters, never toISOString (that is UTC).
  function localDay(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function startOfDay(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  // Resolve one date phrase against the day it was written (the message date), in local time.
  function resolveDate(phrase, baseMs) {
    const p = lower(phrase).replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/\./g, '').trim();
    const base = startOfDay(baseMs);
    const add = days => new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
    if (p === 'today' || p === 'tonight') return add(0);
    if (p === 'tomorrow') return add(1);
    const slash = p.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (slash) {
      let year = slash[3] ? Number(slash[3]) : base.getFullYear();
      if (year < 100) year += 2000;
      return rollYear(new Date(year, Number(slash[1]) - 1, Number(slash[2])), base, !slash[3]);
    }
    const md = p.match(/([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
    if (md) {
      const month = MONTHS.indexOf(md[1].slice(0, 3));
      if (month >= 0) return rollYear(new Date(md[3] ? Number(md[3]) : base.getFullYear(), month, Number(md[2])), base, !md[3]);
    }
    const wd = p.match(/^(?:(this|next)\s+)?([a-z]+)/);
    if (wd) {
      const index = WEEKDAYS.findIndex(name => name.startsWith(wd[2].slice(0, 3)));
      if (index >= 0) {
        let ahead = (index - base.getDay() + 7) % 7;
        if (wd[1] === 'next' && ahead === 0) ahead = 7;
        return add(ahead);
      }
    }
    return null;
  }
  function rollYear(date, base, guessedYear) {
    if (guessedYear && date < new Date(base.getFullYear(), base.getMonth(), base.getDate() - 60)) date.setFullYear(date.getFullYear() + 1);
    return date;
  }

  // A due date only when the text pairs a date with a due cue ("by Tuesday", "due Nov 3", "ends tomorrow").
  function findDue(text, baseMs) {
    const m = stripUrls(text).match(DUE_RE);
    if (!m) return null;
    const date = resolveDate(m[1], baseMs);
    return date ? localDay(date) : null;
  }
  function findDayWord(text) {
    const m = stripUrls(text).match(DAY_RE);
    if (!m) return '';
    const word = m[1].trim();
    return /^\d/.test(word) ? word : word.replace(/^(this|next)\s+/i, '').replace(/^\w/, c => c.toUpperCase()).replace(/,.*$/, '');
  }

  const emailOf = a => lower(a && a.email).trim();
  function isMe(addr, me) { return !!me && emailOf(addr) === lower(me); }
  function isPersonMessage(msg) {
    const local = emailOf(msg.from).split('@')[0];
    if (!local || MACHINE_LOCAL.test(local)) return false;
    if (msg.listUnsubscribe) return false;
    return !(msg.labelIds || []).some(id => MACHINE_LABELS.includes(id));
  }

  function shortSubject(subject, max = 48) {
    let s = String(subject || '').trim();
    while (/^(re|fwd?|fw)\s*:\s*/i.test(s)) s = s.replace(/^(re|fwd?|fw)\s*:\s*/i, '');
    if (!s) return '(no subject)';
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    return cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : max).replace(/[\s,.:;-]+$/, '') + '…';
  }
  // "Dr. Lee" keeps the title; otherwise the first name; else the address's local part.
  function callName(addr) {
    const name = String((addr && addr.name) || '').replace(/["']/g, '').trim();
    if (name) {
      const titled = name.match(/^(dr|mr|mrs|ms|mx|prof)\.?\s+(.+)$/i);
      if (titled) return `${titled[1][0].toUpperCase()}${titled[1].slice(1).toLowerCase()}. ${titled[2].split(/\s+/).pop()}`;
      const first = name.split(/[\s,]+/)[0];
      return first.includes('@') ? first.split('@')[0] : first;
    }
    const local = emailOf(addr).split('@')[0] || 'there';
    return local.charAt(0).toUpperCase() + local.slice(1);
  }
  function senderLabel(addr) { return String((addr && addr.name) || '').trim() || emailOf(addr) || 'Unknown sender'; }
  function initials(addr) {
    const words = senderLabel(addr).replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    return ((words[0] || '?')[0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }

  const realMessages = thread => (thread.messages || []).filter(m => !(m.labelIds || []).includes('DRAFT')).slice().sort((a, b) => a.date - b.date);
  function threadLabels(thread) { const set = new Set(); for (const m of thread.messages || []) for (const id of m.labelIds || []) set.add(id); return set; }
  // A Done or Removed mark counts only while the newest message from someone else carries it, so new mail after the mark reopens the thread.
  function markHolds(thread, labelId, me) {
    if (!labelId) return false;
    const msgs = realMessages(thread);
    const others = msgs.filter(m => !isMe(m.from, me));
    const ref = others.length ? others[others.length - 1] : msgs[msgs.length - 1];
    return !!ref && (ref.labelIds || []).includes(labelId);
  }

  function topicOf(subject, text, senderName) {
    const s = lower(subject);
    for (const [name, re] of TOPIC_RULES) if (re.test(s)) return name;
    const all = `${s} ${lower(text)} ${lower(senderName)}`;
    for (const [name, re] of TOPIC_RULES) if (re.test(all)) return name;
    return 'Other';
  }
  function billerName(addr) {
    return senderLabel(addr).replace(/\b(billing|bills?|payments?|customer service|no-?reply|notifications?|team|accounts?)\b/gi, '').replace(/[-–|:,]+$/, '').trim() || senderLabel(addr);
  }

  // Classify one thread. ctx: {me: his address, now: ms, labels: {todo, done, removed} label ids}.
  function classify(thread, ctx) {
    const me = ctx.me || '';
    const now = ctx.now || Date.now();
    const labels = ctx.labels || {};
    const msgs = realMessages(thread);
    const latest = msgs[msgs.length - 1] || { from: {}, to: [], cc: [], labelIds: [], date: now, subject: '', snippet: '' };
    const others = msgs.filter(m => !isMe(m.from, me));
    const lastOther = others[others.length - 1] || null;
    const all = threadLabels(thread);
    const subject = (msgs.find(m => m.subject) || latest).subject || '';
    const fromMeLast = isMe(latest.from, me);
    const ref = lastOther || latest;
    const text = `${subject}\n${ref.snippet || ''}\n${ref.body || ''}`;
    const t = lower(stripUrls(text));
    const person = !!lastOther && isPersonMessage(lastOther);
    const direct = !!lastOther && (lastOther.to || []).some(a => isMe(a, me));
    const due = lastOther ? findDue(text, lastOther.date) : null;
    const topic = topicOf(subject, `${ref.snippet || ''} ${ref.body || ''}`, senderLabel(ref.from));
    const asks = ASK.test(t) || /\?/.test(stripUrls(`${ref.snippet || ''} ${ref.body || ''}`));
    const confirm = CONFIRM.test(t);
    const rsvp = RSVP.test(t);
    const todoLabel = !!labels.todo && all.has(labels.todo);
    const done = markHolds(thread, labels.done, me);
    const removed = markHolds(thread, labels.removed, me);
    const reasons = [];
    const name = lastOther ? callName(lastOther.from) : '';
    const subj = shortSubject(subject);

    let list = 'fyi';
    let action = '';
    let needsReply = false;

    if (fromMeLast) {
      const recipients = [...(latest.to || []), ...(latest.cc || [])].filter(a => !isMe(a, me));
      if (recipients.length && now - latest.date >= WAITING_DAYS * DAY) {
        list = 'waitingOn';
        action = `Follow up with ${callName(recipients[0])}: ${subj}`;
        reasons.push(`You sent the last message ${Math.floor((now - latest.date) / DAY)} days ago and nobody has answered.`);
      } else {
        reasons.push('You sent the last message recently.');
      }
    } else if (lastOther) {
      const bill = (MONEY.test(t) || (BILL_WORD.test(t) && due)) && !PAID.test(t) && (due || /\b(?:due|pay|overdue|past due)\b/.test(t));
      const replyAsk = person && direct && (asks || confirm);
      if (bill) {
        list = 'todo';
        action = `Pay ${billerName(lastOther.from)} bill`;
        reasons.push('A bill with an amount or due date that is not marked paid.');
      } else if (rsvp && (direct || !person)) {
        list = 'todo';
        action = `RSVP: ${subj}`;
        reasons.push('An invitation that asks for an answer.');
      } else if (confirm && (direct || !person)) {
        list = 'todo';
        const day = findDayWord(`${ref.snippet || ''} ${ref.body || ''}`) || findDayWord(subject);
        action = person ? `Reply to ${name}: confirm${day ? ' ' + day : ''}` : `Confirm: ${subj}`;
        needsReply = person && direct;
        reasons.push('The sender asks you to confirm.');
      } else if (replyAsk && due) {
        list = 'todo';
        action = `Reply to ${name}: ${subj}`;
        needsReply = true;
        reasons.push('A person asks you directly and gives a date.');
      } else if (replyAsk) {
        list = 'needsReply';
        action = `Reply to ${name}: ${subj}`;
        needsReply = true;
        reasons.push('A person wrote to you directly with a question.');
      } else if (all.has('STARRED')) {
        list = 'todo';
        action = `Follow up: ${subj}`;
        reasons.push('You starred this thread.');
      } else if (topic !== 'Other') {
        list = 'topic';
        reasons.push(`Grouped under ${topic}.`);
      } else {
        reasons.push(person ? 'From a person, with no question for you.' : 'Automated or list mail.');
      }
    }
    if (todoLabel && list !== 'todo') {
      list = 'todo';
      action = action || `Follow up: ${subj}`;
      reasons.unshift('You added this to your to-dos.');
    }
    if (removed && (list === 'todo' || list === 'needsReply') && !todoLabel) {
      list = topic !== 'Other' ? 'topic' : 'fyi';
      needsReply = false;
      reasons.unshift('You removed this from your to-dos.');
    }
    if (!action) action = subj;
    return {
      id: thread.id,
      list,
      action,
      due: list === 'todo' || list === 'needsReply' ? due : null,
      topic,
      needsReply,
      done,
      removed,
      todoLabel,
      inInbox: all.has('INBOX'),
      unread: all.has('UNREAD'),
      important: all.has('IMPORTANT'),
      starred: all.has('STARRED'),
      person,
      from: senderLabel(ref.from),
      fromAddress: emailOf(ref.from),
      initials: initials(ref.from),
      subject: subject || '(no subject)',
      snippet: ref.snippet || '',
      date: latest.date,
      count: msgs.length,
      reasons
    };
  }

  // Rules that would decide differently with the full text: worth one plain-text body fetch.
  function needsBody(thread, ctx) {
    const msgs = realMessages(thread);
    const others = msgs.filter(m => !isMe(m.from, ctx.me));
    const last = others[others.length - 1];
    if (!last || last.body != null || msgs[msgs.length - 1] !== last) return false;
    const snippet = lower(last.snippet);
    const truncated = snippet.length >= 140;
    if (!truncated) return false;
    const direct = (last.to || []).some(a => isMe(a, ctx.me));
    if (isPersonMessage(last) && direct && !ASK.test(snippet) && !snippet.includes('?')) return true;
    return (MONEY.test(snippet) || BILL_WORD.test(snippet)) && !findDue(snippet, last.date);
  }

  function compareItems(a, b) {
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (!!a.due !== !!b.due) return a.due ? -1 : 1;
    if (a.important !== b.important) return a.important ? -1 : 1;
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    return b.date - a.date;
  }
  function sortThreads(threads, ctx) { return threads.map(t => classify(t, ctx)).sort(compareItems); }

  // Topic cards: open topic mail in the inbox, grouped in fixed order, each with a count and its newest line.
  function groupTopics(items) {
    const groups = [];
    for (const topic of TOPICS) {
      const members = items.filter(i => i.list === 'topic' && i.topic === topic && !i.done && i.inInbox).sort((a, b) => b.date - a.date);
      if (members.length) groups.push({ topic, count: members.length, unread: members.filter(m => m.unread).length, latest: members[0], items: members });
    }
    return groups;
  }

  return { LISTS, TOPICS, WAITING_DAYS, classify, sortThreads, groupTopics, needsBody, compareItems, findDue, resolveDate, localDay, shortSubject, callName, senderLabel, initials, isPersonMessage, markHolds };
});
