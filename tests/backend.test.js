'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');
const { DEFAULT_EVENT } = require('../server/defaults');

const TOKEN = 'test-only-admin-token-0123456789-abcdef';
const EVENT = DEFAULT_EVENT.eventId;

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dadi-backend-test-'));
  let now = Date.parse('2026-09-07T02:00:00Z');
  let running;
  let base;
  async function start() {
    running = await createServer({ dbPath: path.join(directory, 'records.sqlite'), adminToken: TOKEN, speakerSecret: 'test-stable-speaker-signing-key', clock: () => now, allowedOrigins: ['https://approved.example'] });
    await new Promise(resolve => running.server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + running.server.address().port;
  }
  await start();
  t.after(async () => { await running.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory,
    setTime(value) { now = value; },
    async restart() { await running.close(); await start(); },
    async request(route, { token, body, headers = {}, method = body ? 'POST' : 'GET' } = {}) {
      const response = await fetch(base + route, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const text = await response.text();
      let data; try { data = JSON.parse(text); } catch (_) { data = text; }
      return { status: response.status, data, headers: response.headers };
    }
  };
}

test('permanent activity and scan history survive reopen without browser storage', async t => {
  const f = await fixture(t);
  const before = await f.request('/api/events/' + EVENT);
  assert.equal(before.status, 200);
  assert.equal(before.data.target, DEFAULT_EVENT.target);
  const saved = await f.request('/api/events/' + EVENT + '/scans', { body: { nonce: 'scan-persistent-001', source: 'wechat', visitorId: 'visitor-001', createdAt: 1, ip: 'should-not-store', userAgent: 'sensitive-raw-ua' } });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.target, DEFAULT_EVENT.target);
  assert.equal(saved.data.scan.createdAt, Date.parse('2026-09-07T02:00:00Z'));
  f.setTime(Date.parse('2027-01-01T00:00:00Z'));
  await f.restart();
  assert.equal((await f.request('/api/events/' + EVENT)).data.target, DEFAULT_EVENT.target);
  const stats = await f.request('/api/admin/stats', { token: TOKEN });
  assert.equal(stats.data.summary.scanVisits, 1);
  assert.equal(stats.data.summary.uniqueVisitors, 1);
  const contents = await readFile(path.join(f.directory, 'records.sqlite'));
  assert.equal(contents.includes(Buffer.from('should-not-store')), false);
  assert.equal(contents.includes(Buffer.from('sensitive-raw-ua')), false);
});

test('concurrent same nonce is recorded exactly once and server acknowledgement is truthful', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 30 }, () => f.request('/api/events/' + EVENT + '/scans', { body: { nonce: 'concurrent-one-identity', source: 'alipay' } })));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.data.duplicate).length, 29);
  assert.equal(new Set(responses.map(response => response.data.scan.id)).size, 1);
  const stats = await f.request('/api/admin/stats', { token: TOKEN });
  assert.equal(stats.data.summary.scanVisits, 1);
  assert.equal(stats.data.summary.unidentifiedVisits, 1);
  assert.equal(stats.data.summary.uniqueVisitors, 0);
  assert.equal((await f.request('/api/events/' + EVENT + '/scans', { body: { nonce: 'rejected-source-001', source: 'raw-user-agent' } })).status, 400);
});

