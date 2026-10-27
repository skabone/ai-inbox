// AI Inbox edits: his own title, due date, list and note per thread, the category label AI Inbox set, and the categories he hid.
// One JSON file in his Google Drive app-data folder (only this app can see it), so the Mac and the phone agree. If Drive is not
// allowed or fails, the same document stays in this browser's localStorage and the page says so once. The file is never deleted.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIInboxEdits = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FILE_NAME = 'ai-inbox-edits.json';
  const LOCAL_KEY = 'ai-inbox-edits-v1';
  const FILES = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const LISTS = ['todo', 'needsReply', 'waitingOn', 'fyi'];
  const BOUNDARY = 'ai-inbox-edits-part';

  function emptyDoc() { return { version: 1, threads: {}, hidden: {} }; }

  // Keeps only known fields of the right shape, so a damaged file cannot break the page.
  function cleanRecord(r) {
    if (!r || typeof r !== 'object') return null;
    const out = { at: Number(r.at) || 0 };
    if (typeof r.title === 'string' && r.title.trim()) out.title = r.title.trim().slice(0, 200);
    if (typeof r.due === 'string' && (r.due === '' || /^\d{4}-\d{2}-\d{2}$/.test(r.due))) out.due = r.due;
    if (LISTS.includes(r.list)) out.list = r.list;
    if (typeof r.note === 'string' && r.note.trim()) out.note = r.note.trim().slice(0, 1000);
    if (typeof r.category === 'string' && r.category) out.category = r.category;
    return out;
  }
  function cleanDoc(d) {
    const out = emptyDoc();
    if (!d || typeof d !== 'object') return out;
    for (const [id, r] of Object.entries(d.threads || {})) { const c = cleanRecord(r); if (c) out.threads[id] = c; }
    for (const [id, h] of Object.entries(d.hidden || {})) if (h && typeof h === 'object') out.hidden[id] = { hidden: !!h.hidden, at: Number(h.at) || 0 };
    return out;
  }
  // Per thread and per category the newer change wins (at = when it was made). A reset is an entry with no fields, so it wins too.
  function mergeDocs(a, b) {
    const x = cleanDoc(a), y = cleanDoc(b), out = emptyDoc();
    for (const key of ['threads', 'hidden']) {
      for (const id of new Set([...Object.keys(x[key]), ...Object.keys(y[key])])) {
        const p = x[key][id], q = y[key][id];
        out[key][id] = !p ? q : !q ? p : (q.at >= p.at ? q : p);
      }
    }
    return out;
  }
  const hasFields = r => !!r && ['title', 'due', 'list', 'note', 'category'].some(k => r[k] != null);

  class DriveError extends Error { constructor(message) { super(message); this.name = 'DriveError'; } }

  // Drive v3 over fetch: find the file by name in appDataFolder, read it, create it once, then update it in place. No delete call exists here.
  function createDriveFile({ getToken, fetchFn, onAuthLost, AuthError }) {
    async function call(method, url, body, contentType) {
      const token = getToken();
      let res;
      try {
        res = await fetchFn(url, { method, headers: Object.assign({ Authorization: `Bearer ${token}` }, contentType ? { 'Content-Type': contentType } : {}), body });
      } catch (e) { throw new DriveError(`Google Drive could not be reached (${e.message})`); }
      if (res.status === 401) { if (onAuthLost) onAuthLost(); throw new AuthError('Google sign-in expired'); }
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error.message; } catch (e) { detail = res.statusText; }
        throw new DriveError(`Google Drive ${res.status}: ${detail}`);
      }
      return res.json().catch(() => null);
    }
    const q = encodeURIComponent;
    return {
      async find() {
        const res = await call('GET', `${FILES}?spaces=appDataFolder&q=${q(`name = '${FILE_NAME}' and trashed = false`)}&orderBy=${q('modifiedTime desc')}&fields=${q('files(id,modifiedTime)')}&pageSize=10`);
        return ((res && res.files) || [])[0] ? res.files[0].id : '';
      },
      async read(id) { return cleanDoc(await call('GET', `${FILES}/${q(id)}?alt=media`)); },
      async create(doc) {
        const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
        const body = `--${BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(doc)}\r\n--${BOUNDARY}--`;
        const res = await call('POST', `${UPLOAD}?uploadType=multipart&fields=id`, body, `multipart/related; boundary=${BOUNDARY}`);
        if (!res || !res.id) throw new DriveError('Google Drive did not return the new file');
        return res.id;
      },
      async update(id, doc) { await call('PATCH', `${UPLOAD}/${q(id)}?uploadType=media&fields=id`, JSON.stringify(doc), 'application/json'); }
    };
  }

  // The on-device copy (localStorage), used when Drive is not allowed or fails. storage is window.localStorage or a stand-in.
  function createLocalFile(storage) {
    return {
      read() { try { const raw = storage.getItem(LOCAL_KEY); return raw ? cleanDoc(JSON.parse(raw)) : null; } catch (e) { return null; } },
      write(doc) { try { storage.setItem(LOCAL_KEY, JSON.stringify(doc)); return true; } catch (e) { return false; } },
      clear() { try { storage.removeItem(LOCAL_KEY); } catch (e) { /* storage blocked: nothing kept */ } }
    };
  }

  // The store the page uses. mode: 'drive', 'device' (localStorage) or 'memory' (demo, or storage blocked).
  // onNotice(text) is called once when edits fall back to this device.
  function createEditsStore({ drive, local, onNotice, now }) {
    const clock = now || (() => Date.now());
    let doc = emptyDoc();
    let fileId = '';
    let mode = drive ? 'drive' : local ? 'device' : 'memory';
    let told = false;
    let carryLocal = false;
    let chain = Promise.resolve();
    function toDevice(reason) {
      mode = local ? 'device' : 'memory';
      if (local) { doc = mergeDocs(local.read(), doc); if (!local.write(doc)) mode = 'memory'; }
      if (!told && onNotice) { told = true; onNotice(reason); }
    }
    const isAuth = e => e && e.name === 'AuthError';

    async function write() {
      if (mode === 'drive') {
        try {
          if (!fileId) fileId = await drive.find();
          if (fileId) { doc = mergeDocs(await drive.read(fileId), doc); await drive.update(fileId, doc); }
          else fileId = await drive.create(doc);
          if (carryLocal) { carryLocal = false; local.clear(); }
          return mode;
        } catch (e) {
          if (isAuth(e)) throw e;
          toDevice(`Your edits are kept on this device only: ${e.message}.`);
        }
      }
      if (mode === 'device' && !local.write(doc)) mode = 'memory';
      return mode;
    }

    return {
      get mode() { return mode; },
      get doc() { return doc; },
      // Reads his edits and merges them with any made on this page since; call before the first render.
      async load() {
        if (mode === 'drive') {
          try {
            fileId = await drive.find();
            doc = mergeDocs(fileId ? await drive.read(fileId) : emptyDoc(), doc);
            const kept = local && local.read();
            if (kept && Object.keys(kept.threads).length + Object.keys(kept.hidden).length) { doc = mergeDocs(kept, doc); carryLocal = true; }
            return mode;
          } catch (e) {
            if (isAuth(e)) throw e;
            toDevice(`Your edits are kept on this device only: ${e.message}.`);
          }
        }
        if (mode === 'device') doc = mergeDocs(local.read(), doc);
        return mode;
      },
      get(threadId) { return doc.threads[threadId] || null; },
      // Replaces one thread's record (fields title, due, list, note, category); an empty record is a reset. persist() saves it.
      put(threadId, record) { doc.threads[threadId] = cleanRecord(Object.assign({}, record, { at: clock() })); },
      hidden() { return Object.keys(doc.hidden).filter(id => doc.hidden[id].hidden); },
      setHidden(labelId, hidden) { doc.hidden[labelId] = { hidden: !!hidden, at: clock() }; },
      // Saves in order, one write at a time; Drive gets the merged file (his other device's newer changes are kept).
      persist() { const p = chain.then(write); chain = p.catch(() => {}); return p; },
      // Uses this device from now on (Drive permission refused at sign-in).
      useDevice(reason) { if (mode === 'drive') toDevice(reason); else if (!told && onNotice && reason) { told = true; onNotice(reason); } }
    };
  }

  return { FILE_NAME, LOCAL_KEY, FILES, UPLOAD, emptyDoc, cleanRecord, cleanDoc, mergeDocs, hasFields, DriveError, createDriveFile, createLocalFile, createEditsStore };
});
