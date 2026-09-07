'use strict';

const { randomBytes, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { DEFAULT_EVENT, METRIC_NOTE } = require('./defaults');

const SOURCE_TYPES = new Set(['wechat', 'alipay', 'xhs', 'camera', 'web']);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;
const EVENT_PATTERN = /^event-[a-z0-9-]{12,80}$/i;
const hash = value => createHash('sha256').update(String(value)).digest();
const matches = (left, right) => timingSafeEqual(hash(left), hash(right));
const newId = prefix => prefix + '-' + randomBytes(12).toString('hex');
const error = (status, message) => Object.assign(new Error(message), { status });

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (Buffer.byteLength(body) > 750000) throw error(413, '提交内容过大');
  try {
    const value = JSON.parse(String(body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (_) { throw error(400, '请求内容应为 JSON 对象'); }
}

function shortText(value, max = 120) {
  const text = String(value || '').trim();
  if (text.length > max) throw error(400, '文字内容过长');
  return text;
}

function xhsTarget(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)(xiaohongshu\.com|xhslink\.cn|xhs\.cn)$/.test(url.hostname)) throw new Error();
    return url.href;
  } catch (_) { throw error(400, '请填写小红书 HTTPS 主页链接'); }
}

function nativeQr(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url.href;
  } catch (_) { throw error(400, '官方二维码图片需要 HTTPS 地址'); }
}

function qrImage(value) {
  if (!value) return '';
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value));
  if (!match) throw error(400, '二维码图片仅支持 PNG、JPEG 或 WebP');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 524288) throw error(413, '二维码图片请压缩到 512KB 以内');
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
      bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw error(400, '二维码图片格式与内容不一致');
  return value;
}

function publicEvent(event) {
  const { nativeQrDataUrl, ...value } = event;
  if (nativeQrDataUrl) value.nativeQrUrl = '/api/events/' + event.eventId + '/native-qr';
  return value;
}

function dateBoundary(value, fallback, end = false) {
  if (!value) return fallback;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = Date.parse(dateOnly ? value + 'T00:00:00+08:00' : value);
  if (!Number.isFinite(parsed)) throw error(400, '日期格式无效');
  return parsed + (dateOnly && end ? 86400000 : 0);
}

function dayString(time) { return new Date(time + 8 * 3600000).toISOString().slice(0, 10); }

function statistics(scans) {
  const visitors = new Set();
  const days = new Map();
  const sources = new Map();
  const summary = { scanVisits: scans.length, uniqueVisitors: 0, unidentifiedVisits: 0, profileClicks: 0, played: 0, failed: 0, pending: 0 };
  for (const scan of scans) {
    if (scan.visitorId) visitors.add(scan.visitorId); else summary.unidentifiedVisits += 1;
    if (scan.profileClickedAt) summary.profileClicks += 1;
    summary[scan.status] += 1;
    const date = dayString(scan.createdAt);
    if (!days.has(date)) days.set(date, { date, scanVisits: 0, visitors: new Set() });
    const day = days.get(date);
    day.scanVisits += 1;
    if (scan.visitorId) day.visitors.add(scan.visitorId);
    sources.set(scan.source, (sources.get(scan.source) || 0) + 1);
  }
  summary.uniqueVisitors = visitors.size;
  return {
    summary,
    daily: [...days.values()].map(day => ({ date: day.date, scanVisits: day.scanVisits, uniqueVisitors: day.visitors.size })),
    sources: [...sources].map(([source, scanVisits]) => ({ source, scanVisits })),
    recentScans: scans.slice(-100).reverse().map(({ nonce, deviceId, errorCode, ...scan }) => scan),
    metricNote: METRIC_NOTE
  };
}

