// Loopback sink for a live sweep driven from the real browser.
// Each route/date result is written to .sweep/<iso>-<dest>.json so the board can
// be rendered from genuine fares without any of it passing through the transcript.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';

mkdirSync('.sweep', { recursive: true });

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
        writeFileSync(`.sweep/${rec.iso}-${rec.dest}.json`, JSON.stringify(rec));
        const gw = (rec.flights || []).filter((f) => f.enabled && f.gw > 0).length;
        console.log(`[sink] ${rec.iso} ${rec.dest.padEnd(3)} status=${rec.status} flights=${(rec.flights || []).length} gw=${gw} blocked=${rec.blocked} err=${rec.error || '-'} (${count()}/28)`);
      } catch (e) {
        console.log(`[sink] bad row: ${e.message}`);
      }
    } else if (req.url === '/done') {
      writeFileSync('.sweep/_done', body || 'done');
      console.log(`[sink] DONE ${body}`);
    }
    res.statusCode = 200;
    res.end('ok');
  });
});

srv.listen(8902, '127.0.0.1', () => console.log('[sink] listening on 127.0.0.1:8902'));
