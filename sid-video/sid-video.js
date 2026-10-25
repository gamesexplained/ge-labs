#!/usr/bin/env node
// sid-video: a phone-shaped video of a Games Explained C64 page's music player, in its
// full-screen bouncing-ball view, with the tune's sound. Nothing is recorded off a screen, so the
// picture and the sound cannot drift: each video frame is the page's own ball view
// (site/lib/bounce.js) drawn at the exact driver frame for its moment, and the sound is the
// site's own SID model (site/lib/sid.js) running the page's own driver, rendered offline.
//
//   node sid-video.js <page> [options]        see usage() below, or run with --help
//
// Needs Node 18+, Playwright with its Chromium (require('playwright')), and ffmpeg with libx264.
//
// How it works:
// - The page is opened in headless Chromium at half the video's size with a device pixel ratio of
//   2 (bounce.js draws at most 2 device pixels to a CSS pixel), so 1080x1920 is a 540x960 page.
//   An init script wraps C64Sid.mount and NoteBounce.create to find each player, its options and
//   its ball view. The tune's button is pressed, so the page computes the tune's notes itself,
//   then Stop, then the player's own Full screen button, which is then hidden.
// - sid.js measures a tune's notes for 300 s (LONG in length()); this script serves sid.js with
//   that raised, so a long tune's ball keeps its notes to the end.
// - Video frame j draws the view at driver tick 1 + (j / fps - lead) * FPS, which is the tick the
//   player's drawBall computes from the audio clock while the tune plays. The canvas leaves the
//   page through VideoFrame.copyTo (bit-exact with getImageData, five times faster) over a
//   WebSocket into ffmpeg; a fetch of the 8 MB took half a second.
// - Several renderers (--workers) each take a stretch of the frames into a segment of their own,
//   joined at the end with ffmpeg's concat demuxer.
// - The sound: the player's own engine, createPlayer(driver, 48000, the options mount gives the
//   audio worklet), rendered in the page without an audio device. Driver frame k sounds from
//   (k - 1) / FPS, as in the worklet.
// - At the end it checks the finished file: the rise in sound energy averaged over every note the
//   ball lands on should peak within half a driver frame (10 ms) of the landing. Where it peaks
//   inside that depends on the music (0 ms for Master of Magic, -4 ms for Wizball's title).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

function usage() {
  return `Usage: node sid-video.js <page> [options]

<page>            a C64 game page: a URL (https://gamesexplained.com/c64/master-of-magic/,
                  or a local server), or a path inside --site (c64/master-of-magic/)
--site DIR        the built site to serve for a path: gamesexplained's _site, from
                  python3 kit/scripts/build.py
--list            print the page's players and their tunes, then stop
--player N        which player on the page, counted from 0 in the order of --list (default 0)
--tune N          which tune of that player, from 0 (default 0)
--end S           where the video stops, in seconds of the tune. Default: a tune that ends by
                  itself plays to its end plus 1 s; one that runs on stops at 138.6 s, so that
                  with a 1 s lead-in the video is 2:19.6, inside a free Twitter/X account's 2:20
--fade S          fade the sound out over the last S seconds (default 0 for a tune that ends
                  by itself, 6 for one that runs on). The picture always fades to black over
                  the last second
--lead S          seconds of the sheet before the tune starts (default 1)
--size WxH        the picture (default 1080x1920; 1920x1080 is the landscape view)
--fps N           frames a second (default 60)
--workers N       renderers in parallel (default 3; about 2.5 frames a second each on a
                  4-core cloud machine)
--crf N           x264 quality, lower is better (default 16)
--preset P        x264 preset (default medium; fast takes about half the time)
--raw             send each frame's pixels to ffmpeg as they are, instead of having the page
                  encode them first: exact, but about six times slower
--out FILE        the MP4 to write (default <game>-<tune name>.mp4)
--keep            keep the work folder (segments and sound) beside the MP4`;
}

