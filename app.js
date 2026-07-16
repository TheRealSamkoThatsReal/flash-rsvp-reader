/* Flash — RSVP speed reader
 * Vanilla JS, no dependencies. State machine: input view <-> reader view.
 */
(() => {
  'use strict';

  const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches
    || ('ontouchstart' in window);

  // ---------- element refs ----------
  const $ = (id) => document.getElementById(id);
  const inputView   = $('input-view');
  const readerView  = $('reader-view');
  const bookView    = $('book-view');
  const chapterList = $('chapter-list');
  const bookTitle   = $('book-title');
  const textInput   = $('text-input');
  const linkInput   = $('link-input');
  const linkStatus  = $('link-status');
  const startBtn    = $('start-btn');
  const wordDisplay = $('word-display');
  const wPre  = wordDisplay.querySelector('.word-pre');
  const wOrp  = wordDisplay.querySelector('.word-orp');
  const wPost = wordDisplay.querySelector('.word-post');
  const contextStrip = $('context-strip');
  const seek     = $('seek');
  const posLabel = $('pos-label');
  const timeLabel= $('time-label');
  const playBtn  = $('play-btn');
  const wpmRange = $('wpm');
  const wpmOut   = $('wpm-out');

  // ---------- state ----------
  const state = {
    tokens: [],       // [{word, delay}]  delay is a multiplier
    index: 0,
    wpm: 350,
    playing: false,
    timer: null,
    activeTab: 'text',
    book: null,       // { title, chapters:[{title,text}], index } when reading an ebook
    replayUntil: null, // when set, playback pauses at this token (sentence replay)
    pauseStrength: 1,  // multiplier on punctuation pauses (0–2.5)
    autoSlow: true,    // ease off for a few words after a long/complex word
    peek: true,        // expand to the full sentence when paused
    slow: 1,           // live auto-slow multiplier (decays back to 1)
  };

  // Persisted preferences
  try {
    const saved = JSON.parse(localStorage.getItem('flash-prefs') || '{}');
    if (saved.wpm) state.wpm = saved.wpm;
    if (saved.text) textInput.value = saved.text;
    if (typeof saved.pauseStrength === 'number') state.pauseStrength = saved.pauseStrength;
    if (typeof saved.autoSlow === 'boolean') state.autoSlow = saved.autoSlow;
    if (typeof saved.peek === 'boolean') state.peek = saved.peek;
  } catch (_) {}
  wpmRange.value = state.wpm;
  wpmOut.textContent = state.wpm + ' wpm';
  $('wpm-val').textContent = state.wpm + ' wpm';

  const savePrefs = () => {
    try {
      localStorage.setItem('flash-prefs', JSON.stringify({
        wpm: state.wpm, text: textInput.value.slice(0, 200000),
        pauseStrength: state.pauseStrength, autoSlow: state.autoSlow, peek: state.peek,
      }));
    } catch (_) {}
  };

  // ---------- tokenizer ----------
  // Split into words, attaching a per-word timing multiplier so long words and
  // sentence boundaries linger a little longer (classic RSVP pacing).
  function tokenize(raw) {
    const words = raw.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    return words.map((word) => {
      const len = word.length;
      const lenExtra = len > 6 ? Math.min((len - 6) * 0.06, 0.6) : 0;   // long words
      let numExtra = 0;
      if (/\d/.test(word)) {                                            // numbers
        const digits = (word.match(/\d/g) || []).length;
        numExtra = 0.9 + Math.min(digits * 0.2, 1.6);
      }
      let punctExtra = 0;                                               // pause at punctuation
      if (/[,;:]$/.test(word))        punctExtra += 0.4;                // mid-clause
      if (/[.!?…"”)]$/.test(word))    punctExtra += 0.9;                // end of sentence
      if (/[.!?…]["”)]?$/.test(word)) punctExtra += 0.2;
      const letters = word.replace(/[^A-Za-z]/g, '').length;
      return { word, lenExtra, numExtra, punctExtra, complex: letters >= 12 };
    });
  }

  // Effective per-word dwell multiplier, using live settings + auto-slow state.
  function tokenDelay(tok) {
    let d = 1 + tok.lenExtra + tok.numExtra + state.pauseStrength * tok.punctExtra;
    if (state.autoSlow) d *= state.slow;
    return d;
  }

  // ---------- ORP (optimal recognition point) ----------
  // The pivot letter, highlighted and pinned to the horizontal centre.
  function orpIndex(word) {
    const clean = word.replace(/[^\w'’-]/g, ''); // ignore surrounding punctuation for length
    const n = clean.length || word.length;
    if (n <= 1) return 0;
    if (n <= 5) return 1;
    if (n <= 9) return 2;
    if (n <= 13) return 3;
    return 4;
  }

  function renderWord(word) {
    const i = orpIndex(word);
    wPre.textContent  = word.slice(0, i);
    wOrp.textContent  = word.slice(i, i + 1);
    wPost.textContent = word.slice(i + 1);
  }

  // ---------- reader loop ----------
  function baseDelayMs() { return 60000 / state.wpm; }

  function showCurrent() {
    const tok = state.tokens[state.index];
    if (!tok) return;
    renderWord(tok.word);
    updateProgress();
    updateContext();
    saveProgress(false);          // throttled autosave while reading
  }

  // state.index always points at the word currently on screen.
  function scheduleNext() {
    const tok = state.tokens[state.index];
    const ms = baseDelayMs() * tokenDelay(tok);
    // A complex word boosts the slowdown for the words that follow; otherwise
    // the boost decays back toward normal speed over a few words.
    if (state.autoSlow && tok.complex) state.slow = Math.max(state.slow, 1.6);
    else { state.slow = 1 + (state.slow - 1) * 0.5; if (state.slow < 1.02) state.slow = 1; }
    state.timer = setTimeout(() => {
      if (!state.playing) return;
      // Sentence-replay: stop once the replayed sentence has been shown.
      if (state.replayUntil != null && state.index >= state.replayUntil) {
        state.replayUntil = null;
        pause();
        return;
      }
      if (state.index + 1 >= state.tokens.length) { finish(); return; }
      state.index++;
      showCurrent();
      scheduleNext();
    }, ms);
  }

  function play() {
    if (state.index >= state.tokens.length - 1) state.index = 0;
    state.playing = true;
    playBtn.textContent = '❙❙';
    playBtn.classList.add('playing');
    showCurrent();
    scheduleNext();
  }

  function pause() {
    state.playing = false;
    clearTimeout(state.timer);
    playBtn.textContent = '▶︎';
    playBtn.classList.remove('playing');
    saveProgress(false);
    updateContext();               // reveal the sentence peek now that we're paused
  }

  function togglePlay() { state.playing ? pause() : play(); }

  function finish() {
    pause();
    state.index = state.tokens.length;
    updateProgress();
    saveProgress(true);
    contextStrip.classList.remove('peek');
    // In a book with more chapters, roll on to the next one automatically.
    if (state.book && state.book.index < state.book.chapters.length - 1) {
      wPre.textContent = ''; wOrp.textContent = '›'; wPost.textContent = '';
      contextStrip.innerHTML = '<span class="cur">Next chapter…</span>';
      setTimeout(() => { if (state.book) openChapter(state.book.index + 1, true); }, 900);
      return;
    }
    wPre.textContent = ''; wOrp.textContent = '✓'; wPost.textContent = '';
    contextStrip.innerHTML = '<span class="cur">Done.</span>';
  }

  function seekTo(idx) {
    idx = Math.max(0, Math.min(idx, state.tokens.length - 1));
    state.replayUntil = null;      // any manual seek cancels a pending replay
    state.index = idx;
    showCurrent();
  }

  function nudge(delta) {
    const wasPlaying = state.playing;
    pause();
    seekTo(state.index + delta);
    if (wasPlaying) play();
  }

  // ---------- sentence replay (regression) ----------
  function endsSentence(tok) { return /[.!?…]["”)]?$/.test(tok.word); }

  function sentenceStart(i) {
    for (let j = Math.min(i, state.tokens.length - 1) - 1; j >= 0; j--) {
      if (endsSentence(state.tokens[j])) return j + 1;
    }
    return 0;
  }

  function sentenceEnd(from) {
    for (let j = from; j < state.tokens.length; j++) if (endsSentence(state.tokens[j])) return j;
    return state.tokens.length - 1;
  }

  // Jump back to the start of the current sentence (or the previous one if we're
  // already at the start) and replay just that sentence, then pause.
  function regress() {
    if (!state.tokens.length) return;
    let start = sentenceStart(state.index);
    if (state.index - start <= 1) start = sentenceStart(start - 1);
    start = Math.max(0, start);
    seekTo(start);
    state.replayUntil = sentenceEnd(start);
    play();
  }

  // ---------- progress + context ----------
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function updateProgress() {
    const total = state.tokens.length;
    const cur = Math.min(state.index, total);
    posLabel.textContent = cur + ' / ' + total;
    seek.value = total ? (cur / total) * 100 : 0;
    const remaining = total - cur;
    timeLabel.textContent = fmtTime((remaining * baseDelayMs()) / 1000) + ' left';
    updateLoc();
  }

  // Kindle-style location readout (~128 chars per location), book-wide.
  function updateLoc() {
    const el = $('loc-val');
    if (!state.book || !state.book.charOffsets) { el.classList.add('hidden'); return; }
    const inChapter = state.charStarts ? (state.charStarts[Math.min(state.index, state.charStarts.length - 1)] || 0) : 0;
    const offset = (state.book.charOffsets[state.book.index] || 0) + inChapter;
    const loc = Math.floor(offset / 128) + 1;
    const total = Math.max(loc, Math.floor((state.book.totalChars || 0) / 128));
    el.textContent = 'loc ' + loc.toLocaleString() + ' / ' + total.toLocaleString();
    el.classList.remove('hidden');
  }

  // Keep the strip blank while reading (no distraction); show the sentence
  // peek only when paused (if enabled).
  function updateContext() {
    if (state.playing || !state.peek) {
      contextStrip.classList.remove('peek');
      contextStrip.textContent = '';
      return;
    }
    showPeek();
  }

  // On pause, expand the strip to the whole current sentence to re-anchor.
  function showPeek() {
    const n = state.tokens.length;
    if (!n) return;
    const i = Math.min(state.index, n - 1);
    const s = sentenceStart(i), e = sentenceEnd(i);
    let html = '';
    for (let j = s; j <= e; j++) {
      const w = state.tokens[j].word;
      html += j === i ? `<span class="cur">${escapeHtml(w)}</span> ` : escapeHtml(w) + ' ';
    }
    contextStrip.classList.add('peek');
    contextStrip.innerHTML = html;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ---------- view switching ----------
  function openReader(text, opts = {}) {
    if (!opts.fromBook) state.book = null;
    state.tokens = tokenize(text);
    if (!state.tokens.length) {
      if (!opts.fromBook) flashLinkStatus('Nothing to read — the text was empty.', 'err');
      return false;
    }
    // Prefix character offset of each token, for the ebook location readout.
    let acc = 0;
    state.charStarts = state.tokens.map((t) => { const s = acc; acc += t.word.length + 1; return s; });
    state.replayUntil = null;
    state.slow = 1;
    state.index = Math.max(0, Math.min(opts.startIndex || 0, state.tokens.length - 1));
    inputView.classList.add('hidden');
    bookView.classList.add('hidden');
    readerView.classList.remove('hidden');
    showCurrent();
    // Desktop autostarts; on touch the reader waits for a hold-to-play press.
    const autostart = opts.autostart !== undefined ? opts.autostart : !isTouch;
    if (autostart) setTimeout(play, 500);
    return true;
  }

  function closeReader() {
    pause();
    saveProgress(true);
    readerView.classList.add('hidden');
    if (state.book) bookView.classList.remove('hidden');   // back to chapter list
    else inputView.classList.remove('hidden');
  }

  // ---------- link fetching (reader proxy) ----------
  function flashLinkStatus(msg, kind) {
    linkStatus.textContent = msg;
    linkStatus.className = 'link-status ' + (kind || '');
    linkStatus.classList.remove('hidden');
  }

  async function fetchArticle(url) {
    // r.jina.ai returns clean, readable text/markdown for a URL and sends CORS
    // headers, so it works from a static client-side app.
    const proxied = 'https://r.jina.ai/' + url;
    const res = await fetch(proxied, { headers: { 'Accept': 'text/plain' } });
    if (!res.ok) throw new Error('Reader returned ' + res.status);
    let text = await res.text();
    // Strip the leading "Title:/URL Source:/Markdown Content:" preamble jina adds.
    const marker = text.indexOf('Markdown Content:');
    if (marker !== -1) text = text.slice(marker + 'Markdown Content:'.length);
    // Light markdown cleanup so symbols don't get read as words.
    text = text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')      // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')    // links -> label
      .replace(/^#{1,6}\s+/gm, '')                // headings
      .replace(/[*_`>#]+/g, ' ')                  // stray md symbols
      .replace(/\n{2,}/g, '. ')                   // paragraph breaks -> sentence stop
      .replace(/\s+/g, ' ')
      .trim();
    return text;
  }

  // ---------- ebook (EPUB / txt) ----------
  const td = new TextDecoder();

  function flashFileStatus(msg, kind) {
    const el = $('file-status');
    el.textContent = msg;
    el.className = 'link-status ' + (kind || '');
    el.classList.remove('hidden');
  }

  // Minimal ZIP reader built on the browser's DecompressionStream (no deps).
  async function readZip(buf) {
    const dv = new DataView(buf);
    const len = buf.byteLength;
    let eocd = -1;
    const back = Math.min(len, 22 + 65535);
    for (let i = len - 22; i >= len - back; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a valid EPUB (no ZIP directory)');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = td.decode(new Uint8Array(buf, p + 46, nameLen));
      entries.set(name, { method, compSize, local });
      p += 46 + nameLen + extraLen + commentLen;
    }
    async function read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lnameLen = dv.getUint16(e.local + 26, true);
      const lextraLen = dv.getUint16(e.local + 28, true);
      const start = e.local + 30 + lnameLen + lextraLen;
      const comp = new Uint8Array(buf, start, e.compSize);
      if (e.method === 0) return comp;                     // stored
      const ds = new DecompressionStream('deflate-raw');   // deflate
      const ab = await new Response(new Blob([comp]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(ab);
    }
    return { read };
  }

  function resolvePath(baseDir, rel) {
    const stack = baseDir.split('/').filter(Boolean);
    for (const part of rel.split('/')) {
      if (part === '..') stack.pop();
      else if (part && part !== '.') stack.push(part);
    }
    return stack.join('/');
  }

  function htmlToText(bytes) {
    const doc = new DOMParser().parseFromString(td.decode(bytes), 'text/html');
    doc.querySelectorAll('script,style').forEach((n) => n.remove());
    const h = doc.querySelector('h1,h2,h3,title');
    const title = h ? h.textContent.replace(/\s+/g, ' ').trim() : '';
    // Guarantee whitespace between block elements before flattening.
    doc.querySelectorAll('p,div,br,li,tr,section,article,blockquote,h1,h2,h3,h4,h5,h6')
      .forEach((el) => el.appendChild(doc.createTextNode(' ')));
    const body = doc.body || doc.documentElement;
    const text = (body ? body.textContent : '').replace(/\s+/g, ' ').trim();
    return { title, text };
  }

  async function parseEpub(buf) {
    const zip = await readZip(buf);
    const containerBytes = await zip.read('META-INF/container.xml');
    if (!containerBytes) throw new Error('missing container.xml');
    const cdoc = new DOMParser().parseFromString(td.decode(containerBytes), 'application/xml');
    const rootfile = cdoc.getElementsByTagNameNS('*', 'rootfile')[0];
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath) throw new Error('missing package path');
    const opf = new DOMParser().parseFromString(td.decode(await zip.read(opfPath)), 'application/xml');
    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

    const manifest = {};
    for (const it of opf.getElementsByTagNameNS('*', 'item')) {
      manifest[it.getAttribute('id')] = it.getAttribute('href');
    }
    const titleEl = opf.getElementsByTagNameNS('*', 'title')[0];
    const bookTitleText = (titleEl && titleEl.textContent.trim()) || 'Untitled';

    const chapters = [];
    for (const ir of opf.getElementsByTagNameNS('*', 'itemref')) {
      const href = manifest[ir.getAttribute('idref')];
      if (!href) continue;
      const path = resolvePath(baseDir, href.split('#')[0]);
      const bytes = await zip.read(path);
      if (!bytes) continue;
      const { title, text } = htmlToText(bytes);
      if (text.length < 1) continue;
      chapters.push({ title: title || ('Section ' + (chapters.length + 1)), text });
    }
    if (!chapters.length) throw new Error('no readable chapters found');
    return { title: bookTitleText, chapters, index: 0 };
  }

  // Kindle "My Clippings.txt": highlights/notes grouped by book, separated by
  // a line of "=". Turn it into a book with one chapter per source title.
  function looksLikeClippings(t) {
    return /^={5,}\s*$/m.test(t) && /(Your Highlight|Your Note|Your Bookmark|Location \d)/.test(t);
  }

  function parseClippings(text) {
    const t = text.replace(/\r\n/g, '\n').replace(/\uFEFF/g, '');
    const byBook = new Map();
    for (const raw of t.split(/^=+\s*$/m)) {
      const block = raw.trim();
      const nl = block.indexOf('\n');
      if (nl < 0) continue;
      const title = block.slice(0, nl).trim();
      const rest = block.slice(nl + 1);
      const blank = rest.indexOf('\n\n');
      const content = (blank >= 0 ? rest.slice(blank + 2) : '').replace(/\s+/g, ' ').trim();
      if (!title || !content) continue;                 // skip bookmarks / empties
      if (!byBook.has(title)) byBook.set(title, []);
      byBook.get(title).push(content);
    }
    // Each highlight ends with a stop so there's a natural pause between them.
    return [...byBook.entries()].map(([title, hs]) => ({
      title,
      text: hs.map((h) => (/[.!?…]$/.test(h) ? h : h + '.')).join('  '),
    }));
  }

  async function handleFile(file) {
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    try {
      if (name.endsWith('.txt') || file.type === 'text/plain') {
        const text = await file.text();
        if (!text.trim()) throw new Error('file is empty');
        if (looksLikeClippings(text)) {
          const chapters = parseClippings(text);
          if (chapters.length) { openBook({ title: 'Kindle Highlights', chapters, index: 0 }); return; }
        }
        openReader(text);
        return;
      }
      flashFileStatus('Parsing “' + (file.name || 'ebook') + '” …', 'busy');
      const book = await parseEpub(await file.arrayBuffer());
      $('file-status').classList.add('hidden');
      openBook(book);
    } catch (err) {
      flashFileStatus('Could not read file: ' + err.message, 'err');
    }
  }

  function computeOffsets(book) {
    let acc = 0;
    book.charOffsets = book.chapters.map((ch) => { const s = acc; acc += ch.text.length + 1; return s; });
    book.totalChars = acc;
  }

  function populateBook(book) {
    computeOffsets(book);
    book.id = book.id || bookId(book);
    saveContent(book);          // persist text once for cross-session resume
    state.book = book;
    bookTitle.textContent = book.title;
    chapterList.innerHTML = '';
    book.chapters.forEach((ch, i) => {
      const words = ch.text.split(/\s+/).filter(Boolean).length;
      const btn = document.createElement('button');
      btn.className = 'chapter-item' + (i === book.index ? ' current' : '');
      btn.innerHTML = '<span class="cnum"></span><span class="ctitle"></span><span class="cwords"></span>';
      btn.querySelector('.cnum').textContent = i + 1;
      btn.querySelector('.ctitle').textContent = ch.title;
      btn.querySelector('.cwords').textContent = words.toLocaleString() + ' w';
      btn.addEventListener('click', () => openChapter(i));
      chapterList.appendChild(btn);
    });
  }

  function openBook(book) {
    populateBook(book);
    inputView.classList.add('hidden');
    readerView.classList.add('hidden');
    bookView.classList.remove('hidden');
  }

  function openChapter(i, autostart, startWord) {
    const b = state.book;
    if (!b || !b.chapters[i]) return;
    b.index = i;
    openReader(b.chapters[i].text, { fromBook: true, autostart, startIndex: startWord || 0 });
    saveProgress(true);
  }

  // ---------- reading progress + library (IndexedDB) ----------
  // Two stores: 'content' (book text, written once) and 'progress' (tiny
  // position record, written often) — so autosave never rewrites a whole book.
  const DB_NAME = 'flash', C_STORE = 'content', P_STORE = 'progress';
  let dbPromise = null, lastSave = 0;

  function idb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('no IndexedDB')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(C_STORE)) db.createObjectStore(C_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(P_STORE)) db.createObjectStore(P_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function idbPut(store, rec) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(rec);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  }
  async function idbGet(store, id) {
    const db = await idb();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readonly').objectStore(store).get(id);
      r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
    });
  }
  async function idbGetAll(store) {
    const db = await idb();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
    });
  }
  async function idbDelete(store, id) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(id);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  }

  function bookId(book) {
    const key = (book.title || '') + '|' + book.chapters.length + '|' + (book.totalChars || 0);
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return 'b' + (h >>> 0).toString(36);
  }

  // Store the book text once (idempotent) so resume works across sessions.
  function saveContent(book) {
    idbPut(C_STORE, { id: book.id, title: book.title, chapters: book.chapters, totalChars: book.totalChars })
      .catch(() => {});
  }

  async function saveProgress(force) {
    const b = state.book;
    if (!b || !b.id || !b.charOffsets) return;
    const now = Date.now();
    if (!force && now - lastSave < 3000) return;   // throttle autosaves
    lastSave = now;
    const inChapter = state.charStarts ? (state.charStarts[Math.min(state.index, state.charStarts.length - 1)] || 0) : 0;
    const offset = (b.charOffsets[b.index] || 0) + inChapter;
    try {
      await idbPut(P_STORE, {
        id: b.id, title: b.title, chapterIndex: b.index, wordIndex: state.index,
        offset, totalChars: b.totalChars, updatedAt: now,
      });
      await pruneLibrary();
    } catch (_) {}
  }

  async function pruneLibrary() {
    try {
      const all = await idbGetAll(P_STORE);
      if (all.length <= 20) return;
      all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const rec of all.slice(20)) { await idbDelete(P_STORE, rec.id); await idbDelete(C_STORE, rec.id); }
    } catch (_) {}
  }

  async function renderLibrary() {
    const wrap = $('library');
    let all;
    try { all = await idbGetAll(P_STORE); } catch (_) { wrap.classList.add('hidden'); return; }
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    wrap.innerHTML = '';
    if (!all.length) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    const head = document.createElement('div');
    head.className = 'lib-head'; head.textContent = 'Continue reading';
    wrap.appendChild(head);
    for (const rec of all) {
      const loc = Math.floor((rec.offset || 0) / 128) + 1;
      const totalLoc = Math.max(loc, Math.floor((rec.totalChars || 0) / 128));
      const pct = rec.totalChars ? Math.min(100, Math.round((rec.offset || 0) / rec.totalChars * 100)) : 0;
      const item = document.createElement('div');
      item.className = 'lib-item';
      const info = document.createElement('div');
      info.className = 'lib-info';
      const t = document.createElement('span');
      t.className = 'lib-title'; t.textContent = rec.title || 'Untitled';
      const m = document.createElement('span');
      m.className = 'lib-meta';
      m.textContent = 'loc ' + loc.toLocaleString() + ' / ' + totalLoc.toLocaleString() + ' · ' + pct + '%';
      info.appendChild(t); info.appendChild(m);
      info.addEventListener('click', () => resumeBook(rec));
      const rm = document.createElement('button');
      rm.className = 'lib-remove'; rm.textContent = '✕'; rm.title = 'Remove from library';
      rm.addEventListener('click', async (e) => {
        e.stopPropagation();
        await idbDelete(P_STORE, rec.id); await idbDelete(C_STORE, rec.id);
        renderLibrary();
      });
      item.appendChild(info); item.appendChild(rm);
      wrap.appendChild(item);
    }
  }

  async function resumeBook(rec) {
    const content = await idbGet(C_STORE, rec.id);
    if (!content) {   // text was pruned away — drop the stale entry
      await idbDelete(P_STORE, rec.id); renderLibrary();
      return;
    }
    const book = { title: content.title, chapters: content.chapters, index: rec.chapterIndex || 0, id: rec.id };
    populateBook(book);
    openChapter(rec.chapterIndex || 0, undefined, rec.wordIndex || 0);
  }

  // ---------- article browser (Hacker News / Algolia, CORS-enabled) ----------
  const browseList = $('browse-list');
  let browseLoaded = false;
  let browseFeed = 'front_page';

  function flashBrowseStatus(msg, kind) {
    const el = $('browse-status');
    if (!msg) { el.classList.add('hidden'); return; }
    el.textContent = msg;
    el.className = 'link-status ' + (kind || '');
    el.classList.remove('hidden');
  }

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }

  async function fetchFeed() {
    const q = $('browse-search').value.trim();
    let url;
    if (q) url = 'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(q) + '&tags=story&hitsPerPage=30';
    else if (browseFeed === 'new') url = 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=30';
    else url = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30';
    flashBrowseStatus('Loading…', 'busy');
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      renderArticleList((data.hits || []).filter((h) => h.title));
      browseLoaded = true;
    } catch (err) {
      flashBrowseStatus('Could not load articles: ' + err.message, 'err');
    }
  }

  function renderArticleList(hits) {
    browseList.innerHTML = '';
    if (!hits.length) { flashBrowseStatus('No articles found.', ''); return; }
    flashBrowseStatus('');
    for (const h of hits) {
      const url = h.url || ('https://news.ycombinator.com/item?id=' + h.objectID);
      const meta = [domainOf(url),
        h.points != null ? h.points + ' pts' : '',
        h.num_comments != null ? h.num_comments + ' comments' : ''].filter(Boolean).join('  ·  ');
      const btn = document.createElement('button');
      btn.className = 'art-item';
      btn.innerHTML = '<span class="art-title"></span><span class="art-meta"></span>';
      btn.querySelector('.art-title').textContent = h.title;
      btn.querySelector('.art-meta').textContent = meta;
      btn.addEventListener('click', () => openArticle(url, h.title));
      browseList.appendChild(btn);
    }
  }

  async function openArticle(url, title) {
    flashBrowseStatus('Fetching “' + (title || 'article') + '” …', 'busy');
    try {
      const text = await fetchArticle(url);
      if (!text || text.length < 40) throw new Error('could not extract readable text');
      flashBrowseStatus('');
      openReader(text);
    } catch (err) {
      flashBrowseStatus('Could not open that article: ' + err.message + ' — try another.', 'err');
    }
  }

  // ---------- events ----------
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) =>
        p.classList.toggle('hidden', p.dataset.panel !== state.activeTab));
      // Ebook and Browse tabs act on their own controls, so hide the Start button.
      startBtn.classList.toggle('hidden', state.activeTab === 'file' || state.activeTab === 'browse');
      if (state.activeTab === 'browse' && !browseLoaded) fetchFeed();
      if (state.activeTab === 'file') renderLibrary();
    });
  });

  // Persist reading position when the app is hidden or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgress(true);
  });
  window.addEventListener('pagehide', () => saveProgress(true));

  // Article browser controls
  document.querySelectorAll('.browse-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.browse-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
      browseFeed = chip.dataset.feed;
      $('browse-search').value = '';
      fetchFeed();
    });
  });
  let browseTimer = null;
  $('browse-search').addEventListener('input', () => {
    clearTimeout(browseTimer);
    browseTimer = setTimeout(fetchFeed, 350);   // debounce typing
  });

  // Ebook file input + drag-and-drop
  $('file-input').addEventListener('change', (e) => handleFile(e.target.files[0]));
  const fileDrop = $('file-drop');
  ['dragover', 'dragenter'].forEach((ev) =>
    fileDrop.addEventListener(ev, (e) => { e.preventDefault(); fileDrop.classList.add('drag'); }));
  ['dragleave', 'dragend'].forEach((ev) =>
    fileDrop.addEventListener(ev, () => fileDrop.classList.remove('drag')));
  fileDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDrop.classList.remove('drag');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  $('book-back').addEventListener('click', () => {
    bookView.classList.add('hidden');
    inputView.classList.remove('hidden');
    renderLibrary();
  });

  // Settings panel
  const settingsView = $('settings-view');
  $('settings-btn').addEventListener('click', () => {
    inputView.classList.add('hidden'); settingsView.classList.remove('hidden');
  });
  $('settings-back').addEventListener('click', () => {
    settingsView.classList.add('hidden'); inputView.classList.remove('hidden');
  });
  $('pause-strength').value = Math.round(state.pauseStrength * 100);
  $('pause-out').textContent = Math.round(state.pauseStrength * 100) + '%';
  $('auto-slow').checked = state.autoSlow;
  $('peek-toggle').checked = state.peek;
  $('pause-strength').addEventListener('input', (e) => {
    state.pauseStrength = +e.target.value / 100;
    $('pause-out').textContent = e.target.value + '%';
    savePrefs();
  });
  $('auto-slow').addEventListener('change', (e) => { state.autoSlow = e.target.checked; savePrefs(); });
  $('peek-toggle').addEventListener('change', (e) => { state.peek = e.target.checked; savePrefs(); });

  startBtn.addEventListener('click', async () => {
    if (state.activeTab === 'text') {
      savePrefs();
      openReader(textInput.value);
      return;
    }
    // link tab
    const url = linkInput.value.trim();
    if (!/^https?:\/\//i.test(url)) { flashLinkStatus('Enter a full URL starting with http(s)://', 'err'); return; }
    startBtn.disabled = true;
    flashLinkStatus('Fetching article…', 'busy');
    try {
      const text = await fetchArticle(url);
      if (!text || text.length < 40) throw new Error('Could not extract readable text.');
      linkStatus.classList.add('hidden');
      openReader(text);
    } catch (err) {
      flashLinkStatus('Fetch failed: ' + err.message + ' — try pasting the text instead.', 'err');
    } finally {
      startBtn.disabled = false;
    }
  });

  $('back-btn').addEventListener('click', closeReader);
  playBtn.addEventListener('click', togglePlay);

  // ---------- touch gestures ----------
  // Hold to play, release to pause. Swipe ↕ to change speed, ↔ to seek.
  // Handled on a full-screen layer so gestures work anywhere on the screen.
  const stage = document.getElementById('gesture-layer');
  const THRESH = 14;            // px of movement before a hold becomes a swipe
  const PX_PER_WORD = 10;       // horizontal seek sensitivity
  const PX_PER_WPM = 1.6;       // vertical speed sensitivity
  let g = null;
  let lastTap = 0;              // for double-tap (replay) detection

  const gestureHint = $('gesture-hint');
  stage.addEventListener('touchstart', (e) => {
    if (gestureHint) gestureHint.style.opacity = '0';
    g = {
      x0: e.touches[0].clientX,
      y0: e.touches[0].clientY,
      t0: Date.now(),
      mode: 'hold',            // 'hold' | 'seek' | 'speed'
      startIndex: state.index,
      startWpm: state.wpm,
    };
    play();                    // hold-to-play begins immediately
  }, { passive: true });

  stage.addEventListener('touchmove', (e) => {
    if (!g) return;
    const dx = e.touches[0].clientX - g.x0;
    const dy = e.touches[0].clientY - g.y0;

    if (g.mode === 'hold' && (Math.abs(dx) > THRESH || Math.abs(dy) > THRESH)) {
      // A swipe: stop the hold-play blip and reset to where the finger landed.
      pause();
      seekTo(g.startIndex);
      g.mode = Math.abs(dx) > Math.abs(dy) ? 'seek' : 'speed';
    }

    if (g.mode === 'seek') {
      seekTo(g.startIndex + Math.round(dx / PX_PER_WORD));
    } else if (g.mode === 'speed') {
      setWpm(g.startWpm - dy / PX_PER_WPM);   // up = faster
    }
  }, { passive: true });

  function endGesture(cancelled) {
    if (!g) return;
    // A quick, still touch is a tap; two taps in quick succession = replay.
    const tap = !cancelled && g.mode === 'hold' && (Date.now() - g.t0) < 250;
    pause();
    const now = Date.now();
    const isDouble = tap && (now - lastTap) < 320;
    g = null;
    if (isDouble) { lastTap = 0; regress(); }
    else if (tap) { lastTap = now; }
  }
  stage.addEventListener('touchend', () => endGesture(false));
  stage.addEventListener('touchcancel', () => endGesture(true));

  // Mouse users (no touch): click = play/pause, double-click = replay sentence.
  stage.addEventListener('click', () => { if (!isTouch) togglePlay(); });
  stage.addEventListener('dblclick', () => { if (!isTouch) regress(); });
  $('rewind-btn').addEventListener('click', () => nudge(-10));
  $('ffwd-btn').addEventListener('click', () => nudge(10));

  seek.addEventListener('input', () => {
    const total = state.tokens.length;
    const wasPlaying = state.playing;
    pause();
    seekTo(Math.round((seek.value / 100) * (total - 1)));
    if (wasPlaying) { /* stay paused while scrubbing */ }
  });

  const wpmBadge = $('wpm-val');
  function setWpm(v) {
    v = Math.max(100, Math.round(v));   // no upper limit
    state.wpm = v;
    wpmRange.value = v;
    wpmOut.textContent = v + ' wpm';
    if (wpmBadge) wpmBadge.textContent = v + ' wpm';
    updateProgress();
    savePrefs();
  }

  wpmRange.addEventListener('input', () => setWpm(+wpmRange.value));

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    if (readerView.classList.contains('hidden')) return;
    switch (e.key) {
      case ' ':      e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft':  e.preventDefault(); nudge(-5); break;
      case 'ArrowRight': e.preventDefault(); nudge(5); break;
      case 'ArrowUp':    e.preventDefault(); wpmRange.value = state.wpm + 25; wpmRange.dispatchEvent(new Event('input')); break;
      case 'ArrowDown':  e.preventDefault(); wpmRange.value = state.wpm - 25; wpmRange.dispatchEvent(new Event('input')); break;
      case 'r': case 'R': e.preventDefault(); regress(); break;   // replay sentence
      case 'Escape':     closeReader(); break;
    }
  });

  // Save the pasted text as you type (debounced-ish via change)
  textInput.addEventListener('change', savePrefs);

  // ---------- service worker + auto-update ----------
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    // When a new worker takes control, reload once so fresh assets apply.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return;   // don't reload on first install
      reloading = true;
      location.reload();
    });
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' });
        reg.update();
        // Re-check for updates whenever the app comes back to the foreground.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update();
        });
      } catch (_) {}
    });
  }

  // Handle share-target / URL param (?text= or ?url=) for PWA share integration
  const params = new URLSearchParams(location.search);
  if (params.get('text')) {
    textInput.value = params.get('text');
  }
  if (params.get('url')) {
    document.querySelector('.tab[data-tab="link"]').click();
    linkInput.value = params.get('url');
  }

  // Warm the continue-reading library so it's ready when the Ebook tab opens.
  renderLibrary();
})();
