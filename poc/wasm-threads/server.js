#!/usr/bin/env node
// Minimal static file server that sends the COOP/COEP headers required for
// SharedArrayBuffer / real WASM threads. GitHub Pages (where OrcaWeb's app
// is deployed today) cannot send custom response headers, so this stands in
// for an alternative host (Cloudflare Pages, Netlify, a small Node/Express
// server, etc.) that can.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'public');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);

  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Required for crossOriginIsolated -> SharedArrayBuffer -> real WASM threads.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`WASM threads PoC running at http://localhost:${PORT}`);
  console.log('Serving with COOP/COEP headers -> crossOriginIsolated should read true in the browser.');
});
