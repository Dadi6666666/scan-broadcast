'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createApp } = require('./app');

async function createStore(options = {}) {
  const driver = options.storageDriver || process.env.STORAGE_DRIVER || 'sqlite';
  if (driver === 'cloudbase') return require('./cloudbase-store').createCloudBaseStore(options);
  if (driver !== 'sqlite') throw new Error('STORAGE_DRIVER 只能是 sqlite 或 cloudbase');
  // Never create a SQLite database in an ephemeral cloud function container.
  if (process.env.SCF_FUNCTIONNAME || process.env.TENCENTCLOUD_RUNENV) throw new Error('云函数必须使用 STORAGE_DRIVER=cloudbase');
  return new (require('./sqlite-store').SQLiteStore)(options.dbPath || process.env.DB_PATH || path.join(__dirname, 'data', 'scan-broadcast.sqlite'));
}

async function buildApp(options = {}) {
  const store = options.store || await createStore(options);
  return createApp({ ...options, store, storageDriver: options.storageDriver || process.env.STORAGE_DRIVER || 'sqlite' });
}

async function createServer(options = {}) {
  const app = await buildApp(options);
  const staticRoot = path.resolve(options.staticRoot || path.join(__dirname, '..'));
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ico': 'image/x-icon' };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 750000) { res.writeHead(413); res.end('Request too large'); return; }
          chunks.push(chunk);
        }
        const secure = Boolean(req.socket.encrypted || process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https');
        const response = await app.handle({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), secure, origin: (secure ? 'https://' : 'http://') + req.headers.host });
        res.writeHead(response.status, response.headers);
        res.end(response.body);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      let file = decodeURIComponent(url.pathname);
      if (file === '/' || file === '/scan-broadcast/') file = '/index.html';
      if (file === '/admin') file = '/admin.html';
      // Source, tests, databases, deployment settings and hidden files must not be served.
      const parts = file.split('/').filter(Boolean);
      if (parts.some(part => part.startsWith('.')) || parts.some(part => ['server', 'tests', 'node_modules'].includes(part))) throw new Error('not found');
      const absolute = path.resolve(staticRoot, '.' + file);
      const type = mime[path.extname(absolute)];
      if (!absolute.startsWith(staticRoot + path.sep) || !type) throw new Error('not found');
      const data = await fs.readFile(absolute);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': /\.(html|js)$/.test(file) ? 'no-cache' : 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (_) { res.writeHead(404); res.end('Not found'); }
  });
  server.requestTimeout = 15000;
  return { server, app, async close() { await new Promise(resolve => server.close(resolve)); await app.close(); } };
}

// SCF API Gateway / CloudBase HTTP-trigger event adapter. SQLite is never imported here.
let cloudApp;
async function main(event, context) {
  if (!cloudApp) {
    cloudApp = buildApp({ storageDriver: 'cloudbase', context }).catch(err => { cloudApp = null; throw err; });
  }
  try {
    const app = await cloudApp;
    const query = new URLSearchParams(event.queryStringParameters || event.queryString || {}).toString();
    let rawPath = event.rawPath || event.path || '/';
    // CloudBase's /api gateway strips its matched prefix before invoking SCF.
    if (rawPath !== '/api' && !rawPath.startsWith('/api/')) rawPath = '/api' + rawPath;
    const url = rawPath + (query && !rawPath.includes('?') ? '?' + query : '');
    const headers = event.headers || {};
    const host = headers.host || headers.Host || '';
    const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
    const response = await app.handle({ method: event.httpMethod || event.requestContext?.http?.method || 'GET', url, headers, body, secure: true, origin: 'https://' + host });
    const binary = Buffer.isBuffer(response.body);
    return { statusCode: response.status, headers: response.headers, body: binary ? response.body.toString('base64') : response.body, isBase64Encoded: binary };
  } catch (_) {
    return { statusCode: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: false, error: '后台存储尚未就绪，请检查云端配置' }), isBase64Encoded: false };
  }
}

if (require.main === module) {
  createServer().then(({ server }) => {
    const port = Number(process.env.PORT || 8787);
    server.listen(port, process.env.HOST || '127.0.0.1', () => console.log('Scan broadcast listening on port ' + port));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { createServer, buildApp, main };
