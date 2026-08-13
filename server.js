// server.js — run this alongside snap-filter.html
//   node server.js
// Then open http://localhost:8080 (or your tunnel URL pointing at this port).
//
// What it does:
//  - Serves snap-filter.html
//  - Receives recording chunks at POST /upload (one session = one recording)
//  - Merges a session's chunks into one file at POST /finalize (called when the
//    person taps Stop) OR automatically, if a session goes quiet for >12s with
//    no heartbeat — this is the safety net for a phone locking / tab closing /
//    browser being killed, since JS "unload" events aren't reliable on mobile.
//  - Deletes the individual chunk files once merged, keeping only the final video.
//
// Storage layout:
//   ./recordings/<sessionId>/chunk-000.webm, chunk-001.webm, ...   (while recording)
//   ./recordings/<sessionId>.webm                                  (after merge)
//
// Sessions are named by a random session ID + timestamp, not by visitor IP —
// intentionally, since an IP-keyed folder structure is a fingerprinting pattern
// with no real benefit here. If you have a genuine, disclosed reason to tag
// recordings by visitor, do it with a session/consent record, not raw IPs.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const REC_DIR = path.join(ROOT, 'recordings');
const MODEL_DIR = path.join(ROOT, 'models');
const FACE_API_FILE = path.join(ROOT, 'face-api.min.js');
const HEARTBEAT_TIMEOUT_MS = 12000;
const SWEEP_INTERVAL_MS = 4000;

// ---- Shared-secret access token ----
// Anyone with your tunnel URL can otherwise hit /upload and write files to
// your disk, since the free Cloudflare quick-tunnel URL has no auth of its
// own. This token gates the page itself and every write endpoint.
//
// Set SNAP_TOKEN in the environment to pin a token across restarts
// (e.g. `SNAP_TOKEN=mysecret node server.js`). Otherwise a fresh random
// token is generated each time you start the server, and only people you
// share the printed URL with can use it.
const AUTH_TOKEN = process.env.SNAP_TOKEN || crypto.randomBytes(12).toString('hex');

function tokenFromRequest(req, parsedUrl, bodyToken) {
  return (
    req.headers['x-auth-token'] ||
    parsedUrl.searchParams.get('key') ||
    bodyToken ||
    null
  );
}

function tokenOk(req, parsedUrl, bodyToken) {
  const t = tokenFromRequest(req, parsedUrl, bodyToken);
  return typeof t === 'string' && crypto.timingSafeEqual(
    Buffer.from(t.padEnd(64, '0')),
    Buffer.from(AUTH_TOKEN.padEnd(64, '0'))
  ) && t === AUTH_TOKEN;
}

if (!fs.existsSync(REC_DIR)) fs.mkdirSync(REC_DIR);
if (!fs.existsSync(MODEL_DIR)) fs.mkdirSync(MODEL_DIR);

// in-memory session tracking: sessionId -> { lastSeen, chunkCount }
const sessions = new Map();
// finalized sessions (merged) tracked to reject late uploads
const finalized = new Set();

// merging locks to prevent concurrent merge runs for the same session
const merging = new Set();

// initialize finalized set from any already-merged .webm files
try{
  for (const f of fs.readdirSync(REC_DIR)){
    if (f.endsWith('.webm')) finalized.add(path.basename(f, '.webm'));
  }
}catch(e){ /* ignore */ }

// cleanup any leftover .finalized marker files (they are no longer used)
try{
  for (const f of fs.readdirSync(REC_DIR)){
    if (f.endsWith('.finalized')) {
      try { fs.unlinkSync(path.join(REC_DIR, f)); } catch(e) { /* ignore */ }
    }
  }
}catch(e){/* ignore */}

function safeSessionId(id) {
  // sessionIds come from the client (crypto.randomUUID or a fallback) — validate
  // strictly so nobody can path-traverse via a crafted X-Session-Id header.
  if (typeof id !== 'string') return null;
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) return null;
  const dir = path.resolve(REC_DIR, id);
  const safeRoot = path.resolve(REC_DIR) + path.sep;
  if (!dir.startsWith(safeRoot)) return null;
  return id;
}

function sessionDir(id) {
  return path.join(REC_DIR, id);
}