// ------------------------------------------------------------------ arguments
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith('--')) { a._.push(s); continue; }
    const k = s.slice(2);
    if (['list', 'keep', 'help', 'raw'].includes(k)) a[k] = true;
    else if (k === 'worker') a.worker = argv[++i];
    else { if (i + 1 >= argv.length) throw new Error(`${s} needs a value`); a[k] = argv[++i]; }
  }
  return a;
}

// ------------------------------------------------------------------ a static server for --site
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.txt': 'text/plain' };
function serveSite(dir) {
  const root = path.resolve(dir);
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(root, p);
    if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, base: `http://127.0.0.1:${srv.address().port}/` })));
}

// ------------------------------------------------------------------ a WebSocket server for frames
// Just enough of RFC 6455 to take binary messages from the page and answer with short text.
function frameSocket(onMessage) {
  const srv = http.createServer((q, r) => { r.writeHead(426); r.end(); });
  srv.on('upgrade', (req, sock) => {
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.setNoDelay(true);
    const send = (text) => { const p = Buffer.from(text); sock.write(Buffer.concat([Buffer.from([0x81, p.length]), p])); };
    let chunks = [], have = 0, parts = [];
    sock.on('data', (d) => {
      chunks.push(d); have += d.length;
      for (;;) {
        if (have < 2) return;
        if (chunks[0].length < 14 && chunks.length > 1) { chunks = [Buffer.concat(chunks, have)]; }
        const h = chunks[0];
        if (h.length < 2) return;
        const fin = h[0] & 0x80, op = h[0] & 15, masked = h[1] & 0x80;
        let len = h[1] & 127, off = 2;
        if (len === 126) { if (h.length < 4) return; len = h.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (h.length < 10) return; len = Number(h.readBigUInt64BE(2)); off = 10; }
        const mo = off;
        if (masked) off += 4;
        if (have < off + len) return;
        const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, have);   // one copy a message
        const payload = Buffer.from(all.subarray(off, off + len));
        if (masked) { const m = all.subarray(mo, mo + 4); for (let i = 0; i < len; i++) payload[i] ^= m[i & 3]; }
        const rest = all.subarray(off + len);
        chunks = rest.length ? [rest] : []; have = rest.length;
        if (op === 8) { sock.end(); return; }
        if (op === 0 || op === 1 || op === 2) {
          parts.push(payload);
          if (op) parts.op = op;
          if (fin) { const msg = parts.length === 1 ? parts[0] : Buffer.concat(parts); const t = parts.op; parts = []; onMessage(msg, send, t); }
        }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port })));
}

