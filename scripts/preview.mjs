#!/usr/bin/env node
/**
 * Serve docs/ locally so you can check the site before pushing.
 *
 *   npm run preview   ->  http://localhost:8080
 *
 * Listens on every interface, so you can also open it on your phone using the
 * LAN address it prints — which is the only honest way to check the layout.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const PORT = Number(process.env.PORT ?? 8080);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = requested.endsWith('/') ? `${requested}index.html` : requested;

  // Resolve inside docs/ and refuse anything that escapes it.
  const filePath = path.join(ROOT, path.normalize(relative));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(PORT, () => {
  const lan = lanAddress();
  process.stdout.write(`\nServing docs/ at http://localhost:${PORT}\n`);
  if (lan) process.stdout.write(`On your phone (same Wi-Fi): http://${lan}:${PORT}\n`);
  process.stdout.write('\nPress Ctrl+C to stop.\n');
});