function csv(scans) {
  const escape = value => '"' + String(value == null ? '' : value).replace(/^[=+@-]/, "'$&").replace(/"/g, '""') + '"';
  const columns = ['扫码编号', '活动编号', '场次编号', '时间（北京时间）', '浏览器来源', '匿名访客', '尝试打开主页', '播报状态'];
  const rows = scans.map(scan => [scan.id, scan.eventId, scan.sessionId, new Date(scan.createdAt + 8 * 3600000).toISOString().replace('T', ' ').replace('Z', ' +08:00'), scan.source, scan.visitorId, scan.profileClickedAt ? '是' : '否', scan.status]);
  return '\uFEFF' + [columns, ...rows].map(row => row.map(escape).join(',')).join('\r\n');
}

async function createApp(options) {
  const { store } = options;
  const clock = options.clock || Date.now;
  const adminToken = String(options.adminToken || process.env.ADMIN_TOKEN || '');
  if (adminToken.length < 24) throw new Error('ADMIN_TOKEN 必须是至少 24 字符的随机密钥，仅配置在后端环境变量');
  const speakerSecret = String(options.speakerSecret || process.env.SPEAKER_TOKEN_SECRET || adminToken);
  const allowedOrigins = new Set(options.allowedOrigins || String(process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
  const seed = await store.ensure('events', DEFAULT_EVENT.eventId, { ...DEFAULT_EVENT });
  if (!seed) throw new Error('持久存储初始化失败');

  function speakerToken(eventId) {
    const data = Buffer.from(eventId).toString('base64url');
    return 'sp1.' + data + '.' + createHmac('sha256', speakerSecret).update('speaker:' + eventId).digest('base64url');
  }

  async function auth(headers, eventId, allowSpeaker = false) {
    const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization || '');
    const cookie = /(?:^|;\s*)dadi_session=([^;]+)/.exec(headers.cookie || '');
    const token = bearer ? bearer[1] : cookie ? cookie[1] : '';
    if (!token) throw error(401, '请先登录后台或从后台打开已配对的现场页面');
    if (allowSpeaker && eventId && token.startsWith('sp1.') && matches(token, speakerToken(eventId))) return { role: 'speaker', eventId };
    if (matches(token, adminToken)) return { role: 'admin', direct: true };
    const session = await store.get('auth', hash(token).toString('hex'));
    if (!session || session.expiresAt <= clock()) throw error(401, '登录已过期，请重新登录');
    return { role: 'admin', ...session, tokenHash: hash(token).toString('hex') };
  }

  async function getEvent(id) {
    if (!EVENT_PATTERN.test(id)) throw error(400, '活动编号无效');
    const event = await store.get('events', id);
    if (!event) throw error(404, '未找到本次活动，请核对链接');
    return event;
  }

  async function handle(request) {
    const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const url = new URL(request.url || '/', 'https://local.invalid');
    const method = String(request.method || 'GET').toUpperCase();
    const origin = headers.origin || '';
    const requestOrigin = request.origin || '';
    const corsAllowed = origin && (origin === requestOrigin || allowedOrigins.has(origin));
    const common = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (corsAllowed) {
      common['Access-Control-Allow-Origin'] = origin;
      common['Access-Control-Allow-Credentials'] = 'true';
      common.Vary = 'Origin';
    }
    const json = (value, status = 200, extra = {}) => ({ status, headers: { ...common, 'Content-Type': 'application/json; charset=utf-8', ...extra }, body: JSON.stringify(value) });
    try {
      if (origin && !corsAllowed) throw error(403, '此网页来源尚未允许连接后台');
      if (method === 'OPTIONS') return { status: 204, headers: { ...common, 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Max-Age': '600' }, body: '' };
      const body = method === 'GET' || method === 'HEAD' ? {} : parseBody(request.body);
      if (url.pathname === '/api/health' && method === 'GET') {
        // Reads the persistent store rather than claiming health solely from process uptime.
        await getEvent(DEFAULT_EVENT.eventId);
        return json({ ok: true, storage: options.storageDriver || 'sqlite', serverTime: clock() });
      }
      if (url.pathname === '/api/admin/login' && method === 'POST') {
        if (typeof body.token !== 'string' || !matches(body.token, adminToken)) throw error(401, '管理密钥不正确');
        const sessionToken = randomBytes(32).toString('base64url');
        const expiresAt = clock() + SESSION_MS;
        await store.put('auth', hash(sessionToken).toString('hex'), { createdAt: clock(), expiresAt });
        const secure = request.secure ? '; Secure' : '';
        return json({ ok: true, sessionToken, expiresAt }, 200, { 'Set-Cookie': 'dadi_session=' + sessionToken + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + SESSION_MS / 1000 + secure });
      }
      if (url.pathname === '/api/admin/session' && method === 'GET') {
        const user = await auth(headers);
        return json({ ok: true, expiresAt: user.expiresAt || null });
      }
      if (url.pathname === '/api/admin/logout' && method === 'POST') {
        const user = await auth(headers);
        if (user.tokenHash) await store.remove('auth', user.tokenHash);
        return json({ ok: true }, 200, { 'Set-Cookie': 'dadi_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      }
      if (url.pathname === '/api/admin/events' && method === 'GET') {
        await auth(headers);
        const events = (await store.list('events')).map(event => ({ ...event, speakerToken: speakerToken(event.eventId) }));
        return json({ events, sessions: await store.list('sessions') });
      }
      if (url.pathname === '/api/events' && method === 'POST') {
        await auth(headers);
        const now = clock();
        const speech = shortText(body.speech || DEFAULT_EVENT.speech, 2000);
        const event = {
          eventId: newId('event'), name: shortText(body.name || '岩馆现场活动'),
          target: xhsTarget(body.target || DEFAULT_EVENT.target), speech,
          ttsSpeech: speech === DEFAULT_EVENT.speech ? DEFAULT_EVENT.ttsSpeech : speech,
          audioFile: speech === DEFAULT_EVENT.speech ? DEFAULT_EVENT.audioFile : '',
          nativeQrUrl: nativeQr(body.nativeQrUrl), activeSessionId: '', createdAt: now
        };
        await store.put('events', event.eventId, event);
        return json({ ...event, event, speakerToken: speakerToken(event.eventId) }, 201);
      }
      if (url.pathname === '/api/admin/stats' && method === 'GET') {
        await auth(headers);
        const filter = {
          eventId: url.searchParams.get('eventId') || '', sessionId: url.searchParams.get('sessionId') || '',
          from: dateBoundary(url.searchParams.get('from'), 0), to: dateBoundary(url.searchParams.get('to'), clock() + 1, true)
        };
        if (filter.from >= filter.to) throw error(400, '开始日期需要早于结束日期');
        const scans = await store.filteredScans(filter);
        if (url.searchParams.get('format') === 'csv') return { status: 200, headers: { ...common, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="dadi-scans.csv"' }, body: csv(scans) };
        return json({ ...statistics(scans), filter, serverTime: clock() });
      }
      const match = /^\/api\/events\/(event-[a-z0-9-]+)(?:\/(scans|acks|sessions|claim|profile-clicks|native-qr))?$/.exec(url.pathname);
      if (!match) throw error(404, '接口不存在');
      const [, eventId, action] = match;
      const event = await getEvent(eventId);
      if (!action && method === 'GET') return json(publicEvent(event));
      if (action === 'native-qr' && method === 'GET') {
        if (!event.nativeQrDataUrl) throw error(404, '尚未上传官方二维码');
        const [, mime, data] = /^data:([^;]+);base64,(.*)$/.exec(event.nativeQrDataUrl);
        return { status: 200, headers: { ...common, 'Content-Type': mime }, body: Buffer.from(data, 'base64') };
      }
      if (!action && method === 'PATCH') {
        await auth(headers);
        const next = { ...event, updatedAt: clock() };
        if ('name' in body) next.name = shortText(body.name);
        if ('target' in body) next.target = xhsTarget(body.target);
        if ('nativeQrUrl' in body) { next.nativeQrUrl = nativeQr(body.nativeQrUrl); next.nativeQrDataUrl = ''; }
        if ('nativeQrDataUrl' in body) { next.nativeQrDataUrl = qrImage(body.nativeQrDataUrl); if (next.nativeQrDataUrl) next.nativeQrUrl = '/api/events/' + eventId + '/native-qr'; }
        await store.put('events', eventId, next);
        return json(next);
      }
      if (action === 'sessions' && method === 'POST') {
        await auth(headers);
        const now = clock();
        if (event.activeSessionId) {
          const previous = await store.get('sessions', event.activeSessionId);
          if (previous) await store.put('sessions', previous.sessionId, { ...previous, endedAt: now });
        }
        const session = { sessionId: newId('session'), eventId, name: shortText(body.name || dayString(now) + ' 现场'), startedAt: now, endedAt: null };
        await store.put('sessions', session.sessionId, session);
        await store.put('events', eventId, { ...event, activeSessionId: session.sessionId });
        return json(session, 201);
      }
      if (action === 'scans' && method === 'POST') {
        if (!ID_PATTERN.test(body.nonce || '')) throw error(400, '扫码标识无效');
        if (!SOURCE_TYPES.has(body.source)) throw error(400, '浏览器来源无效');
        if (body.visitorId && !ID_PATTERN.test(body.visitorId)) throw error(400, '匿名访客标识无效');
        // Field allowlist deliberately excludes IP address, raw user agent and client time.
        const value = { eventId, nonce: body.nonce, source: body.source, visitorId: body.visitorId || '', sessionId: event.activeSessionId || '', createdAt: clock() };
        const result = await store.recordScan(value);
        return json({ ok: true, target: event.target, duplicate: result.duplicate, scan: { id: result.scan.id, createdAt: result.scan.createdAt } }, result.duplicate ? 200 : 201);
      }
      if (action === 'profile-clicks' && method === 'POST') {
        if (!ID_PATTERN.test(body.nonce || '')) throw error(400, '扫码标识无效');
        const scan = await store.profileClick(eventId, body.nonce, clock());
        if (!scan) throw error(404, '尚未收到该次扫码记录');
        return json({ ok: true });
      }
      if (action === 'claim' && method === 'POST') {
        await auth(headers, eventId, true);
        if (!ID_PATTERN.test(body.deviceId || '')) throw error(400, '设备标识无效');
        return json({ ok: true, ...await store.claim(eventId, body.deviceId, clock()), serverTime: clock() });
      }
      if (action === 'scans' && method === 'GET') {
        await auth(headers, eventId, true);
        if (url.searchParams.get('after') === 'now') return json({ scans: [], nextCursor: await store.latestCursor(eventId), hasMore: false, serverTime: clock() });
        const after = Number(url.searchParams.get('after') || 0);
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 100)));
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit)) throw error(400, '分页游标无效');
        const scans = await store.scansAfter(eventId, after, limit);
        // A scoped speaker cannot read visitor identifiers or browser source details.
        return json({ scans: scans.map(({ id, eventId, createdAt, status }) => ({ id, eventId, createdAt, status })), nextCursor: scans.length ? scans[scans.length - 1].id : after, hasMore: scans.length === limit, serverTime: clock() });
      }
      if (action === 'acks' && method === 'POST') {
        await auth(headers, eventId, true);
        const id = Number(body.scanId);
        if (!Number.isSafeInteger(id) || id <= 0 || !['played', 'failed'].includes(body.status)) throw error(400, '播报结果无效');
        const deviceId = shortText(body.deviceId, 100);
        const errorCode = shortText(body.errorCode, 80);
        if (deviceId && !ID_PATTERN.test(deviceId)) throw error(400, '设备标识无效');
        if (errorCode && !/^[a-zA-Z0-9_-]+$/.test(errorCode)) throw error(400, '错误类型应为简短标识');
        const scan = await store.acknowledge(eventId, id, { status: body.status, ackAt: clock(), deviceId, errorCode });
        if (!scan) throw error(404, '扫码记录不存在');
        return json({ ok: true, status: scan.status });
      }
      throw error(405, '此接口不支持该请求方式');
    } catch (err) {
      // Do not expose database credentials, provider payloads, IP or request headers.
      return json({ ok: false, error: err.status ? err.message : '后台暂时无法连接，请稍后重试' }, err.status || 503);
    }
  }

  return { handle, store, close: () => store.close() };
}

module.exports = { createApp, statistics, dateBoundary };
