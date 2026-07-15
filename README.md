# ⚡ Flash — RSVP Speed Reader

An installable, offline-capable PWA that shows text **one word at a time** (Rapid
Serial Visual Presentation) so your eyes never move — the classic trick for reading
faster. Paste text or an article link and go.

## Features
- **Paste text** or **fetch an article from a link** (clean text via a reader proxy)
- ORP-aligned pivot letter pinned to a fixed focal point
- 100–1000 wpm, adaptive pauses for long words & sentence ends
- Seek bar, ±10-word skip, live context strip & time remaining
- **Mobile:** tap the word to play/pause, swipe to skip
- **Desktop:** `Space` play/pause · `←/→` skip · `↑/↓` speed · `Esc` back
- Installable PWA with offline app-shell caching and a share target

## Use it
Hosted on GitHub Pages (link in the repo's About). Or run locally:

```bash
./serve.sh            # http://localhost:8777
```

A local web server (not `file://`) is required because of the service worker.

## Tech
Vanilla HTML/CSS/JS, no build step, no dependencies. Article extraction uses the
public `r.jina.ai` reader endpoint.