test('public readers cannot access statistics, records, settings, or scoped speaker credentials', async t => {
  const f = await fixture(t);
  for (const route of ['/api/admin/events', '/api/admin/stats', '/api/events/' + EVENT + '/scans']) assert.equal((await f.request(route)).status, 401);
  assert.equal((await f.request('/api/events', { body: { name: 'unauthorized' } })).status, 401);
  assert.equal((await f.request('/api/events/' + EVENT, { method: 'PATCH', body: { name: 'unauthorized' } })).status, 401);
  const config = await f.request('/api/events/' + EVENT);
  assert.equal('speakerToken' in config.data, false);
  assert.equal((await f.request('/api/admin/login', { body: { token: 'wrong' } })).status, 401);
  const login = await f.request('/api/admin/login', { body: { token: TOKEN } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.notEqual(login.data.sessionToken, TOKEN);
  assert.equal((await f.request('/api/admin/events', { token: login.data.sessionToken })).status, 200);
  await f.request('/api/admin/logout', { token: login.data.sessionToken, body: {} });
  assert.equal((await f.request('/api/admin/events', { token: login.data.sessionToken })).status, 401);
});

test('speaker token stays valid across restart and time, but is scoped to one event and cannot read admin data', async t => {
  const f = await fixture(t);
  const events = await f.request('/api/admin/events', { token: TOKEN });
  const token = events.data.events[0].speakerToken;
  const second = await f.request('/api/events', { token: TOKEN, body: { name: 'Second event' } });
  assert.equal((await f.request('/api/events/' + EVENT + '/scans?after=now', { token })).status, 200);
  assert.equal((await f.request('/api/admin/stats', { token })).status, 401);
  assert.equal((await f.request('/api/events/' + second.data.eventId + '/scans', { token })).status, 401);
  f.setTime(Date.parse('2030-01-01T00:00:00Z'));
  await f.restart();
  assert.equal((await f.request('/api/events/' + EVENT + '/scans?after=now', { token })).status, 200);
});

test('baseline excludes old scans, incremental pages do not drop new scans and playback acknowledgement is idempotent', async t => {
  const f = await fixture(t);
  await f.request('/api/events/' + EVENT + '/scans', { body: { nonce: 'before-start-001', source: 'web' } });
  const baseline = await f.request('/api/events/' + EVENT + '/scans?after=now', { token: TOKEN });
  assert.deepEqual(baseline.data.scans, []);
  const next = await f.request('/api/events/' + EVENT + '/scans', { body: { nonce: 'after-start-001', source: 'camera' } });
  await f.request('/api/events/' + EVENT + '/scans', { body: { nonce: 'after-start-002', source: 'camera' } });
  const first = await f.request('/api/events/' + EVENT + '/scans?after=' + baseline.data.nextCursor + '&limit=1', { token: TOKEN });
  assert.equal(first.data.scans.length, 1);
  assert.equal(first.data.scans[0].id, next.data.scan.id);
  assert.equal(first.data.hasMore, true);
  assert.equal('visitorId' in first.data.scans[0], false);
  const last = await f.request('/api/events/' + EVENT + '/scans?after=' + first.data.nextCursor, { token: TOKEN });
  assert.equal(last.data.scans.length, 1);
  const ack = status => f.request('/api/events/' + EVENT + '/acks', { token: TOKEN, body: { scanId: next.data.scan.id, status, deviceId: 'ipad-test-one' } });
  await ack('failed');
  await ack('played');
  await ack('failed');
  const stats = await f.request('/api/admin/stats', { token: TOKEN });
  assert.equal(stats.data.summary.played, 1);
  assert.equal(stats.data.summary.failed, 0);
  assert.equal(stats.data.summary.pending, 2);
});

test('date/event/session filters and profile-clicks use persistent first-party records without claiming follows', async t => {
  const f = await fixture(t);
  const session = await f.request('/api/events/' + EVENT + '/sessions', { token: TOKEN, body: { name: 'Monday gym' } });
  await f.request('/api/events/' + EVENT + '/scans', { body: { nonce: 'session-scan-001', source: 'xhs', visitorId: 'visitor-consistent' } });
  await f.request('/api/events/' + EVENT + '/profile-clicks', { body: { nonce: 'session-scan-001' } });
  await f.request('/api/events/' + EVENT + '/profile-clicks', { body: { nonce: 'session-scan-001' } });
  f.setTime(Date.parse('2026-09-08T01:00:00Z'));
  await f.request('/api/events/' + EVENT + '/sessions', { token: TOKEN, body: { name: 'Tuesday gym' } });
  await f.request('/api/events/' + EVENT + '/scans', { body: { nonce: 'session-scan-002', source: 'web', visitorId: 'visitor-consistent' } });
  const filtered = await f.request('/api/admin/stats?eventId=' + EVENT + '&sessionId=' + session.data.sessionId + '&from=2026-09-07&to=2026-09-07', { token: TOKEN });
  assert.equal(filtered.data.summary.scanVisits, 1);
  assert.equal(filtered.data.summary.profileClicks, 1);
  assert.equal(filtered.data.summary.uniqueVisitors, 1);
  assert.match(filtered.data.metricNote, /不等于关注成功/);
  assert.equal('follows' in filtered.data.summary, false);
  const all = await f.request('/api/admin/stats', { token: TOKEN });
  assert.equal(all.data.summary.scanVisits, 2);
  assert.equal(all.data.summary.uniqueVisitors, 1);
  const exported = await f.request('/api/admin/stats?format=csv&sessionId=' + session.data.sessionId, { token: TOKEN });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  assert.equal(exported.data.split('\r\n').length, 2);
});

test('device lease has only one owner, renews, and becomes available after disconnection', async t => {
  const f = await fixture(t);
  const claim = deviceId => f.request('/api/events/' + EVENT + '/claim', { token: TOKEN, body: { deviceId } });
  const results = await Promise.all([claim('ipad-device-001'), claim('ipad-device-002')]);
  assert.equal(results.filter(result => result.data.claimed).length, 1);
  const winner = results[0].data.claimed ? 'ipad-device-001' : 'ipad-device-002';
  const loser = winner === 'ipad-device-001' ? 'ipad-device-002' : 'ipad-device-001';
  assert.equal((await claim(winner)).data.claimed, true);
  assert.equal((await claim(loser)).data.claimed, false);
  f.setTime(Date.parse('2026-09-07T02:01:00Z'));
  assert.equal((await claim(loser)).data.claimed, true);
});

test('official QR upload persists without allowing arbitrary MIME or public edits', async t => {
  const f = await fixture(t);
  const qr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  assert.equal((await f.request('/api/events/' + EVENT, { method: 'PATCH', body: { nativeQrDataUrl: qr } })).status, 401);
  assert.equal((await f.request('/api/events/' + EVENT, { token: TOKEN, method: 'PATCH', body: { nativeQrDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' } })).status, 400);
  assert.equal((await f.request('/api/events/' + EVENT, { token: TOKEN, method: 'PATCH', body: { nativeQrDataUrl: qr } })).status, 200);
  await f.restart();
  const event = await f.request('/api/events/' + EVENT);
  assert.equal(event.data.nativeQrUrl, '/api/events/' + EVENT + '/native-qr');
  assert.equal('nativeQrDataUrl' in event.data, false);
  const image = await f.request(event.data.nativeQrUrl);
  assert.equal(image.headers.get('content-type'), 'image/png');
});

test('CORS is explicit and static handler never exposes database or source', async t => {
  const f = await fixture(t);
  const blocked = await f.request('/api/events/' + EVENT, { headers: { Origin: 'https://evil.example' } });
  assert.equal(blocked.status, 403);
  const allowed = await f.request('/api/events/' + EVENT, { headers: { Origin: 'https://approved.example' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://approved.example');
  for (const file of ['/server/app.js', '/server/data/scan-broadcast.sqlite', '/package.json', '/.git/config', '/tests/backend.test.js']) assert.equal((await f.request(file)).status, 404);
});
