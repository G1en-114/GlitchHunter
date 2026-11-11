import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff': 'font/woff' };

export async function serveDirectory(root, port = 0) {
  const base = await realpath(root);
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const candidate = await realpath(resolve(base, '.' + (path.endsWith('/') ? path + 'index.html' : path)));
      if (!candidate.startsWith(base + sep)) throw new Error('Outside root');
      const body = await readFile(candidate);
      response.writeHead(200, { 'content-type': mime[extname(candidate)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())) };
}
