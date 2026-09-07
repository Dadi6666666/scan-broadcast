(function () {
  'use strict';

  var runtime = window.SCAN_RUNTIME || {};
  var apiBase = String(runtime.apiBase || '').replace(/\/$/, '');
  var token = '';
  var events = [];
  var sessions = [];
  var statsReady = false;
  var requestSequence = 0;
  var numberFormat = new Intl.NumberFormat('zh-CN');
  var metricIds = ['scanCount', 'visitorCount', 'profileCount', 'audioSuccessCount', 'audioFailureCount'];
  var byId = function (id) { return document.getElementById(id); };

  function setStatus(id, message, kind) {
    var element = byId(id);
    element.textContent = message;
    element.className = 'status' + (kind ? ' ' + kind : '');
  }
  function storedToken(value) {
    try {
      if (value === undefined) return sessionStorage.getItem('dadi-admin-session') || '';
      if (value) sessionStorage.setItem('dadi-admin-session', value);
      else sessionStorage.removeItem('dadi-admin-session');
    } catch (_) { /* A private browser may only retain this session in memory. */ }
    return '';
  }
  async function request(path, options) {
    options = options || {};
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 18000);
    var headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    if (options.body !== undefined && typeof options.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    try {
      var response = await fetch(apiBase + path, Object.assign({}, options, {
        headers: headers, signal: controller.signal, credentials: 'include', cache: 'no-store'
      }));
      if (!response.ok) {
        var failure = await response.json().catch(function () { return {}; });
        var error = new Error(failure.message || failure.error || (response.status === 401 ? '口令不正确或登录已过期，请重新登录。' : '服务暂时不可用，请稍后重试。'));
        error.status = response.status;
        throw error;
      }
      if (options.blob) return await response.blob();
      var data = await response.json();
      if (data.ok === false) throw new Error(data.message || data.error || '服务未能完成操作。');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('连接超时，当前数据尚未获取。请检查网络后重试。');
      if (error instanceof TypeError) throw new Error('无法连接数据服务。请检查网络及后台服务是否已部署。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function showLogin(message) {
    token = '';
    storedToken('');
    requestSequence += 1;
    statsReady = false;
    byId('dashboard').classList.add('hidden');
    byId('logoutButton').classList.add('hidden');
    byId('loginPanel').classList.remove('hidden');
    if (message) setStatus('loginStatus', message, 'bad');
  }
  function clearMetrics() {
    statsReady = false;
    metricIds.forEach(function (id) { byId(id).textContent = '—'; });
    byId('exportButton').disabled = true;
  }
  function invalidateMetrics() {
    requestSequence += 1;
    byId('refreshButton').disabled = false;
    clearMetrics();
    emptyRecords('筛选已改变，等待重新加载。');
    byId('recordsHint').textContent = '';
    byId('updatedAt').textContent = '等待加载新筛选';
    setStatus('dashboardStatus', '筛选已改变，点击“查看数据”加载。');
  }
  function cell(text, className) {
    var result = document.createElement('td');
    result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function emptyRecords(message) {
    var row = document.createElement('tr');
    var content = cell(message, 'empty-state');
    content.colSpan = 6;
    row.appendChild(content);
    byId('recordsBody').replaceChildren(row);
  }
  function formattedTime(value) {
    if (!value) return '—';
    var date = new Date(typeof value === 'number' && value < 100000000000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
  }
  function eventName(id) {
    var event = events.find(function (item) { return item.eventId === id; });
    return event ? event.name || event.eventId : id || '—';
  }
  function selectedEvent() {
    return events.find(function (event) { return event.eventId === byId('eventFilter').value; });
  }
  function posterUrl(event) {
    var url = new URL('./', location.href);
    url.searchParams.set('mode', 'poster');
    url.searchParams.set('event', event.eventId);
    if (event.speakerToken) url.hash = 'speaker=' + encodeURIComponent(event.speakerToken);
    return url.href;
  }
  function setOptions(element, items, key, label, firstLabel) {
    var previous = element.value;
    var first = document.createElement('option');
    first.value = ''; first.textContent = firstLabel;
    element.replaceChildren(first);
    items.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item[key]; option.textContent = label(item);
      element.appendChild(option);
    });
    if (items.some(function (item) { return item[key] === previous; })) element.value = previous;
  }
  function updateSessions() {
    var eventId = byId('eventFilter').value;
    var available = sessions.filter(function (session) { return !eventId || session.eventId === eventId; });
    setOptions(byId('sessionFilter'), available, 'sessionId', function (session) {
      return session.name || session.sessionId;
    }, '全部场次');
    byId('newSessionButton').disabled = !eventId;
    byId('saveNativeUrlButton').disabled = !eventId;
    byId('nativeQrFile').disabled = !eventId;
    var event = selectedEvent();
    byId('nativeQrUrl').value = event && !event.nativeQrDataUrl && event.nativeQrUrl || '';
    setStatus('nativeQrStatus', event ? '上传后保存到“' + (event.name || event.eventId) + '”，现场 iPad 刷新即可读取。' : '先在页面上方选择活动，再上传该活动的官方二维码。');
    showNativePreview();
    renderEventLinks();
  }
  function renderEventLinks() {
    var active = selectedEvent();
    var visible = active ? [active] : events;
    var holder = byId('eventLinks');
    holder.replaceChildren();
    if (!visible.length) {
      var empty = document.createElement('p');
      empty.className = 'muted'; empty.textContent = '服务端尚未配置活动。';
      holder.appendChild(empty); return;
    }
    byId('mainPosterLink').href = posterUrl(visible[0]);
    visible.forEach(function (event) {
      var row = document.createElement('div'); row.className = 'event-link-row';
      var details = document.createElement('div');
      var title = document.createElement('strong'); title.textContent = event.name || event.eventId;
      var note = document.createElement('small'); note.textContent = event.eventId + (event.activeSessionId ? ' · 已有进行中的场次' : ' · 尚未开始场次');
      details.append(title, note);
      var actions = document.createElement('div'); actions.className = 'event-link-actions';
      var link = document.createElement('a'); link.href = posterUrl(event); link.target = '_blank'; link.rel = 'noopener'; link.textContent = '打开现场海报 ↗';
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button quiet'; copy.textContent = '复制固定链接';
      copy.addEventListener('click', async function () {
        try { await navigator.clipboard.writeText(link.href); copy.textContent = '已复制'; }
        catch (_) { setStatus('sessionStatus', '未获得剪贴板权限，请长按“打开现场海报”复制链接。', 'bad'); }
      });
      actions.append(link, copy); row.append(details, actions); holder.appendChild(row);
    });
  }
  async function loadEvents() {
    var data = await request('/api/admin/events');
    if (!Array.isArray(data.events)) throw new Error('活动配置返回异常，请检查数据服务。');
    events = data.events; sessions = Array.isArray(data.sessions) ? data.sessions : [];
    setOptions(byId('eventFilter'), events, 'eventId', function (event) { return event.name || event.eventId; }, '全部活动');
    var requestedEvent = new URLSearchParams(location.search).get('event') || runtime.defaultEvent;
    if (!byId('eventFilter').value && events.some(function (event) { return event.eventId === requestedEvent; })) byId('eventFilter').value = requestedEvent;
    if (!byId('eventFilter').value && events.length === 1) byId('eventFilter').value = events[0].eventId;
    updateSessions();
  }
  function filterQuery() {
    var query = new URLSearchParams();
    var from = byId('fromDate').value, to = byId('toDate').value;
    if (from && to && from > to) throw new Error('开始日期不能晚于结束日期。');
    if (byId('eventFilter').value) query.set('eventId', byId('eventFilter').value);
    if (byId('sessionFilter').value) query.set('sessionId', byId('sessionFilter').value);
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    return query;
  }
  function renderStats(data) {
    if (!data.summary || !Array.isArray(data.recentScans)) throw new Error('统计数据返回异常，暂不显示计数。');
    var values = [data.summary.scanVisits, data.summary.uniqueVisitors, data.summary.profileClicks, data.summary.played, data.summary.failed];
    metricIds.forEach(function (id, index) {
      var value = values[index];
      byId(id).textContent = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? numberFormat.format(value) : '—';
    });
    var sourceNames = { wechat: '微信', alipay: '支付宝', xiaohongshu: '小红书', xhs: '小红书', camera: '系统相机 / 浏览器', safari: 'Safari', browser: '网页', qr: '网页二维码', manual: '手动测试', unknown: '未识别' };
    var statusNames = { played: '播报完成', success: '播报完成', failed: '播报失败', pending: '等待播报', received: '已收到', duplicate: '重复已合并' };
    if (!data.recentScans.length) emptyRecords('这个筛选范围内，还没有扫码记录。');
    else {
      byId('recordsBody').replaceChildren();
      data.recentScans.forEach(function (record) {
        var row = document.createElement('tr');
        var visitor = record.visitorId || record.anonymousId || '';
        row.append(cell(formattedTime(record.createdAt)), cell(eventName(record.eventId)), cell(record.kind === 'profile_click' ? '去主页' : '扫码访问'), cell(sourceNames[record.source] || record.source || '未识别'), cell(visitor ? String(visitor).slice(0, 10) + '…' : '未记录'), cell(statusNames[record.status] || record.status || '已记录', 'record-state' + (record.status === 'failed' ? ' bad' : '')));
        byId('recordsBody').appendChild(row);
      });
    }
    byId('recordsHint').textContent = '显示最近 ' + data.recentScans.length + ' 条记录；导出 CSV 可获取当前筛选范围的完整记录。' + (data.summary.unidentifiedVisits ? '其中 ' + numberFormat.format(data.summary.unidentifiedVisits) + ' 次访问未能取得匿名标识。' : '');
    byId('updatedAt').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    statsReady = true; byId('exportButton').disabled = false;
  }
  async function refreshStats() {
    var sequence = ++requestSequence;
    clearMetrics(); emptyRecords('正在获取记录…');
    byId('recordsHint').textContent = '';
    byId('refreshButton').disabled = true;
    setStatus('dashboardStatus', '正在从服务端读取数据…');
    try {
      var query = filterQuery();
      var data = await request('/api/admin/stats?' + query.toString());
      if (sequence !== requestSequence) return;
      renderStats(data);
      setStatus('dashboardStatus', '已读取保存的记录。', 'good');
    } catch (error) {
      if (sequence !== requestSequence) return;
      clearMetrics(); emptyRecords('数据未能加载，请重试。');
      byId('updatedAt').textContent = '数据未加载';
      setStatus('dashboardStatus', error.message, 'bad');
      if (error.status === 401) showLogin(error.message);
    } finally { if (sequence === requestSequence) byId('refreshButton').disabled = false; }
  }
  async function enterDashboard() {
    byId('loginPanel').classList.add('hidden');
    byId('dashboard').classList.remove('hidden');
    byId('logoutButton').classList.remove('hidden');
    setStatus('dashboardStatus', '正在读取活动配置…');
    try { await loadEvents(); await refreshStats(); }
    catch (error) {
      clearMetrics(); emptyRecords('活动配置未能加载，暂不显示统计。');
      setStatus('dashboardStatus', error.message, 'bad');
      if (error.status === 401) showLogin(error.message);
    }
  }
  function download(blob, filename) {
    var url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  function isHttpsUrl(value) {
    try { var url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch (_) { return false; }
  }
  function showNativePreview() {
    var event = selectedEvent();
    var remote = event && isHttpsUrl(event.nativeQrUrl) ? event.nativeQrUrl : '';
    if (event && /^\/api\/events\/[a-zA-Z0-9_-]+\/native-qr(?:\?|$)/.test(event.nativeQrUrl || '')) remote = apiBase + event.nativeQrUrl;
    var dataUrl = event && /^data:image\/(png|jpeg|webp);base64,/.test(event.nativeQrDataUrl || '') ? event.nativeQrDataUrl : '';
    var image = byId('nativeQrImage');
    var src = dataUrl || remote;
    image.classList.toggle('hidden', !src);
    byId('nativeQrEmpty').classList.toggle('hidden', Boolean(src));
    byId('nativeStorageBadge').textContent = src ? '已保存至活动' : '活动云端配置';
    image.onload = function () {};
    image.onerror = function () { image.classList.add('hidden'); byId('nativeQrEmpty').classList.remove('hidden'); setStatus('nativeUrlStatus', '图片无法加载，请确认填写的是可访问的官方二维码图片地址。', 'bad'); };
    if (src) image.src = src; else image.removeAttribute('src');
    byId('downloadQrButton').disabled = !src;
    byId('removeQrButton').disabled = !src;
  }
  function validImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), image = new Image();
      image.onload = function () { URL.revokeObjectURL(url); image.naturalWidth >= 100 && image.naturalHeight >= 100 ? resolve() : reject(new Error('图片尺寸太小，请上传清晰的二维码原图。')); };
      image.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片无法读取，请选择有效的 PNG、JPG 或 WebP 图片。')); };
      image.src = url;
    });
  }

  byId('loginForm').addEventListener('submit', async function (event) {
    event.preventDefault(); byId('loginButton').disabled = true;
    setStatus('loginStatus', '正在验证口令…');
    try {
      var result = await request('/api/admin/login', { method: 'POST', body: { token: byId('adminPassword').value } });
      token = result.sessionToken || ''; storedToken(token);
      byId('adminPassword').value = '';
      await enterDashboard();
    } catch (error) { setStatus('loginStatus', error.message, 'bad'); }
    finally { byId('loginButton').disabled = false; }
  });
  byId('logoutButton').addEventListener('click', async function () {
    byId('logoutButton').disabled = true;
    try { await request('/api/admin/logout', { method: 'POST' }); showLogin(); setStatus('loginStatus', '已退出后台。'); }
    catch (error) { setStatus('dashboardStatus', '退出失败：' + error.message + ' 请重试。', 'bad'); }
    finally { byId('logoutButton').disabled = false; }
  });
  byId('filterForm').addEventListener('submit', async function (event) { event.preventDefault(); if (!events.length) { try { await loadEvents(); } catch (error) { setStatus('dashboardStatus', error.message, 'bad'); return; } } await refreshStats(); });
  byId('eventFilter').addEventListener('change', function () { updateSessions(); invalidateMetrics(); });
  ['sessionFilter', 'fromDate', 'toDate'].forEach(function (id) { byId(id).addEventListener('change', invalidateMetrics); });
  byId('allDatesButton').addEventListener('click', function () { byId('fromDate').value = ''; byId('toDate').value = ''; refreshStats(); });
  byId('exportButton').addEventListener('click', async function () {
    if (!statsReady) return;
    byId('exportButton').disabled = true;
    try { var query = filterQuery(); query.set('format', 'csv'); var blob = await request('/api/admin/stats?' + query, { blob: true, headers: { Accept: 'text/csv' } }); download(blob, '大迪在面壁-扫码记录-' + new Date().toISOString().slice(0, 10) + '.csv'); }
    catch (error) { setStatus('dashboardStatus', '导出失败：' + error.message, 'bad'); }
    finally { byId('exportButton').disabled = !statsReady; }
  });
  byId('newSessionForm').addEventListener('submit', async function (event) {
    event.preventDefault(); var selected = selectedEvent(); if (!selected) return;
    var name = byId('sessionName').value.trim(); if (!name) return;
    byId('newSessionButton').disabled = true;
    try { await request('/api/events/' + encodeURIComponent(selected.eventId) + '/sessions', { method: 'POST', body: { name: name } }); byId('sessionName').value = ''; await loadEvents(); setStatus('sessionStatus', '新场次已开始，之后的扫码将记入新场次。历史数据已保留。', 'good'); await refreshStats(); }
    catch (error) { setStatus('sessionStatus', error.message, 'bad'); }
    finally { byId('newSessionButton').disabled = !selectedEvent(); }
  });
  byId('nativeUrlForm').addEventListener('submit', async function (event) {
    event.preventDefault(); var selected = selectedEvent(); if (!selected) return;
    var url = byId('nativeQrUrl').value.trim();
    if (url && !isHttpsUrl(url)) { setStatus('nativeUrlStatus', '请输入不含账号口令的 HTTPS 图片地址。', 'bad'); return; }
    byId('saveNativeUrlButton').disabled = true;
    try { await request('/api/events/' + encodeURIComponent(selected.eventId), { method: 'PATCH', body: { nativeQrUrl: url, nativeQrDataUrl: '' } }); selected.nativeQrUrl = url; selected.nativeQrDataUrl = ''; showNativePreview(); setStatus('nativeUrlStatus', url ? '已保存到活动配置，可在其他设备读取。' : '已清除活动中的图片地址。', 'good'); }
    catch (error) { setStatus('nativeUrlStatus', error.message, 'bad'); }
    finally { byId('saveNativeUrlButton').disabled = !selectedEvent(); }
  });
  byId('nativeQrFile').addEventListener('change', async function () {
    var file = this.files && this.files[0], selected = selectedEvent(); if (!file || !selected) return;
    this.disabled = true; setStatus('nativeQrStatus', '正在检查并保存图片…');
    try {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 512 * 1024) throw new Error('请选择不超过 512 KB 的 PNG、JPG 或 WebP 图片。');
      await validImage(file);
      var dataUrl = await new Promise(function (resolve, reject) { var reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = function () { reject(new Error('图片读取失败。')); }; reader.readAsDataURL(file); });
      await request('/api/events/' + encodeURIComponent(selected.eventId), { method: 'PATCH', body: { nativeQrDataUrl: dataUrl, nativeQrUrl: '' } });
      selected.nativeQrDataUrl = dataUrl; selected.nativeQrUrl = ''; showNativePreview();
      setStatus('nativeQrStatus', '已保存到“' + (selected.name || selected.eventId) + '”。现场 iPad 刷新后即可使用；还需要用你的小红书 App 实扫确认。', 'good');
    } catch (error) { setStatus('nativeQrStatus', error.message, 'bad'); }
    this.value = ''; this.disabled = !selectedEvent();
  });
  byId('downloadQrButton').addEventListener('click', async function () {
    var src = byId('nativeQrImage').getAttribute('src'); if (!src) return;
    try { var response = await fetch(src); if (!response.ok) throw new Error('图片下载失败。'); var blob = await response.blob(); var extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'; download(blob, '小红书个人主页二维码.' + extension); }
    catch (_) { setStatus('nativeQrStatus', '下载未成功，可以长按上方二维码图片保存。', 'bad'); }
  });
  byId('removeQrButton').addEventListener('click', async function () {
    var selected = selectedEvent(); if (!selected) return;
    byId('removeQrButton').disabled = true;
    try { await request('/api/events/' + encodeURIComponent(selected.eventId), { method: 'PATCH', body: { nativeQrDataUrl: '', nativeQrUrl: '' } }); selected.nativeQrDataUrl = ''; selected.nativeQrUrl = ''; byId('nativeQrUrl').value = ''; showNativePreview(); setStatus('nativeQrStatus', '已从该活动移除图片。原图片文件不受影响，可重新上传恢复。'); }
    catch (error) { setStatus('nativeQrStatus', error.message, 'bad'); showNativePreview(); }
  });

  (async function () {
    token = storedToken();
    try { await request('/api/admin/session'); await enterDashboard(); }
    catch (error) { if (token || error.status !== 401) showLogin(error.message); }
  }());
}());
