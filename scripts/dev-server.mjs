#!/usr/bin/env node
// Local dev server: serves site/ as-is and relays everything else to the real
// bucket and Lambda, so uncommitted changes run end to end without a deploy.
//   node scripts/dev-server.mjs [port]          (default 8080)
//   THROTTLE_KBPS=2000 node scripts/dev-server.mjs   — simulate a slow uplink
// Phone over USB: adb reverse tcp:8080 tcp:8080, then open
// http://localhost:8080/index.html#<login>/<key> (localhost = secure context).
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { join, extname, normalize } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SITE = join(ROOT, 'site');
const PORT = Number(process.argv[2] ?? 8080);
const REGION = process.env.REGION ?? 'eu-west-3';
const BUCKET = process.env.BUCKET ?? (await readFile(join(ROOT, '.bucket'), 'utf8')).trim();
const LAMBDA_URL = (await readFile(join(ROOT, '.lambda-url'), 'utf8')).trim();
const S3_ORIGIN = `https://${BUCKET}.s3.${REGION}.amazonaws.com`;
const THROTTLE_KBPS = Number(process.env.THROTTLE_KBPS ?? 0);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const SITE_FILES = new Set(['/index.html', '/style.css', '/app.js', '/lib.js', '/favicon.svg', '/favicon.png']);

// Upload bandwidth cap (kbit/s), applied to PUT bodies only.
function throttle() {
  const bytesPerMs = (THROTTLE_KBPS * 1000) / 8 / 1000;
  return new Transform({
    transform(chunk, _enc, done) {
      setTimeout(() => done(null, chunk), chunk.length / bytesPerMs);
    },
  });
}

// Pipes req to target, forwarding only the given request headers.
function relay(req, res, target, headerNames, { body = req, rewrite } = {}) {
  const url = new URL(target);
  const headers = {};
  for (const name of headerNames) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = send(url, { method: req.method, headers }, async (up) => {
    if (!rewrite) {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
      return;
    }
    const chunks = [];
    for await (const c of up) chunks.push(c);
    const text = rewrite(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(up.statusCode, { 'content-type': up.headers['content-type'] ?? 'application/json' });
    res.end(text);
  });
  upstream.on('error', (err) => {
    console.error(`relay ${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  if (typeof body === 'string') upstream.end(body);
  else body.pipe(upstream);
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const started = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.url.slice(0, 90)} → ${res.statusCode} (${Date.now() - started} ms)`));

  if (req.method === 'GET' && (pathname === '/' && !req.url.includes('list-type'))) {
    res.writeHead(302, { location: '/index.html' });
    res.end();
    return;
  }
  if (req.method === 'GET' && pathname === '/config.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-cache' });
    res.end("window.CUMULUS_CONFIG = { lambdaUrl: '/__lambda' };\n");
    return;
  }
  if (req.method === 'GET' && SITE_FILES.has(pathname)) {
    const file = await readFile(join(SITE, normalize(pathname)));
    res.writeHead(200, { 'content-type': TYPES[extname(pathname)], 'cache-control': 'no-cache' });
    res.end(file);
    return;
  }
  // Lambda: pre-signed URLs point at the bucket origin; made relative so the
  // browser PUTs through this server (the signature covers path + query + the
  // S3 host, which the relay below restores).
  if (req.method === 'POST' && pathname === '/__lambda') {
    relay(req, res, LAMBDA_URL, ['content-type', 'content-length'], {
      rewrite: (text) => text.replaceAll(S3_ORIGIN, ''),
    });
    return;
  }
  if (req.method === 'GET' && (pathname.startsWith('/projects/') || req.url.startsWith('/?list-type'))) {
    relay(req, res, S3_ORIGIN + req.url, ['range']);
    return;
  }
  if (req.method === 'PUT' && pathname.startsWith('/projects/')) {
    const body = THROTTLE_KBPS > 0 ? req.pipe(throttle()) : req;
    relay(req, res, S3_ORIGIN + req.url,
      ['content-type', 'content-length', 'content-disposition', 'if-none-match'], { body });
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, () => {
  console.log(`Cumulus dev → http://localhost:${PORT}/index.html (bucket ${BUCKET})`);
  if (THROTTLE_KBPS > 0) console.log(`Upload throttled to ${THROTTLE_KBPS} kbit/s`);
});