// ------------------------------------------------------------------ the page
// Opens the page, finds the player, presses the tune so the page computes its notes, stops it,
// and (for rendering) puts the ball view full screen. Returns what the caller needs.
async function openPage(o) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--disable-gpu', '--disable-accelerated-2d-canvas'] });
  const ctx = await browser.newContext({ viewport: { width: o.W / 2, height: o.H / 2 }, deviceScaleFactor: 2 });
  const origin = new URL(o.url).origin;
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();                // analytics and anything else off-site
    if (/\/lib\/sid\.js(\?|$)/.test(new URL(u).pathname + '?')) {
      const r = await route.fetch();
      let body = await r.text();
      if (!body.includes('Math.ceil(300 * FPS)')) console.error('note: sid.js no longer has LONG = Math.ceil(300 * FPS); the ball\'s notes stop at sid.js\'s own limit');
      return route.fulfill({ response: r, body: body.replace('Math.ceil(300 * FPS)', `Math.ceil(${o.longSec} * FPS)`) });
    }
    return route.continue();
  });
  await ctx.addInitScript(() => {
    window.__mounts = []; window.__views = [];
    let NB, S;
    Object.defineProperty(window, 'NoteBounce', { configurable: true, get: () => NB, set: (v) => {
      const create = v.create;
      v.create = (canvas, opts) => {
        const view = create(canvas, opts);
        const rec = { canvas, view, draw: view.draw, score: view.score, last: null };
        view.draw = (t, op) => { if (!window.__lock) rec.draw(t, op); };
        view.score = (s) => { rec.last = s; rec.score(s); };
        window.__views.push(rec);
        return view;
      };
      NB = v;
    } });
    Object.defineProperty(window, 'C64Sid', { configurable: true, get: () => S, set: (v) => {
      const mount = v.mount;
      v.mount = (root, opts) => { window.__mounts.push({ root, o: opts }); return mount(root, opts); };
      S = v;
    } });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { if (o.verbose) console.error('page error:', e.message); });
  await page.goto(o.url, { waitUntil: 'load' });
  // players can mount late (Delta's waits for its listing.json): wait for the first, then until
  // no more have come for 1.5 s
  await page.waitForFunction(() => window.__mounts.length > 0, null, { timeout: 60000 }).catch(() => {});
  for (let n = -1, still = 0; still < 3; ) {
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => window.__mounts.length);
    if (m === n) still++; else { n = m; still = 0; }
  }
  await page.evaluate(() => window.__mounts.sort((a, b) =>               // in page order: pages mount
    a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));   // in any order
  const players = await page.evaluate(() => window.__mounts.map((m, i) => {
    let h = m.root.closest('section'), head = h && h.querySelector('h2,h3');
    return { i, tunes: m.o.tunes || [], where: m.root.dataset.w || m.root.id || '', heading: head ? head.textContent.trim() : '' };
  }));
  if (o.listOnly) { await browser.close(); return { players }; }
  if (!players.length) throw new Error('no SID player on this page (C64Sid.mount was never called)');
  if (!players[o.player]) throw new Error(`no player ${o.player}: the page has ${players.length}`);
  const tunes = players[o.player].tunes;
  if (!(o.tune >= 0 && o.tune < tunes.length)) throw new Error(`player ${o.player} has tunes 0-${tunes.length - 1}`);
  const root = await page.evaluateHandle((p) => window.__mounts[p].root, o.player);
  await root.evaluate((r) => r.scrollIntoView({ block: 'center' }));
  const tuneBtn = await root.evaluateHandle((r, t) => r.querySelector(`button[data-tune="${t}"]`), o.tune);
  await tuneBtn.asElement().click();
  // the page's own score for the tune, its length and the clock
  const info = await page.waitForFunction((p) => {
    const m = window.__mounts[p];
    const rec = window.__views.find((v) => m.root.contains(v.canvas));
    if (!rec || !rec.last) return null;
    const E = C64Sid.engine(), CK = m.o.ntsc ? E.NTSC_CLOCK : E.CLOCK, PERIOD = E.periodOf(m.o);
    const seek = m.root.querySelector('.sid-seek input');
    const s = rec.last;
    let notes;                                                       // as the view takes them, steps in the line included
    try { notes = s.voices.map((v, x) => (rec.view.notesOf(x) || []).map((q) => [q.t, q.n])); }
    catch (e) { notes = s.voices.map((v) => v.notes.map((q) => [q.t, q.n])); }
    let hash = 0;
    for (const v of s.voices) { for (const q of v.notes) hash = (hash * 31 + q.t * 7 + Math.round(q.n * 1000)) % 2147483647;
      for (let k = 0; k < v.level.length; k += 7) hash = (hash * 31 + Math.round(v.level[k] * 1e6)) % 2147483647; }
    return { FPS: CK / PERIOD, ticks: s.voices[0].line.length, seekMax: +seek.max, notes, hash };
  }, o.player, { timeout: 30000 }).then((h) => h.jsonValue());
  const stop = await root.evaluateHandle((r) => r.querySelector('button[data-stop]'));
  await stop.asElement().click();
  return { browser, ctx, page, root, players, info, tuneName: tunes[o.tune] };
}

async function fullScreen(o, P) {
  const full = await P.root.evaluateHandle((r) => r.querySelector('[data-full]'));
  if (!full.asElement()) throw new Error('this player has no ball view (bounce: false?)');
  await full.asElement().click();
  await P.page.waitForFunction(({ p, w, h }) => {
    const m = window.__mounts[p], rec = window.__views.find((v) => m.root.contains(v.canvas));
    return document.fullscreenElement && rec.canvas.clientWidth === w && rec.canvas.clientHeight === h;
  }, { p: o.player, w: o.W / 2, h: o.H / 2 }, { timeout: 15000 });
  await P.page.addStyleTag({ content: '.sid-player .sid-full{display:none!important}' });
  await P.page.waitForTimeout(2500);                                 // the player's loop winds down
  await P.page.evaluate(() => { window.__lock = true; });
  await P.ctx.unrouteAll({ behavior: 'ignoreErrors' });
}

