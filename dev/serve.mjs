// Servidor só pra testar a interface no navegador, com o backend simulado (dev/mock.js).
// Uso: node dev/serve.mjs  →  http://localhost:5544  (?vazio pra ver a tela inicial)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const devDir = import.meta.dirname;
const srcDir = path.resolve(devDir, '..', 'src');
const port = Number(process.env.PORT) || 5544;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = url.startsWith('/__mock/') ? path.join(devDir, url.slice(8)) : path.join(srcDir, url);
  if (!file.startsWith(devDir) && !file.startsWith(srcDir)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    if (url === '/index.html') {
      data = Buffer.from(data.toString().replace('<script src="app.js"></script>', '<script src="/__mock/mock.js"></script>'));
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, () => console.log(`Acervo (mock) em http://localhost:${port}`));
