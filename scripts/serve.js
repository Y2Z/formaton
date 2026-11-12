// Minimal static server for the demo: node scripts/serve.js [port]
// PORT and HOST can also come from the environment (the Docker image sets HOST=0.0.0.0).
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json', '.css': 'text/css' };
const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';

createServer(async (req, res) => {
  let path = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  if (path.endsWith('/')) path += 'index.html';
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, host, () => console.log(`formaton demo: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/demo/`));