function safeModelPath(urlPath) {
  if (typeof urlPath !== 'string') return null;
  const stripped = urlPath.replace(/^[/\\]+/, '');
  const segments = stripped.split(/[/\\]+/);
  if (segments.includes('..')) return null;
  const resolved = path.resolve(MODEL_DIR, ...segments);
  const safeRoot = path.resolve(MODEL_DIR) + path.sep;
  if (!resolved.startsWith(safeRoot)) return null;
  return resolved;
}

function modelMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.bin') return 'application/octet-stream';
  if (ext === '.weights') return 'application/octet-stream';
  if (ext === '.dat') return 'application/octet-stream';
  return 'application/octet-stream';
}

function touchSession(id) {
  const s = sessions.get(id) || { lastSeen: 0, chunkCount: 0 };
  s.lastSeen = Date.now();
  sessions.set(id, s);
}

function mergeSession(id) {
  const dir = sessionDir(id);
  if (!fs.existsSync(dir)) return;

  const outPath = path.join(REC_DIR, `${id}.webm`);

  // If a final file already exists for this session, clean up any stray
  // chunk files and mark the session finalized — do not overwrite the final.
  if (fs.existsSync(outPath)) {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('chunk-')).sort();
    for (const f of files) {
      try { fs.unlinkSync(path.join(dir, f)); } catch(e) { /* ignore */ }
    }
    try { fs.rmdirSync(dir); } catch(e) { /* ignore */ }
    sessions.delete(id);
    finalized.add(id);
    // previously wrote a .finalized marker file here; no longer needed
    console.log(`[merged] final exists for ${id}, cleaned up ${files.length} chunks`);
    return;
  }

  // Prevent concurrent merges for the same session
  if (merging.has(id)) return;
  merging.add(id);
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('chunk-'))
      .sort(); // chunk-000, chunk-001... sorts correctly since zero-padded

    if (files.length === 0) {
      try { fs.rmdirSync(dir); } catch(e) { /* ignore */ }
      sessions.delete(id);
      return;
    }

    const tmpOut = outPath + '.tmp';
    let written = 0;
    let outFd;

    try {
      outFd = fs.openSync(tmpOut, 'w');
      for (const f of files) {
        const p = path.join(dir, f);
        try {
          const buf = fs.readFileSync(p);
          fs.writeSync(outFd, buf);
          written++;
        } catch (e) {
          // missing chunk or read error; skip this chunk and continue
          console.warn(`[merge] skipping missing/errored chunk for ${id}: ${f}`);
        }
      }
    } catch (e) {
      if (outFd !== undefined) {
        try { fs.closeSync(outFd); } catch(_) {}
      }
      try { fs.unlinkSync(tmpOut); } catch(_) {}
      throw e;
    }

    if (outFd !== undefined) {
      try { fs.closeSync(outFd); } catch(_) {}
    }

    // if nothing was written, just clean up and exit
    if (written === 0) {
      try { fs.unlinkSync(tmpOut); } catch(e) { /* ignore */ }
      try { fs.rmdirSync(dir); } catch(e) { /* ignore */ }
      sessions.delete(id);
      return;
    }

    if (!fs.existsSync(tmpOut)) {
      console.warn(`[merge] temp output missing for ${id}, aborting merge`);
      try { fs.rmdirSync(dir); } catch(e) { /* ignore */ }
      sessions.delete(id);
      return;
    }

    // rename tmp to final atomically
    try { fs.renameSync(tmpOut, outPath); } catch(e) {
      // if rename failed, remove tmp and abort
      try { fs.unlinkSync(tmpOut); } catch(_) {}
      throw e;
    }

    // delete the individual chunks now that they're merged
    for (const f of files) try { fs.unlinkSync(path.join(dir, f)); } catch(e) { /* ignore */ }
    try { fs.rmdirSync(dir); } catch(e) { /* ignore */ }
    sessions.delete(id);

    // mark finalized so late uploads are rejected
    finalized.add(id);
    // previously wrote a .finalized marker file here; no longer needed

    console.log(`[merged] ${id} -> ${outPath} (${written} chunks)`);
  } finally {
    merging.delete(id);
  }
}