// ------------------------------------------------------------------ one renderer
// The page encodes its own frames with WebCodecs (H.264, OpenH264 in Chromium) and sends the
// encoded stream, about 70 KB a frame, where a raw frame is 8 MB: a renderer then draws about 15
// frames a second instead of 2.5. The stream is full-range BT.709 at about 30 Mb/s; the main
// process turns it into the final limited-range x264 file (about 43 dB PSNR against the canvas
// before that, colours within a level or so).
const ENCODER = (W, H, fps) => ({ codec: 'avc1.640034', width: W, height: H, framerate: fps, bitrateMode: 'variable',
  bitrate: 60e6, latencyMode: 'quality', avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-software' });

async function workerEncoded(job) {
  const o = job.o;
  const out = fs.openSync(job.file, 'w');
  let finished, chunks = 0;
  const done = new Promise((ok) => { finished = ok; });
  const ws = await frameSocket((buf, send, op) => {
    if (op === 1) { finished(buf.toString()); return; }                // text: the page has flushed
    fs.writeSync(out, buf); chunks++;
  });
  const P = await openPage(o);
  if (P.info.hash !== job.hash) throw new Error(`[${job.name}] the page gave different notes from the first run`);
  await fullScreen(o, P);
  await P.page.evaluate(async ({ port, cfg }) => {
    const sock = window.__sock = new WebSocket('ws://127.0.0.1:' + port);
    await new Promise((ok, fail) => { sock.onopen = ok; sock.onerror = fail; });
    window.__encoded = 0; window.__encErr = null;
    window.__enc = new VideoEncoder({
      output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); sock.send(b); window.__encoded++; },
      error: (e) => { window.__encErr = String(e); } });
    window.__enc.configure(cfg);
  }, { port: ws.port, cfg: ENCODER(o.W, o.H, o.fps) });
  const t0 = Date.now(), BATCH = 300;
  for (let j0 = job.a; j0 < job.b; j0 += BATCH) {
    const j1 = Math.min(job.b, j0 + BATCH);
    const err = await P.page.evaluate(async ({ p, a, j0, j1, FPS, fps, lead }) => {
      const m = window.__mounts[p], rec = window.__views.find((v) => m.root.contains(v.canvas));
      const muted = [false, false, false], enc = window.__enc, sock = window.__sock;
      for (let j = j0; j < j1; j++) {
        if (window.__encErr) return window.__encErr;
        rec.draw(1 + (j / fps - lead) * FPS, { muted });
        const vf = new VideoFrame(rec.canvas, { timestamp: Math.round((j - a) * 1e6 / fps), duration: Math.round(1e6 / fps) });
        enc.encode(vf, { keyFrame: (j - a) % 120 === 0 }); vf.close();
        while (enc.encodeQueueSize > 3 || sock.bufferedAmount > 8e6) await new Promise((ok) => setTimeout(ok, 2));
      }
      return window.__encErr;
    }, { p: o.player, a: job.a, j0, j1, FPS: P.info.FPS, fps: o.fps, lead: o.lead });
    if (err) throw new Error(`[${job.name}] the page's encoder failed: ${err}`);
    const n = j1 - job.a, s = (Date.now() - t0) / 1000;
    process.stdout.write(`${JSON.stringify({ name: job.name, done: n, of: job.b - job.a, fps: n / s })}\n`);
  }
  const encoded = await P.page.evaluate(async () => {
    await window.__enc.flush();
    while (window.__sock.bufferedAmount) await new Promise((ok) => setTimeout(ok, 5));
    window.__sock.send('done ' + window.__encoded);
    return window.__encoded;
  });
  await done;
  fs.closeSync(out);
  await P.browser.close();
  ws.srv.close();
  if (encoded !== job.b - job.a || chunks !== encoded) throw new Error(`[${job.name}] ${encoded} frames encoded and ${chunks} received, of ${job.b - job.a}`);
}

