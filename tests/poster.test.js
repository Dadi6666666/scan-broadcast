'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('poster redesign preserves every app DOM binding exactly once', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate DOM IDs');
  const refs = [...script.matchAll(/byId\('([^']+)'\)/g)].map(match => match[1]);
  for (const id of new Set(refs)) assert.ok(ids.includes(id), `missing app binding: ${id}`);
  for (const id of ['posterPage', 'speakerPage', 'posterLiveStart', 'speakerStart']) assert.ok(ids.includes(id));
});

test('chocolate invitation is explicit and QR controls remain operator-only', () => {
  assert.match(html, /<h1 class="poster-headline">巧克力<span>请自取<\/span><\/h1>/);
  assert.match(html, /class="poster-follow-cue">顺手关注一下/);
  assert.match(html, /class="poster-xhs-badge">小红书/);
  const tools = html.slice(html.indexOf('<details id="stageTools"'), html.indexOf('</details>'));
  assert.match(tools, /id="webQrMode"/);
  assert.match(tools, /id="nativeQrMode"/);
  assert.match(html, /href="poster\.css\?v=/);
  assert.ok(fs.existsSync(path.join(root, 'poster.css')));
  assert.match(html, /src="announce-yunjian-v1\.mp3"/);
});
