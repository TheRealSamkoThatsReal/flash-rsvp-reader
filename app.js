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
  };

  // Persisted preferences
  try {
    const saved = JSON.parse(localStorage.getItem('flash-prefs') || '{}');
    if (saved.wpm) state.wpm = saved.wpm;
    if (saved.text) textInput.value = saved.text;
  } catch (_) {}
  wpmRange.value = state.wpm;
  wpmOut.textContent = state.wpm + ' wpm';
  $('wpm-badge').textContent = state.wpm + ' wpm';

  const savePrefs = () => {
    try {
      localStorage.setItem('flash-prefs', JSON.stringify({ wpm: state.wpm, text: textInput.value.slice(0, 200000) }));
    } catch (_) {}
  };

  // ---------- tokenizer ----------
  // Split into words, attaching a per-word timing multiplier so long words and
  // sentence boundaries linger a little longer (classic RSVP pacing).
  function tokenize(raw) {
    const words = raw.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    return words.map((word) => {
      let delay = 1;
      const len = word.length;
      if (len > 6)  delay += Math.min((len - 6) * 0.06, 0.6);   // long words
      if (/[,;:]$/.test(word))       delay += 0.4;              // mid-clause pause
      if (/[.!?…"”)]$/.test(word))   delay += 0.9;              // end of sentence
      if (/[.!?…]["”)]?$/.test(word))delay += 0.2;
      return { word, delay };
    });
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
  }

  // state.index always points at the word currently on screen.
  function scheduleNext() {
    const tok = state.tokens[state.index];
    const ms = baseDelayMs() * tok.delay;
    state.timer = setTimeout(() => {
      if (!state.playing) return;
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
  }

  function togglePlay() { state.playing ? pause() : play(); }

  function finish() {
    pause();
    state.index = state.tokens.length;
    wPre.textContent = ''; wOrp.textContent = '✓'; wPost.textContent = '';
    contextStrip.innerHTML = '<span class="cur">Done.</span>';
    updateProgress();
  }

  function seekTo(idx) {
    idx = Math.max(0, Math.min(idx, state.tokens.length - 1));
    state.index = idx;
    showCurrent();
  }

  function nudge(delta) {
    const wasPlaying = state.playing;
    pause();
    seekTo(state.index + delta);
    if (wasPlaying) play();
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
  }

  function updateContext() {
    const i = state.index;
    const from = Math.max(0, i - 6), to = Math.min(state.tokens.length, i + 7);
    let html = '';
    for (let j = from; j < to; j++) {
      const w = state.tokens[j].word;
      html += j === i ? `<span class="cur">${escapeHtml(w)}</span> ` : escapeHtml(w) + ' ';
    }
    contextStrip.innerHTML = html;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ---------- view switching ----------
  function openReader(text) {
    state.tokens = tokenize(text);
    if (!state.tokens.length) { flashLinkStatus('Nothing to read — the text was empty.', 'err'); return; }
    state.index = 0;
    inputView.classList.add('hidden');
    readerView.classList.remove('hidden');
    showCurrent();
    // Desktop autostarts; on touch the reader waits for a hold-to-play press.
    if (!isTouch) setTimeout(play, 500);
  }

  function closeReader() {
    pause();
    readerView.classList.add('hidden');
    inputView.classList.remove('hidden');
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

  // ---------- events ----------
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) =>
        p.classList.toggle('hidden', p.dataset.panel !== state.activeTab));
    });
  });

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

  const gestureHint = $('gesture-hint');
  stage.addEventListener('touchstart', (e) => {
    if (gestureHint) gestureHint.style.opacity = '0';
    g = {
      x0: e.touches[0].clientX,
      y0: e.touches[0].clientY,
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

  const endGesture = () => { if (g) { pause(); g = null; } };  // release to pause
  stage.addEventListener('touchend', endGesture);
  stage.addEventListener('touchcancel', endGesture);

  // Mouse users (no touch): click the word to play/pause.
  stage.addEventListener('click', () => { if (!isTouch) togglePlay(); });
  $('rewind-btn').addEventListener('click', () => nudge(-10));
  $('ffwd-btn').addEventListener('click', () => nudge(10));

  seek.addEventListener('input', () => {
    const total = state.tokens.length;
    const wasPlaying = state.playing;
    pause();
    seekTo(Math.round((seek.value / 100) * (total - 1)));
    if (wasPlaying) { /* stay paused while scrubbing */ }
  });

  const wpmBadge = $('wpm-badge');
  function setWpm(v) {
    v = Math.max(100, Math.min(1000, Math.round(v)));
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
})();