// The older path, for a browser without an H.264 encoder (--raw): each frame's pixels go to
// ffmpeg as they are, through VideoFrame.copyTo (bit-exact with getImageData, five times faster)
// over the WebSocket.
async function worker(job) {
  const o = job.o;
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${o.W}x${o.H}`, '-r', String(o.fps), '-i', 'pipe:0',
    '-vf', (job.fadeAt != null ? `fade=t=out:st=${job.fadeAt.toFixed(4)}:d=1,` : '') +
      'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p',
    '-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-profile:v', 'high', '-x264-params', 'aq-mode=3',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', job.file],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((ok) => ff.on('close', ok));
  const size = o.W * o.H * 4;
  const ws = await frameSocket((buf, send) => {
    if (buf.length !== size) { console.error(`[${job.name}] a frame of ${buf.length} bytes, expected ${size}`); process.exit(1); }
    if (ff.stdin.write(buf)) send('ok'); else ff.stdin.once('drain', () => send('ok'));
  });
  const P = await openPage(o);
  if (P.info.hash !== job.hash) throw new Error(`[${job.name}] the page gave different notes from the first run`);
  await fullScreen(o, P);
  await P.page.evaluate(async (port) => {
    window.__sock = new WebSocket('ws://127.0.0.1:' + port);
    window.__sock.binaryType = 'arraybuffer';
    window.__acks = 0; window.__sent = 0; window.__wake = null;
    window.__sock.onmessage = () => { window.__acks++; const w = window.__wake; window.__wake = null; if (w) w(); };
    await new Promise((ok, fail) => { window.__sock.onopen = ok; window.__sock.onerror = fail; });
  }, ws.port);
  const t0 = Date.now(), BATCH = 120;
  for (let j0 = job.a; j0 < job.b; j0 += BATCH) {
    const j1 = Math.min(job.b, j0 + BATCH);
    await P.page.evaluate(async ({ p, j0, j1, FPS, fps, lead }) => {
      const m = window.__mounts[p], rec = window.__views.find((v) => m.root.contains(v.canvas));
      const muted = [false, false, false];
      const room = () => window.__sent - window.__acks < 2 ? Promise.resolve()
        : new Promise((ok) => { window.__wake = ok; }).then(room);
      for (let j = j0; j < j1; j++) {
        rec.draw(1 + (j / fps - lead) * FPS, { muted });
        const vf = new VideoFrame(rec.canvas, { timestamp: j });     // BGRA
        const px = new Uint8Array(vf.allocationSize());
        await vf.copyTo(px); vf.close();
        await room();
        window.__sock.send(px.buffer); window.__sent++;
      }
      while (window.__sent !== window.__acks) await new Promise((ok) => { window.__wake = ok; });
    }, { p: o.player, j0, j1, FPS: P.info.FPS, fps: o.fps, lead: o.lead });
    const done = j1 - job.a, s = (Date.now() - t0) / 1000;
    process.stdout.write(`${JSON.stringify({ name: job.name, done, of: job.b - job.a, fps: done / s })}\n`);
  }
  await P.browser.close();
  ff.stdin.end();
  const code = await ffDone;
  ws.srv.close();
  if (code) throw new Error(`[${job.name}] ffmpeg exited with ${code}`);
}

// ------------------------------------------------------------------ the sound
async function renderSound(o, P, seconds) {
  const SR = 48000;
  const N = Math.round(seconds * SR);
  await P.page.evaluate(({ p, tune }) => {
    const m = window.__mounts[p], E = C64Sid.engine();
    const FILTERS = ['none', '6581', '8580'];
    const opts = { gain: m.o.gain, filter: FILTERS.includes(m.o.filter) ? m.o.filter : 'none', ntsc: !!m.o.ntsc,
      period: m.o.period, digi: m.o.digi };                          // what mount gives host()
    window.__snd = E.createPlayer(m.o.driver(m.o.data, globalThis.C64Cpu), 48000, opts);
    window.__snd.command({ cmd: 'start', tune, run: 1, at: 0 });
  }, { p: o.player, tune: o.tune });
  const out = new Float32Array(N);
  const STEP = SR * 10;
  for (let i = 0; i < N; i += STEP) {
    const n = Math.min(STEP, N - i);
    const b64 = await P.page.evaluate(({ i, n }) => {
      const x = new Float32Array(n);
      for (let k = 0; k < n; k += 128) {                             // in blocks of 128, as the worklet
        const blk = x.subarray(k, Math.min(n, k + 128));
        window.__snd.render(blk, blk.length, (i + k) / 48000, null);
      }
      const u = new Uint8Array(x.buffer);
      let s = '';
      for (let k = 0; k < u.length; k += 0x8000) s += String.fromCharCode.apply(null, u.subarray(k, k + 0x8000));
      return btoa(s);
    }, { i, n });
    const b = Buffer.from(b64, 'base64');
    out.set(new Float32Array(b.buffer, b.byteOffset, b.length / 4), i);
  }
  return out;
}

function writeWav(file, x, SR) {                                     // 32-bit float, mono
  const b = Buffer.alloc(44 + x.length * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34); b.write('data', 36);
  b.writeUInt32LE(x.length * 4, 40);
  Buffer.from(x.buffer, x.byteOffset, x.byteLength).copy(b, 44);
  fs.writeFileSync(file, b);
}

// Two checks on the finished file. The sound in it against the sound rendered: the lag in ms
// where they match best (0 unless muxing shifted it). And the rise in sound energy averaged over
// the notes the ball lands on, for each voice, against the offset from the landing. That one
// depends on the music: notes that start with an attack peak within a few ms (Master of Magic:
// 0 to 1), but a voice that changes pitch under a held note has no attack to find (Shadowfire's
// title: +34, -26 and -49), so it only warns when the voices agree. Some drivers make each note
// loudest a frame or more after it starts (Delta: +20 ms on every voice; Armalyte's Demo: +33),
// so it warns past 45 ms, where viewers start to notice sound early (ITU-R BT.1359; sound late
// shows only from about 125 ms).
function syncCheck(mp4, voiceTimes, ref) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', mp4, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 30 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  let lag = null;
  if (ref) {                                                         // 5 s from the 2nd second on, lags of up to 100 ms
    const a0 = 48000, len = Math.min(5 * 48000, x.length - a0 - 4800, ref.length - a0 - 4800);
    let bestC = -Infinity;
    for (let L = -4800; L <= 4800; L += 1) {
      let c = 0;
      for (let i = 0; i < len; i += 8) c += x[a0 + i + L] * ref[a0 + i];
      if (c > bestC) { bestC = c; lag = L; }
    }
    lag = lag / 48;
  }
  const n = Math.floor(x.length / 48), le = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < 48; k++) { const v = x[i * 48 + k]; s += v * v; } le[i] = 0.5 * Math.log(s / 48 + 1e-24); }
  const voices = voiceTimes.map((times) => {
    const acc = new Float64Array(201);
    let used = 0;
    for (const t of times) {
      const c = Math.round(t * 1000);
      if (c - 101 < 0 || c + 101 >= n) continue;
      used++;
      for (let d = -100; d <= 100; d++) acc[d + 100] += Math.max(0, le[c + d] - le[c + d - 1]);
    }
    let best = 0;
    for (let d = -100; d <= 100; d++) if (acc[d + 100] > acc[best + 100]) best = d;
    return { best, used };
  }).filter((v) => v.used >= 20);
  const sorted = voices.map((v) => v.best).sort((p, q) => p - q);
  return { lag, voices, best: sorted.length ? sorted[(sorted.length - 1) >> 1] : null,
    agree: sorted.length > 0 && sorted[sorted.length - 1] - sorted[0] <= 10 };
}

// ------------------------------------------------------------------ main
async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.worker) {
    const job = JSON.parse(fs.readFileSync(a.worker, 'utf8'));
    await (job.raw ? worker(job) : workerEncoded(job));
    return;
  }
  if (a.help || !a._.length) { console.log(usage()); process.exit(a.help ? 0 : 1); }

  let url = a._[0], site = null;
  if (!/^https?:\/\//.test(url)) {
    if (!a.site) throw new Error('give the page as a URL, or as a path with --site <built site>');
    site = await serveSite(a.site);
    url = new URL(url.replace(/^\/+/, ''), site.base).href;
  }
  const [W, H] = (a.size || '1080x1920').split('x').map(Number);
  if (!(W > 0 && H > 0 && W % 4 === 0 && H % 4 === 0)) throw new Error('--size needs W and H, each a multiple of 4');
  const o = { url, W, H, player: +(a.player || 0), tune: +(a.tune || 0), fps: +(a.fps || 60),
    lead: a.lead != null ? +a.lead : 1, crf: +(a.crf || 16), preset: a.preset || 'medium', longSec: 300, listOnly: !!a.list };
  const workers = Math.max(1, +(a.workers || 3));

  if (o.listOnly) {
    const { players } = await openPage(o);
    for (const p of players) {
      console.log(`player ${p.i}${p.heading ? ` (under "${p.heading}")` : ''}:`);
      p.tunes.forEach((t, k) => console.log(`  --player ${p.i} --tune ${k}   ${t}`));
    }
    if (site) site.srv.close();
    return;
  }

  // first look: the tune's length and notes, measured by the page for up to 15 minutes, or past --end
  o.longSec = Math.max(900, Math.ceil((+a.end || 0) + 10));
  const P = await openPage(o);
  const { FPS, seekMax } = P.info;
  const runsOn = seekMax >= Math.ceil(o.longSec * FPS);
  const tuneSec = runsOn ? null : seekMax / FPS;
  const end = a.end != null ? +a.end : runsOn ? 140 - o.lead - 0.4 : tuneSec + 1;
  const fade = a.fade != null ? +a.fade : runsOn ? 6 : 0;
  const frames = Math.round((o.lead + end) * o.fps), total = frames / o.fps;   // the sound as long as the picture
  const slug = new URL(url).pathname.split('/').filter((x) => x && !/\.html$/.test(x)).pop() || 'tune';
  const out = path.resolve(a.out || `${slug}-${P.tuneName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.mp4`);
  const work = out.replace(/\.mp4$/i, '') + '.work';
  fs.mkdirSync(work, { recursive: true });
  const clock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  console.log(`${slug}, player ${o.player}, tune ${o.tune} "${P.tuneName}": ` +
    (runsOn ? `runs on past ${clock(o.longSec)}` : `ends by itself at ${clock(tuneSec)}`) +
    `; video ${clock(total)} (${o.lead} s lead-in, sound fade ${fade} s), ${W}x${H} at ${o.fps} fps, ${frames} frames`);
  if (total > 140) console.log('note: longer than 2:20, the most a free Twitter/X account takes');

  // the sound
  const SR = 48000;
  const tune = await renderSound(o, P, total - o.lead);
  const lead = Math.round(o.lead * SR), sound = new Float32Array(lead + tune.length);
  const f0 = end - fade, f1 = end - Math.min(0.2, fade / 4);
  for (let i = 0; i < tune.length; i++) {
    const t = i / SR, x = fade <= 0 || t <= f0 ? 0 : Math.min(1, (t - f0) / (f1 - f0));
    sound[lead + i] = tune[i] * Math.pow(10, -3 * x) * (1 - x);      // to -60 dB, then nothing
  }
  writeWav(path.join(work, 'sound.wav'), sound, SR);
  const noteTimes = P.info.notes.map((v) => v.map(([t]) => o.lead + (t - 1) / FPS).filter((t) => t < o.lead + end - fade - 0.2));
  const raw = !!a.raw || !(await P.page.evaluate(async (cfg) => typeof VideoEncoder !== 'undefined' &&
    (await VideoEncoder.isConfigSupported(cfg)).supported, ENCODER(W, H, o.fps)));
  if (raw && !a.raw) console.log('note: this Chromium has no H.264 encoder for the page; sending raw frames (slower)');
  await P.browser.close();

  // the picture, in segments
  const per = Math.ceil(frames / workers), jobs = [];
  for (let w = 0; w < workers; w++) {
    const s = w * per, e = Math.min(frames, s + per);
    if (s >= e) break;
    const job = { name: `w${w + 1}`, a: s, b: e, file: path.join(work, `seg${w + 1}.${raw ? 'mp4' : 'h264'}`), hash: P.info.hash, o,
      raw, fadeAt: e === frames ? (e - s - o.fps) / o.fps : null };
    fs.writeFileSync(path.join(work, `job${w + 1}.json`), JSON.stringify(job));
    jobs.push(job);
  }
  const t0 = Date.now(), prog = {}, kids = [];
  await Promise.all(jobs.map((job, w) => new Promise((ok, fail) => {
    const ch = spawn(process.execPath, [__filename, '--worker', path.join(work, `job${w + 1}.json`)], { stdio: ['ignore', 'pipe', 'inherit'] });
    kids.push(ch);
    let line = '';
    ch.stdout.on('data', (d) => {
      line += d;
      let k;
      while ((k = line.indexOf('\n')) >= 0) {
        const l = line.slice(0, k); line = line.slice(k + 1);
        try { const m = JSON.parse(l); prog[m.name] = m; } catch (e) { console.log(l); continue; }
        const done = Object.values(prog).reduce((s, m) => s + m.done, 0), s = (Date.now() - t0) / 1000;
        process.stdout.write(`\rframes ${done}/${frames}  ${(done / s).toFixed(1)} a second  about ${Math.ceil((frames - done) / (done / s) / 60)} min left   `);
      }
    });
    ch.on('close', (code) => code ? fail(new Error(`renderer ${job.name} failed (${code})`)) : ok());
  }))).catch((e) => { kids.forEach((k) => k.kill()); throw e; });
  process.stdout.write('\n');

  // join, add the sound, check
  const audio = ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', out];
  if (raw) {                                                         // x264 segments: joined as they are
    fs.writeFileSync(path.join(work, 'list.txt'), jobs.map((j) => `file '${path.basename(j.file)}'`).join('\n') + '\n');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'list.txt'),
      '-i', path.join(work, 'sound.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...audio], { stdio: 'inherit' });
  } else {                                                           // the page's H.264: one x264 pass
    console.log(`encoding the final file (x264 ${o.preset})`);
    execFileSync('ffmpeg', ['-v', 'error', '-stats', '-y', '-f', 'h264', '-framerate', String(o.fps),
      '-i', 'concat:' + jobs.map((j) => j.file).join('|'), '-i', path.join(work, 'sound.wav'), '-map', '0:v', '-map', '1:a',
      '-vf', `fade=t=out:st=${(total - 1).toFixed(4)}:d=1,` +
        'scale=in_range=pc:in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p',
      '-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-profile:v', 'high', '-x264-params', 'aq-mode=3',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', ...audio], { stdio: 'inherit' });
  }
  const nb = +execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', out]).toString().trim();
  if (nb !== frames) console.log(`warning: the file has ${nb} frames, expected ${frames}`);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'default=nw=1', out]).toString();
  const sync = syncCheck(out, noteTimes, sound);
  console.log(`wrote ${out}\n${probe.trim().replace(/\n/g, ', ')}`);
  console.log(`sound in the file against the sound rendered: ${sync.lag} ms`);
  if (Math.abs(sync.lag) > 1) console.log('warning: muxing moved the sound; check the file');
  if (sync.voices.length) console.log('the sound rises most this long after the ball lands: ' +
    sync.voices.map((v, i) => `${v.best} ms over ${v.used} notes`).join(', ') +
    (sync.agree ? '' : ' (the voices disagree: this music has notes without clear attacks)'));
  if (sync.agree && Math.abs(sync.best) > 45) console.log('warning: the voices agree on a lag viewers may notice; check the file');
  if (!a.keep) fs.rmSync(work, { recursive: true, force: true });
  if (site) site.srv.close();
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });
module.exports = { openPage, fullScreen, renderSound, serveSite, syncCheck };
