// The Console's PTY host (ADR-0021). ONE PTY per container — the Console is
// singular per workspace, so there is no session map and no session id.
//
// Runs under `node`, never `bun`, and is installed with `npm`, never `bun install`.
// Both constraints are measured, not preferences — see README.md before changing either.
//
// The edge owns authorization entirely: reaching this port at all means the Worker
// already proved the caller is the workspace OWNER. Nothing here re-checks, because
// nothing here can — it has no session, no DB, no identity. Do not add a "gate" here
// and mistake it for one.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const PORT = Number(process.env.CANVAS_PTY_PORT ?? 4514);
// The shell the Console runs. bash (not `claude` directly) so Ctrl-C returns to a
// prompt instead of killing the Console, and so the operator can poke at the
// container — half the point of an operator surface.
const SHELL = process.env.CONSOLE_SHELL ?? 'bash';
// Typed into the shell on a FRESH spawn only (never on reattach), with a trailing CR
// so it runs interactively: it shows in scrollback and history, Ctrl-C still works,
// and the prompt returns when it exits. Empty ⇒ a bare shell (local dev, where there
// may be no authenticated claude).
const LAUNCH = process.env.CONSOLE_LAUNCH ?? '';
const CWD = process.env.CANVAS_CWD ?? process.cwd();
// Bytes of recent output retained for replay on reattach. The Console's socket is
// released on idle/dismiss, so reattaching is routine, not exceptional.
const SCROLLBACK = 200_000;

/** @type {{proc: import('node-pty').IPty, buf: string, ws: import('ws').WebSocket | null} | null} */
let session = null;

const send = (ws, obj) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
};

function spawnSession(cols, rows) {
  const proc = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    // Spawn at the CLIENT's geometry. The ceo POC hardcodes 80x24 and lets the first
    // resize correct it, so the TUI draws its opening frames at the wrong width and
    // then reflows — visible garbage on every cold open.
    cols,
    rows,
    cwd: CWD,
    env: process.env,
  });
  const s = { proc, buf: '', ws: null };
  proc.onData((d) => {
    s.buf = (s.buf + d).slice(-SCROLLBACK);
    if (s.ws && s.ws.readyState === 1) s.ws.send(Buffer.from(d, 'utf8'));
  });
  proc.onExit(({ exitCode }) => {
    if (s.ws) send(s.ws, { type: 'exit', exitCode });
    if (session === s) session = null;
  });
  session = s;
  if (LAUNCH) proc.write(`${LAUNCH}\r`);
  return s;
}

const clamp = (v, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 && n < 10000 ? n : fallback;
};

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, live: session !== null }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const cols = clamp(q.get('cols'), 80);
  const rows = clamp(q.get('rows'), 24);

  const fresh = session === null;
  const s = session ?? spawnSession(cols, rows);

  // Explicit takeover. The ceo POC just reassigns its single socket, leaving the
  // previous tab connected but permanently mute with no way to know why. Tell it,
  // then close it — the Console is singular by design (ADR-0021 decision 7).
  if (s.ws && s.ws !== ws) {
    send(s.ws, { type: 'superseded' });
    try {
      s.ws.close(4000, 'superseded');
    } catch {
      /* already gone */
    }
  }
  s.ws = ws;

  // An existing PTY keeps the geometry of whoever holds it; a reattaching client is
  // the sole viewer now, so adopt its size before replaying into it.
  if (!fresh) {
    try {
      s.proc.resize(cols, rows);
    } catch {
      /* dead pty; onExit will clear it */
    }
    if (s.buf) ws.send(Buffer.from(s.buf, 'utf8'));
  }

  ws.on('message', (data, isBinary) => {
    // Binary = keystrokes, text = JSON control. Framed by TYPE so a pasted JSON
    // payload can never be mistaken for a control message.
    if (isBinary) {
      s.proc.write(data.toString('utf8'));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // malformed control frame — ignore, never write it to the shell
    }
    if (msg.type === 'resize') {
      try {
        s.proc.resize(clamp(msg.cols, 80), clamp(msg.rows, 24));
      } catch {
        /* dead pty */
      }
    }
  });

  ws.on('close', () => {
    // Keep the PTY alive: the socket is released on dismiss/idle by design, and the
    // shell (with its scrollback, cwd, and running process) must survive that.
    if (s.ws === ws) s.ws = null;
  });
});

server.listen(PORT, () => console.log(`[console] pty-server on http://localhost:${PORT}`));
