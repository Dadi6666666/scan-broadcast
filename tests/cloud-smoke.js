'use strict';
// Explicit opt-in integration check; uses a separately named test activity.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const endpoint = process.env.SCAN_API || 'https://dadi-climb-d6g91rnn034b36f1f.service.tcloudbase.com';
const config = JSON.parse(fs.readFileSync('.deployment/cloudbaserc.json'));
const adminToken = config.functions[0].envVariables.ADMIN_TOKEN;
const eventId = process.argv[2];
if (!/^event-[a-z0-9-]+$/.test(eventId || '')) throw new Error('Pass the dedicated test event ID');
async function api(path, body, token) {
  const response = await fetch(endpoint + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20000),
    headers: { Origin: 'https://dadi6666666.github.io', ...(body ? {'Content-Type':'application/json'} : {}), ...(token ? {Authorization:'Bearer ' + token} : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://dadi6666666.github.io');
  assert.ok(response.ok, path + ': ' + JSON.stringify(data));
  return data;
}
(async function () {
  assert.equal((await api('/api/health')).storage, 'cloudbase');
  const events = await api('/api/admin/events', undefined, adminToken);
  const testEvent = events.events.find(event => event.eventId === eventId);
  assert.equal(testEvent.name, '联调测试（非现场数据）');
  const token = testEvent.speakerToken, path = '/api/events/' + eventId;
  const nonce = 'smoke-' + require('node:crypto').randomUUID();
  const before = await api(path + '/scans?after=now', undefined, token);
  const results = await Promise.all(Array.from({length: 4}, () => api(path + '/scans', {nonce, visitorId:'cloud-smoke-visitor', source:'web'})));
  assert.equal(results.filter(item => !item.duplicate).length, 1);
  assert.equal(new Set(results.map(item => item.scan.id)).size, 1);
  assert.equal(results[0].target, testEvent.target);
  await api(path + '/profile-clicks', {nonce});
  const feed = await api(path + '/scans?after=' + before.nextCursor, undefined, token);
  assert.equal(feed.scans.length, 1);
  assert.equal(feed.scans[0].status, 'pending');
  const stats = await api('/api/admin/stats?eventId=' + eventId, undefined, adminToken);
  assert.ok(stats.summary.scanVisits >= 1);
  assert.ok(stats.summary.profileClicks >= 1);
  console.log(JSON.stringify({ok:true,eventId,scanId:results[0].scan.id,summary:stats.summary}));
}()).catch(error => { console.error(error.message); process.exitCode = 1; });
