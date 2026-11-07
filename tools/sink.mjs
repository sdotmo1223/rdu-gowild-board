// Loopback sink for a live sweep driven from the real browser.
// Each route/date result is written to .sweep/<iso>-<dest>.json so the board can
// be rendered from genuine fares without any of it passing through the transcript.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';

mkdirSync('.sweep', { recursive: true });

// The port is the caller's decision, not a constant: `test/sink.mjs` hands the sink a
// free one, so the suite can never grade a sink left running by a live sweep.
const rawPort = process.env.SINK_PORT;
const PORT = rawPort === undefined || rawPort === '' ? 8902 : Number(rawPort);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.log(`[sink] SINK_PORT=${rawPort} is not a port`);
  process.exit(1);
}

const count = () => readdirSync('.sweep').filter((f) => f.endsWith('.json')).length;

const srv = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/row') {
      try {
        const rec = JSON.parse(body);
        if (!rec || typeof rec !== 'object' || Array.isArray(rec) || !rec.iso || !rec.dest) {
          throw new Error('invalid record');
        }
        writeFileSync(`.sweep/${rec.iso}-${rec.dest}.json`, JSON.stringify(rec));
        const gw = (rec.flights || []).filter((f) => f.enabled && f.gw > 0).length;
        console.log(`[sink] ${rec.iso} ${rec.dest.padEnd(3)} status=${rec.status} flights=${(rec.flights || []).length} gw=${gw} blocked=${rec.blocked} err=${rec.error || '-'} (${count()}/28)`);
        res.statusCode = 200;
        res.end('ok');
      } catch (e) {
        console.log(`[sink] bad row: ${e.message}`);
        res.statusCode = 400;
        res.end('bad request');
      }
    } else if (req.url === '/done') {
      writeFileSync(`.sweep/_done`, body || 'done');
      console.log(`[sink] DONE ${body}`);
      res.statusCode = 200;
      res.end('ok');
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
});

srv.on('error', (e) => {
  console.log(`[sink] cannot listen on 127.0.0.1:${PORT}: ${e.message}`);
  process.exit(1);
});

srv.listen(PORT, '127.0.0.1', () => console.log(`[sink] listening on 127.0.0.1:${PORT}`));
