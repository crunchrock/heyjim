// Tiny static server for UI testing: serves docs/ at http://localhost:8787 and the generated test pages from ./out.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)), DOCS = path.resolve(HERE, '../../../docs'), OUT = path.join(HERE, 'out');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.enc': 'application/octet-stream', '.txt': 'text/plain' };
http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/_') ? path.join(OUT, p.slice(1)) : path.join(DOCS, p);
  fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream' }); r.end(b); });
}).listen(+process.env.PORT || 8787);
