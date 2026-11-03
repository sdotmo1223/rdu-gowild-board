// Loopback receiver: the browser POSTs document.cookie here and we write it
// straight into the gitignored .dev.vars. The value never enters the transcript.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const srv = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const value = body.trim().replace(/\s+/g, ' ');
    if (req.url.startsWith('/save') && value) {
      writeFileSync('.dev.vars', `FRONTIER_COOKIE=${value}\n`);
      const names = value.split(';').map((p) => p.split('=')[0].trim()).filter(Boolean);
      console.log(`[capture] wrote .dev.vars len=${value.length} cookies=${names.length}`);
      console.log(`[capture] names only: ${names.join(',')}`);
    } else {
      console.log(`[capture] ignored ${req.url} len=${body.length}`);
    }
    res.statusCode = 200;
    res.end('ok');
  });
});

srv.listen(8899, '127.0.0.1', () => console.log('[capture] listening on 127.0.0.1:8899'));
