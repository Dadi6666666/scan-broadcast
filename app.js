/* The public poster has no management secrets. Device access stays in a fragment. */
(function () {
  'use strict';
  var runtime = window.SCAN_RUNTIME || {};
  var params = new URLSearchParams(location.search);
  var mode = params.get('mode') || 'poster';
  var eventId = params.get('event') || runtime.defaultEvent || 'event-78d5f6df9edf52dd843ee162';
  var DEFAULT = {
    eventId: 'event-78d5f6df9edf52dd843ee162',
    target: 'https://xhslink.cn/m/6WxO9KMNJQM',
    speech: '感谢大佬关注“大迪在面壁”！愿大佬动作有逻辑，发力讲科学；上墙有劲，下墙平安，V6酷酷拿下，难线统统不怕！',
    ttsSpeech: '感谢大佬，关注大迪在面壁！愿大佬，动作有逻辑，发力讲科学；上墙有劲，下墙平安！V六，酷酷拿下；难线，统统不怕！',
    audioFile: 'announce-yunjian-v1.mp3'
  };
  var byId = function (id) { return document.getElementById(id); };
  var storage = {
    get: function (key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set: function (key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
  };
  var randomId = function () { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); };
  // Each open page has its own lease; two tabs must not act as one speaker.
  var deviceId = randomId();
  var fragment = new URLSearchParams(location.hash.slice(1));
  var speakerToken = fragment.get('speaker') || storage.get('dadi-speaker-' + eventId) || '';
  if (speakerToken) storage.set('dadi-speaker-' + eventId, speakerToken);
  var config = eventId === DEFAULT.eventId ? DEFAULT : null;
  var running = false, polling = false, cursor = null, timer = null, failures = 0;
  var leaseUntil = 0, leaseRenewed = 0, wakeLock = null, queue = [], busy = false;
  var received = 0, spoken = 0, seen = new Set(), pendingAcks = [], nativeMode = false, ackFlushing = false, audioError = '';
  var stageMode = mode === 'poster' || mode === 'speaker' || mode === 'listen';
  var apiBase = String(runtime.apiBase || '').replace(/\/$/, '');

  function status(id, text, bad) {
    var node = byId(id);
    if (!node) return;
    node.textContent = text;
    node.className = 'status' + (bad ? ' bad' : ' ok');
  }
  function stageStatus(text, bad, detail) {
    status(mode === 'poster' ? 'posterLiveStatus' : 'speakerStatus', text, bad);
    byId('stageConnection').textContent = text;
    byId('stageTools').dataset.state = bad ? 'bad' : 'ok';
    if (detail) byId('stageDetail').textContent = detail;
  }
  function eventPath(tail) { return '/api/events/' + encodeURIComponent(eventId) + (tail || ''); }
  function siteUrl(nextMode, id) {
    var url = new URL(runtime.siteBase || './', location.href);
    url.search = ''; url.hash = '';
    url.searchParams.set('mode', nextMode);
    url.searchParams.set('event', id || eventId);
    return url;
  }
  function safeTarget(value) {
    try {
      var url = new URL(value);
      if (url.protocol === 'https:' && /(^|\.)(xiaohongshu\.com|xhslink\.cn|xhs\.cn)$/.test(url.hostname)) return url.href;
    } catch (_) {}
    return DEFAULT.target;
  }
  async function api(path, body, authenticated, timeoutMs) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, timeoutMs || 12000);
    var options = { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: controller.signal, credentials: 'include', headers: { Accept: 'application/json' } };
    if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    if (authenticated && speakerToken) options.headers.Authorization = 'Bearer ' + speakerToken;
    try {
      var response = await fetch(apiBase + path, options);
      var result;
      try { result = await response.json(); } catch (_) { throw new Error('后台尚未连接，请从正式现场链接打开'); }
      if (!response.ok) {
        var error = new Error(result.error && result.error.message || result.error || result.message || ('后台响应 ' + response.status));
        error.status = response.status;
        throw error;
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('网络响应较慢，将自动重连');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function makeQr(id, value) {
    var box = byId(id); box.innerHTML = '';
    if (!window.QRCode) throw new Error('二维码组件加载失败，请刷新页面');
    new QRCode(box, { text: value, width: 320, height: 320, colorDark: '#17202a', colorLight: '#fffdf7', correctLevel: QRCode.CorrectLevel.M });
  }
  async function loadConfig() {
    var result = await api(eventPath());
    config = result.event || result.activity || result.config || result;
    if (!config.eventId) config.eventId = eventId;
    config.target = safeTarget(config.target);
    renderNative();
    return config;
  }
  function renderNative() {
    var source = config && (config.nativeQrDataUrl || config.nativeQrUrl);
    var valid = typeof source === 'string' && (/^data:image\/(png|jpeg|webp);base64,/.test(source) || source.startsWith('/api/') || /^https:\/\//.test(source));
    if (valid) byId('nativeQrImage').src = source.startsWith('/api/') ? apiBase + source : source;
    byId('nativeQrMode').disabled = !valid;
    byId('nativeQrMode').title = valid ? '使用小红书官方个人主页码' : '请在后台上传从小红书保存的个人主页二维码';
    if (nativeMode && !valid) switchQr(false);
  }
  function switchQr(native) {
    nativeMode = native;
    byId('posterQr').classList.toggle('hidden', native);
    byId('nativeQrBox').classList.toggle('hidden', !native);
    byId('webQrMode').setAttribute('aria-pressed', String(!native));
    byId('nativeQrMode').setAttribute('aria-pressed', String(native));
    byId('qrMethodNote').textContent = native ? '小红书扫一扫，直接进入我的主页' : '用相机 / 微信扫一扫';
    if (native) byId('stageDetail').textContent = '小红书原生码直接打开主页，不经过本系统，不能自动计数或播报。网页互动码的记录仍正常接收。';
  }
  function playFile(filename, limit) {
    return new Promise(function (resolve, reject) {
      var audio = byId('announcementAudio');
      var allowed = ['announce-yunjian-v1.mp3', 'ready-yunjian-v1.mp3'];
      if (!allowed.includes(filename)) return reject(new Error('音频配置无效'));
      var timeout;
      function cleanup() { clearTimeout(timeout); audio.removeEventListener('ended', ended); audio.removeEventListener('error', failed); }
      function ended() { cleanup(); resolve(); }
      function failed() { cleanup(); audio.pause(); reject(new Error('声音未播放，请检查音量并重新允许声音')); }
      audio.pause(); audio.src = new URL(filename, new URL('./', location.href)).href;
      audio.currentTime = 0; audio.volume = 1;
      audio.addEventListener('ended', ended, { once: true }); audio.addEventListener('error', failed, { once: true });
      timeout = setTimeout(failed, limit || 25000);
      var p = audio.play();
      if (p && p.catch) p.catch(failed);
    });
  }
  function speak(text) {
    return new Promise(function (resolve, reject) {
      if (!window.speechSynthesis) return reject(new Error('当前设备无法播放自定义文案'));
      var u = new SpeechSynthesisUtterance(text); u.lang = 'zh-CN'; u.rate = .95;
      var timeout = setTimeout(function () { speechSynthesis.cancel(); reject(new Error('自定义语音播放超时')); }, 45000);
      u.onend = function () { clearTimeout(timeout); resolve(); };
      u.onerror = function () { clearTimeout(timeout); reject(new Error('自定义语音播放失败')); };
      speechSynthesis.speak(u);
    });
  }
  async function keepAwake() {
    try { if (navigator.wakeLock && (!wakeLock || wakeLock.released)) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  function counts() {
    byId('stageCounts').textContent = '本次页面：收到 ' + received + ' · 播完 ' + spoken;
    byId('receivedCount').textContent = String(received); byId('spokenCount').textContent = String(spoken);
  }
  async function flushAcks() {
    if (ackFlushing) return;
    ackFlushing = true;
    while (pendingAcks.length) {
      var ack = pendingAcks[0];
      try { await api(eventPath('/acks'), ack, true); pendingAcks.shift(); }
      catch (_) { break; }
    }
    storage.set('dadi-acks-' + eventId, JSON.stringify(pendingAcks));
    ackFlushing = false;
  }
  async function drainQueue() {
    if (busy || audioError) return;
    busy = true;
    while (queue.length && running) {
      // Lease is renewed by the poller; no other device may broadcast simultaneously.
      if (Date.now() >= leaseUntil) break;
      var scan = queue.shift(), played = false;
      stageStatus('正在播报', false);
      try {
        if (!config || config.audioFile === 'announce-yunjian-v1.mp3' || config.speech === DEFAULT.speech) await playFile('announce-yunjian-v1.mp3');
        else await speak(config.ttsSpeech || config.speech);
        played = true; spoken++; counts();
      } catch (error) { audioError = error.message; stageStatus('声音播放失败，点此重新允许', true, error.message); }
      pendingAcks.push({ scanId: scan.id, status: played ? 'played' : 'failed', deviceId: deviceId, errorCode: played ? undefined : 'audio_failed' });
      storage.set('dadi-acks-' + eventId, JSON.stringify(pendingAcks));
      await flushAcks();
      if (audioError) break;
    }
    busy = false;
  }
  function schedule(delay) { clearTimeout(timer); if (running) timer = setTimeout(poll, delay); }
  async function poll() {
    if (!running || polling) return;
    if (document.hidden) { stageStatus('页面在后台，恢复前台后继续', true); schedule(10000); return; }
    polling = true;
    try {
      if (Date.now() - leaseRenewed > 10000 || Date.now() >= leaseUntil) {
        var lease = await api(eventPath('/claim'), { deviceId: deviceId }, true);
        if (!lease.claimed) { leaseUntil = 0; stageStatus('正在等待播报设备交接', true, '请关闭其他播报页面。刚关闭或刷新的页面最多等待 30 秒后自动接替，海报仍可扫码。'); schedule(5000); return; }
        leaseRenewed = Date.now(); leaseUntil = Date.now() + Math.max(0, Number(lease.expiresAt) - Number(lease.serverTime));
      }
      var result = await api(eventPath('/scans?after=') + encodeURIComponent(cursor === null ? 'now' : cursor) + '&limit=100', undefined, true);
      cursor = result.nextCursor;
      (result.scans || []).forEach(function (scan) {
        if (seen.has(scan.id)) return;
        seen.add(scan.id); received++;
        // Old scans remain in the database; avoid a burst of stale welcomes after long outages.
        if (Number(result.serverTime) - Number(scan.createdAt) < 120000 && scan.status !== 'played') queue.push(scan);
      });
      counts(); failures = 0;
      if (audioError) stageStatus('声音播放失败，点此重新允许', true, audioError);
      else if (!busy) stageStatus('播报已连接', false, '记录已存后台。短暂断网会自动重连；超过两分钟的旧扫码仅保留记录，不补播。');
      if (mode === 'poster') byId('posterSetup').classList.add('hidden');
      drainQueue();
      await flushAcks();
      schedule(result.hasMore ? 200 : 2500);
    } catch (error) {
      failures++;
      if (error.status === 401 || error.status === 403) {
        running = false; stageStatus('需要重新配对这台设备', true, '请从后台打开该活动的现场海报链接。'); byId('devicePairNote').classList.remove('hidden');
      } else { stageStatus('连接中断，正在自动重连', true, error.message); schedule(Math.min(30000, 2500 * Math.pow(2, Math.min(failures, 4)))); }
    } finally { polling = false; }
  }
  async function startStage() {
    var button = mode === 'poster' ? byId('posterLiveStart') : byId('speakerStart');
    if (busy) return;
    button.disabled = true;
    stageStatus('正在开启声音和连接后台…', false);
    var sound = playFile('ready-yunjian-v1.mp3', 10000);
    keepAwake();
    try {
      await Promise.all([sound, loadConfig()]);
      audioError = '';
      if (!speakerToken) {
        // Same-origin administrator session also works on this device.
        var events = await api('/api/admin/events', undefined, true);
        var list = events.events || events;
        var own = list.find(function (e) { return e.eventId === eventId; });
        if (own && own.speakerToken) { speakerToken = own.speakerToken; storage.set('dadi-speaker-' + eventId, speakerToken); }
      }
      if (!speakerToken) throw new Error('请从后台打开一次“现场海报”完成配对，以后收藏该链接即可');
      running = true; await poll();
      if (mode !== 'poster') { byId('speakerSubActions').classList.remove('hidden'); byId('speakerCounters').classList.remove('hidden'); }
    } catch (error) {
      stageStatus(error.message || '暂时无法连接，请重试', true);
      if (!speakerToken) byId('devicePairNote').classList.remove('hidden');
    } finally { button.disabled = false; button.textContent = running ? '重新试听并连接' : '开启自动播报并试听'; }
  }
  function initStage() {
    byId(mode === 'poster' ? 'posterPage' : 'speakerPage').classList.remove('hidden');
    byId('stageTools').classList.remove('hidden');
    // Bind sound gesture first. A QR or configuration failure cannot disable this button.
    byId('posterLiveStart').addEventListener('click', startStage);
    byId('speakerStart').addEventListener('click', startStage);
    byId('retryStage').addEventListener('click', startStage);
    byId('speakerReconnect').addEventListener('click', startStage);
    byId('speakerTest').addEventListener('click', function () { if (!busy) playFile('announce-yunjian-v1.mp3').catch(function (e) { stageStatus(e.message, true); }); });
    byId('webQrMode').addEventListener('click', function () { switchQr(false); });
    byId('nativeQrMode').addEventListener('click', function () { switchQr(true); });
    if (mode === 'poster') {
      try { makeQr('posterQr', siteUrl('scan').href); } catch (e) { status('posterQrStatus', e.message, true); }
      if (params.get('preview') === '1' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) byId('posterSetup').classList.add('hidden');
    }
    try { pendingAcks = JSON.parse(storage.get('dadi-acks-' + eventId) || '[]'); if (!Array.isArray(pendingAcks)) pendingAcks = []; } catch (_) { pendingAcks = []; }
    loadConfig().catch(function (error) { stageStatus('海报已显示，后台暂未连接', true, error.message); });
    renderNative();
    document.addEventListener('visibilitychange', function () { if (!document.hidden && running) { keepAwake(); schedule(0); } });
    window.addEventListener('online', function () { if (running) schedule(0); });
    window.addEventListener('offline', function () { stageStatus('网络已断开，正在等待恢复', true); });
    window.addEventListener('pagehide', function () { clearTimeout(timer); });
    window.addEventListener('pageshow', function () { if (running) schedule(0); });
  }
  function sourceClass() {
    var ua = navigator.userAgent;
    return /MicroMessenger/i.test(ua) ? 'wechat' : /AlipayClient/i.test(ua) ? 'alipay' : /xhs|xiaohongshu/i.test(ua) ? 'xhs' : /iPhone|iPad/i.test(ua) ? 'camera' : 'web';
  }
  async function initScan() {
    byId('scanPage').classList.remove('hidden');
    byId('jumpButton').classList.remove('hidden');
    var nonce = randomId(), recorded = false, jumped = false, target = DEFAULT.target;
    var visitor = storage.get('dadi-visitor-id') || randomId(); storage.set('dadi-visitor-id', visitor);
    async function go() {
      if (jumped) return; jumped = true;
      if (recorded) {
        try { await api(eventPath('/profile-clicks'), { nonce: nonce }, false, 1500); } catch (_) {}
      }
      location.replace(safeTarget(target));
    }
    byId('jumpButton').addEventListener('click', go);
    var recent;
    try { recent = JSON.parse(storage.get('dadi-last-scan-' + eventId) || 'null'); } catch (_) {}
    if (recent && Date.now() - recent.at < 3500) nonce = recent.nonce;
    storage.set('dadi-last-scan-' + eventId, JSON.stringify({ at: Date.now(), nonce: nonce }));
    status('scanStatus', '正在确认扫码记录…', false);
    try {
      var result = await api(eventPath('/scans'), { nonce: nonce, visitorId: visitor, source: sourceClass() });
      recorded = Boolean(result.ok);
      if (!recorded) throw new Error('后台尚未确认，请重试');
      target = safeTarget(result.target || DEFAULT.target);
      byId('scanTitle').textContent = '欢迎关注！';
      byId('scanText').textContent = '正在打开“大迪在面壁”的小红书主页。';
      status('scanStatus', result.duplicate ? '刚才的扫码已合并' : '扫码已记录', false);
      setTimeout(go, 600);
    } catch (error) {
      byId('scanTitle').textContent = '可以继续前往小红书';
      byId('scanText').textContent = '这次扫码尚未记录，现场可能不会播报。你仍可点击下方按钮关注。';
      status('scanStatus', error.message, true);
    }
  }

  if (location.protocol === 'file:') {
    byId('errorPage').classList.remove('hidden'); byId('errorText').textContent = '请使用正式网页链接打开，不能直接打开本地文件。';
    return;
  }
  if (runtime.siteBase) {
    var destination = new URL(runtime.siteBase);
    if (destination.origin !== location.origin || destination.pathname.replace(/\/$/, '') !== new URL('./', location.href).pathname.replace(/\/$/, '')) {
      destination.search = location.search; destination.hash = location.hash; location.replace(destination.href); return;
    }
  }
  if (mode === 'admin') { location.replace(new URL('admin.html', location.href)); return; }
  if (mode === 'listen') mode = 'speaker';
  if (!/^event-[a-z0-9-]{12,80}$/i.test(eventId)) { byId('errorPage').classList.remove('hidden'); return; }
  if (stageMode) initStage();
  else if (mode === 'scan') initScan();
  else if (mode === 'pair') {
    byId('pairPage').classList.remove('hidden');
    byId('pairStatus').textContent = '请在后台打开该活动的“现场海报”完成设备配对。';
    byId('pairQr').classList.add('hidden');
  } else byId('errorPage').classList.remove('hidden');
})();