// Safety net: if a session's heartbeat/chunks go quiet (tab closed, phone
// locked, browser killed) finalize it automatically instead of leaving
// orphaned chunk files.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      console.log(`[timeout] finalizing inactive session ${id}`);
      mergeSession(id);
    }
  }
}, SWEEP_INTERVAL_MS);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let finished = false;

    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    }

    function onData(c) {
      chunks.push(c);
    }

    function onEnd() {
      finished = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function onClose() {
      if (!finished) {
        cleanup();
        reject(new Error('request closed before body was complete'));
      }
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

function readJson(req) {
  return readBody(req).then(buf => {
    try { return JSON.parse(buf.toString('utf8') || '{}'); }
    catch { return {}; }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/snap-filter.html')) {
      if (!tokenOk(req, parsedUrl)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Access token missing or invalid. Use the full URL with ?key=... that was printed when the server started.');
        return;
      }
      let html = fs.readFileSync(path.join(ROOT, 'snap-filter.html'), 'utf8');
      // Hand the page its token so client-side JS can attach it to
      // /upload, /heartbeat and /finalize calls without it living in
      // localStorage or being guessable.
      html = html.replace('__AUTH_TOKEN__', AUTH_TOKEN);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (req.method === 'POST' && pathname === '/upload') {
      if (!tokenOk(req, parsedUrl)) { res.writeHead(401); res.end('unauthorized'); return; }

      const id = safeSessionId(req.headers['x-session-id']);
      const idx = parseInt(req.headers['x-chunk-index'], 10);
      if (!id || Number.isNaN(idx)) { res.writeHead(400); res.end('bad session/index'); return; }

      // refuse uploads for sessions that have already been finalized
      const finalPath = path.join(REC_DIR, `${id}.webm`);
      if (finalized.has(id) || fs.existsSync(finalPath)) {
        res.writeHead(410); res.end('session finalized'); return;
      }

      const dir = sessionDir(id);
      try { fs.mkdirSync(dir, { recursive: true }); } catch(e) { /* ignore */ }

      const body = await readBody(req);
      const chunkName = `chunk-${String(idx).padStart(4, '0')}.webm`;
      fs.writeFileSync(path.join(dir, chunkName), body);

      touchSession(id);
      const s = sessions.get(id);
      s.chunkCount++;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, saved: chunkName }));
      return;
    }

    if (req.method === 'POST' && pathname === '/heartbeat') {
      const body = await readJson(req);
      if (!tokenOk(req, parsedUrl, body.token)) { res.writeHead(401); res.end('unauthorized'); return; }
      const id = safeSessionId(body.sessionId);
      if (id && sessions.has(id)) touchSession(id);
      res.writeHead(200); res.end('ok');
      return;
    }

    if (req.method === 'POST' && pathname === '/finalize') {
      const body = await readJson(req);
      if (!tokenOk(req, parsedUrl, body.token)) { res.writeHead(401); res.end('unauthorized'); return; }
      const id = safeSessionId(body.sessionId);
      if (id) {
        const finalPath = path.join(REC_DIR, `${id}.webm`);
        if (finalized.has(id) || fs.existsSync(finalPath)) {
          res.writeHead(200); res.end('ok'); return;
        }
        mergeSession(id);
      }
      res.writeHead(200); res.end('ok');
      return;
    }

    if (req.method === 'GET' && pathname === '/face-api.min.js') {
      if (!fs.existsSync(FACE_API_FILE) || !fs.statSync(FACE_API_FILE).isFile()) {
        res.writeHead(404); res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      const stream = fs.createReadStream(FACE_API_FILE);
      stream.pipe(res);
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/models/')) {
      const modelName = pathname.slice('/models/'.length);
      const filePath = safeModelPath(modelName);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404); res.end('not found');
        return;
      }
      const mimeType = modelMimeType(filePath);
      res.writeHead(200, { 'Content-Type': mimeType });
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      return;
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end('server error');
  }
});

server.listen(PORT, () => {
  console.log(`Snap Web server running: http://localhost:${PORT}`);
  console.log(`Recordings will be saved to: ${REC_DIR}`);
  console.log('');
  console.log(`Access URL (share only this): http://localhost:${PORT}/?key=${AUTH_TOKEN}`);
  console.log('When tunneling, swap the host for your tunnel URL but keep the ?key=... part.');
  console.log('Set SNAP_TOKEN=yourvalue as an env var to pin this token across restarts.');
});
