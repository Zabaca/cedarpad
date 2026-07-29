// End-to-end smoke test for the Console PTY server: connect, run a command, resize,
// verify the shell saw the new geometry, then verify TAKEOVER supersedes the first
// socket. Exits non-zero on failure so it can gate a change.
//
//   node smoke.mjs            (expects a server already on CANVAS_PTY_PORT)
import { WebSocket } from 'ws';

const PORT = Number(process.env.CANVAS_PTY_PORT ?? 4514);
const url = (cols, rows) => `ws://localhost:${PORT}/?cols=${cols}&rows=${rows}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const open = (u) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(u);
    const out = { text: '', control: [], ws, closed: null };
    ws.on('message', (d, isBinary) => {
      if (isBinary) out.text += d.toString('utf8');
      else out.control.push(JSON.parse(d.toString()));
    });
    ws.on('close', (code) => { out.closed = code; });
    ws.on('open', () => resolve(out));
    ws.on('error', reject);
  });

const type = (c, s) => c.ws.send(Buffer.from(s + '\r', 'utf8'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// 1. Connect at 100x30 and confirm the PTY was SPAWNED at that geometry (not 80x24
//    then corrected — the ceo POC's bug).
const a = await open(url(100, 30));
await wait(400);
type(a, 'echo SPAWN=$(stty size)');
await wait(500);
const spawnSize = (a.text.match(/SPAWN=(\d+ \d+)/) ?? [])[1];
check('spawns at client geometry', spawnSize === '30 100', `got ${spawnSize}, want "30 100"`);

// 2. Resize over the control channel → the shell must see it (real TIOCSWINSZ).
a.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
await wait(300);
type(a, 'echo AFTER=$(stty size)');
await wait(500);
const afterSize = (a.text.match(/AFTER=(\d+ \d+)/) ?? [])[1];
check('resize reaches the shell', afterSize === '40 120', `got ${afterSize}, want "40 120"`);

// 3. A pasted JSON payload must reach the shell as TEXT, not be parsed as control.
//    (Binary framing is what makes this safe; the ceo POC sniffs a leading `{`.)
a.text = '';
type(a, 'echo {"type":"resize","cols":1,"rows":1}');
await wait(500);
type(a, 'echo STILL=$(stty size)');
await wait(500);
const still = (a.text.match(/STILL=(\d+ \d+)/) ?? [])[1];
check('pasted JSON is not control', still === '40 120', `got ${still}, want "40 120" (unresized)`);

// 4. Takeover: a second connection supersedes the first, and the first is TOLD.
const b = await open(url(90, 25));
await wait(400);
const told = a.control.some((m) => m.type === 'superseded');
check('previous socket told it was superseded', told, `control frames: ${JSON.stringify(a.control)}`);
check('previous socket closed', a.closed === 4000, `close code ${a.closed}`);

// 5. The takeover replays scrollback, so the new socket sees prior output.
check('replays scrollback on reattach', b.text.includes('SPAWN='), `${b.text.length} bytes replayed`);

// 6. ...and the SAME shell is still alive (state survived the takeover).
b.text = '';
type(b, 'echo REATTACHED=$(stty size)');
await wait(600);
const reSize = (b.text.match(/REATTACHED=(\d+ \d+)/) ?? [])[1];
check('same PTY survives, adopts new geometry', reSize === '25 90', `got ${reSize}, want "25 90"`);

b.ws.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
