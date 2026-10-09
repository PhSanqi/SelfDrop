const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function lastOf(list) {
  return list.length ? list[list.length - 1] : undefined;
}

function isIOSWebKit() {
  const ua = navigator.userAgent || '';
  return /iP(?:hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

const state = {
  messages: [],
  ids: new Set(),
  hiddenIds: new Set(JSON.parse(localStorage.getItem('drop.hiddenMessageIds') || '[]')),
  view: 'chat',
  fileFilter: 'all',
  connected: false,
  eventSource: null,
  reconnectTimer: null,
  syncPromise: null,
  uploading: false,
  uploadSession: null,
  followLatest: true,
  userScrollIntent: false,
  cursor: 'all',
  device: localStorage.getItem('drop.deviceName') || detectDevice(),
  theme: localStorage.getItem('drop.theme') || 'system',
};

const els = {
  messageList: $('#messageList'),
  messageStage: $('#messageStage'),
  messageInput: $('#messageInput'),
  sendButton: $('#sendButton'),
  attachButton: $('#attachButton'),
  photoInput: $('#photoInput'),
  fileInput: $('#fileInput'),
  fileLibrary: $('#fileLibrary'),
  fileCount: $('#fileCount'),
  detailFileCount: $('#detailFileCount'),
  connectionLabel: $('#connectionLabel'),
  presenceDot: $('#presenceDot'),
  headerDevice: $('#headerDevice'),
  sidebarDevice: $('#sidebarDevice'),
  deviceInput: $('#deviceInput'),
  conversationPreview: $('#conversationPreview'),
  conversationTime: $('#conversationTime'),
  detailsPanel: $('#detailsPanel'),
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
  jumpLatest: $('#jumpLatest'),
  uploadProgress: $('#uploadProgress'),
  uploadLabel: $('#uploadLabel'),
  uploadPercent: $('#uploadPercent'),
  uploadSpeed: $('#uploadSpeed'),
  progressBar: $('#progressBar'),
  uploadCancel: $('#uploadCancel'),
  dropOverlay: $('#dropOverlay'),
  toastRegion: $('#toastRegion'),
  restoreDisplay: $('#restoreDisplay'),
  restoreDisplayNote: $('#restoreDisplayNote'),
  attachmentSheet: $('#attachmentSheet'),
  purgeSheet: $('#purgeSheet'),
  purgeSummary: $('#purgeSummary'),
  purgeFiles: $('#purgeFiles'),
  purgeAll: $('#purgeAll'),
};

function detectDevice() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux';
  return '当前设备';
}

function applyTheme(theme) {
  state.theme = theme;
  localStorage.setItem('drop.theme', theme);
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $$('[data-theme-option]').forEach((button) => button.classList.toggle('active', button.dataset.themeOption === theme));
}

function updateDevice(device) {
  state.device = device.trim() || detectDevice();
  localStorage.setItem('drop.deviceName', state.device);
  els.deviceInput.value = state.device;
  els.headerDevice.textContent = state.device;
  els.sidebarDevice.textContent = state.device;
  renderMessages(false);
}

function formatTime(epoch) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(epoch * 1000));
}

function formatDay(epoch) {
  const date = new Date(epoch * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(date, today)) return '今天';
  if (same(date, yesterday)) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(date);
}

function formatSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes > 100 * 1024 ? 0 : 1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes > 100 * 1024 ** 2 ? 0 : 1)} MB`;
}

async function readApiJson(response) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    if (response.redirected || /cdn-cgi\/access/i.test(response.url || '')) {
      throw new Error('登录状态可能已失效，请刷新页面并重新登录后再试');
    }
    throw new Error(`接口返回异常（HTTP ${response.status}），请刷新页面后再试`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('接口返回内容异常，请刷新页面后再试');
  }
}

function escapeText(text) {
  const node = document.createElement('div');
  node.textContent = text;
  return node.innerHTML;
}

function fileSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7v-17Z"/><path d="M14 3.5v4h4"/></svg>';
}

function downloadSvg() {
  return '<svg class="download-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M8 11l4 4 4-4M5 19h14"/></svg>';
}

function attachmentUrl(attachment) {
  const raw = String(attachment?.url || '');
  if (!raw) return '#';
  if (raw.startsWith('/file/') || raw.startsWith('/large/')) return raw;
  try {
    const parsed = new URL(raw, location.origin);
    if (parsed.pathname.startsWith('/file/') || parsed.pathname.startsWith('/large/')) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch { /* fall through to legacy ntfy attachment handling */ }
  const leaf = raw.split('/').filter(Boolean).pop();
  return leaf ? `/file/${leaf}` : '#';
}

function initials(device) {
  return [...(device || '设')][0]?.toUpperCase() || '设';
}

function attachmentPreviewUrl(attachment) {
  const url = attachmentUrl(attachment);
  return attachment?.type?.startsWith('image/') && url.startsWith('/large/')
    ? `${url}${url.includes('?') ? '&' : '?'}preview=1`
    : url;
}

function attachmentMarkup(attachment) {
  if (!attachment) return '';
  const url = attachmentUrl(attachment);
  if (attachment.type?.startsWith('image/')) {
    const previewUrl = attachmentPreviewUrl(attachment);
    return `<a class="image-link" href="${previewUrl}" target="_blank" rel="noreferrer"><img class="attachment-image" loading="lazy" src="${previewUrl}" alt="${escapeText(attachment.name || '图片')}" /></a>`;
  }
  return `<a class="file-card" href="${url}" download="${escapeText(attachment.name || '文件')}">
    <span class="file-icon">${fileSvg()}</span>
    <span class="file-copy"><strong>${escapeText(attachment.name || '文件')}</strong><span>${formatSize(attachment.size)}</span></span>
    ${downloadSvg()}
  </a>`;
}

function isNearBottom() {
  return els.messageStage.scrollHeight - els.messageStage.scrollTop - els.messageStage.clientHeight < 160;
}

function snapLatest() {
  if (!state.followLatest || state.view !== 'chat') return;
  els.messageStage.scrollTop = els.messageStage.scrollHeight;
  els.jumpLatest.classList.remove('visible');
}

function visibleMessages() {
  return state.messages.filter((message) => !state.hiddenIds.has(message.id));
}

function saveHiddenMessages() {
  localStorage.setItem('drop.hiddenMessageIds', JSON.stringify([...state.hiddenIds]));
  const count = state.hiddenIds.size;
  els.restoreDisplay.hidden = count === 0;
  els.restoreDisplayNote.textContent = count ? `恢复 ${count} 条已清空消息` : '恢复这台设备已清空的消息';
}

function renderMessages(keepScroll = true) {
  const shouldStick = !keepScroll || state.followLatest || isNearBottom();
  const messages = visibleMessages();
  if (!messages.length) {
    els.messageList.innerHTML = `<div class="empty-state"><div>
      <span class="empty-state-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14v10H9l-4 3v-13Z"/></svg></span>
      <strong>这是你的私人传输空间</strong>
      <p>从任意设备发一段文字、粘贴截图，或者把文件直接拖进这里。</p>
    </div></div>`;
    updateSummary();
    renderFiles();
    return;
  }

  let lastDay = '';
  let previousMessage = null;
  els.messageList.innerHTML = messages.map((message) => {
    const day = formatDay(message.time);
    const divider = day !== lastDay ? `<div class="day-divider"><span>${day}</span></div>` : '';
    const grouped = previousMessage && day === lastDay && previousMessage.device === message.device && message.time - previousMessage.time <= 5 * 60;
    lastDay = day;
    const mine = message.device === state.device;
    const markup = `${divider}<article class="message-row ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}" data-id="${message.id}" data-sequence-id="${escapeText(message.sequenceId || message.id)}">
      <div class="message-avatar" aria-hidden="true">${escapeText(initials(message.device))}</div>
      <div class="message-stack">
        <div class="message-meta"><strong>${mine ? '此设备' : escapeText(message.device)}</strong><time>${formatTime(message.time)}</time></div>
        <div class="bubble-wrap">
          <button class="message-delete" type="button" data-delete-message="${escapeText(message.sequenceId || message.id)}" aria-label="删除这条消息" title="删除消息">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
          </button>
          <div class="bubble">${attachmentMarkup(message.attachment)}${message.text ? `<div class="bubble-text">${escapeText(message.text)}</div>` : ''}</div>
        </div>
      </div>
    </article>`;
    previousMessage = message;
    return markup;
  }).join('');
  updateSummary();
  renderFiles();
  if (shouldStick) scrollLatest();
}

function updateSummary() {
  const last = lastOf(visibleMessages());
  const attachments = visibleMessages().filter((message) => message.attachment);
  els.fileCount.textContent = String(attachments.length);
  els.detailFileCount.textContent = attachments.length ? `${attachments.length} 个附件` : '暂无附件';
  if (!last) {
    els.conversationPreview.textContent = '只在自己的设备间可见';
    els.conversationTime.textContent = '';
    return;
  }
  els.conversationPreview.textContent = last.attachment ? `文件 · ${last.attachment.name}` : last.text;
  els.conversationTime.textContent = formatTime(last.time);
}

function removeSequence(sequenceId) {
  const removedIds = state.messages
    .filter((message) => (message.sequenceId || message.id) === sequenceId)
    .map((message) => message.id);
  if (!removedIds.length) return;
  const removedSet = new Set(removedIds);
  state.messages = state.messages.filter((message) => !removedSet.has(message.id));
  removedIds.forEach((id) => {
    state.ids.delete(id);
    state.hiddenIds.delete(id);
  });
  saveHiddenMessages();
  renderMessages(true);
}

async function deleteMessage(sequenceId) {
  if (!sequenceId) return;
  const response = await fetch(`/api/messages/${encodeURIComponent(sequenceId)}`, { method: 'DELETE' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '删除失败');
  removeSequence(data.sequenceId || sequenceId);
}

function clearDisplay() {
  state.messages.forEach((message) => state.hiddenIds.add(message.id));
  saveHiddenMessages();
  renderMessages(false);
  closeOverlays();
  toast('已清空这台设备的显示');
}

function restoreDisplay() {
  state.hiddenIds.clear();
  saveHiddenMessages();
  renderMessages(false);
  closeOverlays();
  toast('已恢复历史显示');
}

function renderFiles() {
  const items = visibleMessages().filter((message) => message.attachment).reverse().filter((message) => {
    if (state.fileFilter === 'image') return message.attachment.type?.startsWith('image/');
    if (state.fileFilter === 'file') return !message.attachment.type?.startsWith('image/');
    return true;
  });
  if (!items.length) {
    els.fileLibrary.innerHTML = `<div class="library-empty"><div>这里还没有${state.fileFilter === 'image' ? '图片' : state.fileFilter === 'file' ? '文件' : '附件'}。</div></div>`;
    return;
  }
  els.fileLibrary.innerHTML = items.map((message) => {
    const a = message.attachment;
    const url = attachmentUrl(a);
    const previewUrl = attachmentPreviewUrl(a);
    const preview = a.type?.startsWith('image/')
      ? `<div class="library-image"><img loading="lazy" src="${previewUrl}" alt="${escapeText(a.name)}" /></div>`
      : `<div class="library-file">${fileSvg()}</div>`;
    const openUrl = a.type?.startsWith('image/') ? previewUrl : url;
    return `<article class="library-card"><a href="${openUrl}" target="_blank" rel="noreferrer">${preview}<div class="library-copy"><strong>${escapeText(a.name)}</strong><span>${formatSize(a.size)} · ${escapeText(message.device)} · ${formatDay(message.time)} ${formatTime(message.time)}</span></div></a></article>`;
  }).join('');
}

function createUploadConfirmationWaiter(file, session) {
  if (!session?.confirmWaiters) return { promise: new Promise(() => {}), cancel() {} };
  let resolvePromise;
  const entry = {
    name: file.name,
    size: Number(file.size) || 0,
    device: state.device,
    resolve(message) {
      session.confirmWaiters.delete(entry);
      resolvePromise(message);
    },
  };
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  session.confirmWaiters.add(entry);
  return {
    promise,
    cancel() { session.confirmWaiters.delete(entry); },
  };
}

function notifyUploadConfirmation(message) {
  const session = state.uploadSession;
  const attachment = message?.attachment;
  if (!session?.confirmWaiters?.size || !attachment) return;
  for (const waiter of session.confirmWaiters) {
    if (waiter.name !== attachment.name) continue;
    if (waiter.size !== Number(attachment.size || 0)) continue;
    if (waiter.device !== message.device) continue;
    waiter.resolve(message);
    break;
  }
}

function addMessage(message, options = {}) {
  notifyUploadConfirmation(message);
  if (!message?.id || state.ids.has(message.id)) return;
  state.ids.add(message.id);
  state.messages.push(message);
  state.messages.sort((a, b) => a.time - b.time);
  renderMessages(options.keepScroll ?? true);
}

async function loadMessages(options = {}) {
  if (state.syncPromise) return state.syncPromise;
  const quiet = options.quiet ?? false;
  state.syncPromise = (async () => {
    if (!quiet) setConnection('connecting');
    const response = await fetch('/api/messages', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法同步历史消息');
    const data = await response.json();
    state.messages = data.messages || [];
    state.ids = new Set(state.messages.map((message) => message.id));
  state.cursor = data.cursor || lastOf(state.messages)?.time || 'all';
    state.hiddenIds = new Set([...state.hiddenIds].filter((id) => state.ids.has(id)));
    saveHiddenMessages();
    renderMessages(!state.followLatest && !isNearBottom());
    connectEvents();
  })();
  try {
    return await state.syncPromise;
  } finally {
    state.syncPromise = null;
  }
}

function scheduleReconnect(delay = 2200) {
  clearTimeout(state.reconnectTimer);
  if (document.hidden || !navigator.onLine) return;
  state.reconnectTimer = setTimeout(async () => {
    try {
      await loadMessages({ quiet: true });
    } catch {
      setConnection('offline');
      scheduleReconnect(Math.min(delay * 1.6, 12000));
    }
  }, delay);
}

function connectEvents() {
  clearTimeout(state.reconnectTimer);
  state.eventSource?.close();
  const since = state.cursor || lastOf(state.messages)?.time || 'all';
  const source = new EventSource(`/api/events?since=${encodeURIComponent(since)}`);
  state.eventSource = source;
  source.onopen = () => setConnection('online');
  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.time) state.cursor = Math.max(Number(state.cursor) || 0, Number(payload.time) || 0);
      if (payload.event === 'purge') {
        loadMessages({ quiet: true }).catch(() => {});
      } else if (payload.event === 'delete') removeSequence(payload.sequenceId);
      else addMessage(payload);
    } catch { /* ignore malformed event */ }
  };
  source.onerror = () => {
    if (state.eventSource !== source) return;
    source.close();
    state.eventSource = null;
    setConnection('offline');
    scheduleReconnect();
  };
}

function setConnection(status) {
  state.connected = status === 'online';
  els.presenceDot.className = `presence-dot ${status === 'online' ? 'online' : status === 'offline' ? 'offline' : ''}`;
  els.connectionLabel.textContent = status === 'online' ? '已连接' : status === 'offline' ? '正在重连' : '正在连接';
}

async function sendText() {
  const text = els.messageInput.value.trim();
  if (!text) return;
  els.sendButton.disabled = true;
  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, device: state.device }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '发送失败');
    els.messageInput.value = '';
    resizeComposer();
    addMessage(data, { keepScroll: false });
  } catch (error) {
    toast(error.message || '发送失败', true);
  } finally {
    els.sendButton.disabled = false;
    els.messageInput.focus();
    if (state.followLatest) setTimeout(snapLatest, 80);
  }
}

function uploadCancelledError() {
  const error = new Error('上传已取消');
  error.name = 'UploadCancelledError';
  return error;
}

function throwIfUploadCancelled(session) {
  if (session?.cancelled) throw uploadCancelledError();
}

async function uploadOne(file, onProgress, session, onPhase = () => {}) {
  let xhr;
  const waiter = createUploadConfirmationWaiter(file, session);
  const request = new Promise((resolve, reject) => {
    try { throwIfUploadCancelled(session); } catch (error) { reject(error); return; }
    xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?filename=${encodeURIComponent(file.name)}&device=${encodeURIComponent(state.device)}`);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    session?.xhrs.add(xhr);
    const cleanup = () => session?.xhrs.delete(xhr);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded, event.total);
        if (event.total > 0 && event.loaded >= event.total) onPhase('confirming');
      }
    };
    xhr.onerror = () => { cleanup(); reject(new Error('网络连接中断')); };
    xhr.onabort = () => { cleanup(); reject(uploadCancelledError()); };
    xhr.onload = () => {
      cleanup();
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* keep fallback */ }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(data.error || `文件发送失败 (${xhr.status})`));
      resolve(data);
    };
    xhr.send(file);
  });
  try {
    const result = await Promise.race([
      request.then((data) => ({ source: 'http', data })),
      waiter.promise.then((data) => ({ source: 'sse', data })),
    ]);
    if (result.source === 'sse' && xhr?.readyState !== XMLHttpRequest.DONE) {
      try { xhr.abort(); } catch { /* server already confirmed through SSE */ }
    }
    return result.data;
  } finally {
    waiter.cancel();
  }
}

function uploadChunk(uploadId, index, blob, onProgress, session) {
  return new Promise((resolve, reject) => {
    try { throwIfUploadCancelled(session); } catch (error) { reject(error); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/large/${encodeURIComponent(uploadId)}/chunk/${index}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    session?.xhrs.add(xhr);
    const cleanup = () => session?.xhrs.delete(xhr);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onerror = () => {
      cleanup();
      const error = new Error('网络连接中断');
      error.status = 0;
      reject(error);
    };
    xhr.onabort = () => {
      cleanup();
      const error = uploadCancelledError();
      error.status = 0;
      reject(error);
    };
    xhr.onload = () => {
      cleanup();
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* keep fallback */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = new Error(data.error || `分块上传失败 (${xhr.status})`);
        error.status = xhr.status;
        return reject(error);
      }
      resolve(data);
    };
    xhr.send(blob);
  });
}

function sleep(ms, session) {
  if (!session) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfUploadCancelled(session);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.controller.signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(uploadCancelledError());
    };
    session.controller.signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForUploadWindow(session) {
  throwIfUploadCancelled(session);
  if (!document.hidden && navigator.onLine) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
      session?.controller.signal.removeEventListener('abort', onAbort);
    };
    const check = () => {
      if (document.hidden || !navigator.onLine) return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(uploadCancelledError());
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    session?.controller.signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function uploadChunkWithRetry(uploadId, index, blob, onProgress, session, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfUploadCancelled(session);
    await waitForUploadWindow(session);
    onProgress(0, blob.size);
    try {
      return await uploadChunk(uploadId, index, blob, onProgress, session);
    } catch (error) {
      if (session?.cancelled || error.name === 'UploadCancelledError') throw uploadCancelledError();
      lastError = error;
      const retryable = !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === attempts - 1) throw error;
      await sleep(350 * (2 ** attempt), session);
    }
  }
  throw lastError || new Error('分块上传失败');
}

async function cleanupLargeUpload(uploadId) {
  if (!uploadId) return;
  try {
    await fetch(`/api/large/${encodeURIComponent(uploadId)}`, { method: 'DELETE', cache: 'no-store' });
  } catch { /* best-effort cleanup; server retention also removes abandoned tasks */ }
}

async function uploadLargeOne(file, onProgress, { mobile = false, session, onPhase = () => {} } = {}) {
  throwIfUploadCancelled(session);
  const ios = isIOSWebKit();
  let source = file;
  if (ios && file.size <= 32 * 1024 * 1024) {
    // Current iOS WebKit releases can lose access to the native picker-backed
    // file in the network process. Copy normal photos/small media into page
    // memory up front so the upload no longer depends on that backing file.
    const buffer = await file.arrayBuffer();
    throwIfUploadCancelled(session);
    source = new File([buffer], file.name, { type: file.type || 'application/octet-stream', lastModified: file.lastModified });
  }
  const preferredChunkSize = (mobile || ios) ? 4 * 1024 * 1024 : 16 * 1024 * 1024;
  const initResponse = await fetch('/api/large/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: session?.controller.signal,
    body: JSON.stringify({
      name: source.name,
      size: source.size,
      type: source.type || 'application/octet-stream',
      device: state.device,
      chunkSize: preferredChunkSize,
    }),
  });
  const init = await initResponse.json();
  if (!initResponse.ok) throw new Error(init.error || '无法创建大文件上传任务');
  session?.uploadIds.add(init.uploadId);

  const chunkLoaded = new Array(init.chunkCount).fill(0);
  let nextChunk = 0;
  const report = () => onProgress(chunkLoaded.reduce((sum, value) => sum + value, 0), file.size);
  const worker = async () => {
    while (nextChunk < init.chunkCount && !session?.cancelled) {
      const index = nextChunk++;
      const start = index * init.chunkSize;
      const end = Math.min(source.size, start + init.chunkSize);
      let blob = source.slice(start, end);
      if (ios) {
        // Safari/iOS 26.x can silently send a disk-backed File/Blob as an empty
        // request body. Materialize each bounded chunk in page memory before it
        // crosses into WebKit's networking process. 4 MiB keeps memory bounded.
        blob = new Blob([await blob.arrayBuffer()], { type: 'application/octet-stream' });
      }
      await uploadChunkWithRetry(init.uploadId, index, blob, (bytes) => {
        chunkLoaded[index] = bytes;
        report();
      }, session);
      chunkLoaded[index] = blob.size;
      report();
    }
  };

  try {
    // iOS/移动端减少同时读取的本地文件片段，但仍保留两路请求利用高延迟链路。
    const chunkWorkers = ios ? 1 : mobile ? 2 : 3;
    await Promise.all(Array.from({ length: Math.min(chunkWorkers, init.chunkCount) }, () => worker()));
    throwIfUploadCancelled(session);
    onPhase('confirming');
    const waiter = createUploadConfirmationWaiter(file, session);
    const completeRequest = (async () => {
      const completeResponse = await fetch(`/api/large/${encodeURIComponent(init.uploadId)}/complete`, {
        method: 'POST',
        signal: session?.controller.signal,
      });
      const completed = await completeResponse.json();
      if (!completeResponse.ok) throw new Error(completed.error || '大文件合并失败');
      return completed;
    })();
    let completed;
    try {
      const result = await Promise.race([
        completeRequest.then((data) => ({ source: 'http', data })),
        waiter.promise.then((data) => ({ source: 'sse', data })),
      ]);
      completed = result.data;
    } finally {
      waiter.cancel();
    }
    session?.uploadIds.delete(init.uploadId);
    onProgress(file.size, file.size);
    return completed;
  } catch (error) {
    await cleanupLargeUpload(init.uploadId);
    session?.uploadIds.delete(init.uploadId);
    if (session?.cancelled || error.name === 'AbortError' || error.name === 'UploadCancelledError') throw uploadCancelledError();
    throw error;
  }
}

function cancelCurrentUpload() {
  const session = state.uploadSession;
  if (!session || session.cancelled) return;
  session.cancelled = true;
  els.uploadCancel.disabled = true;
  els.uploadLabel.textContent = '正在停止上传…';
  els.uploadSpeed.textContent = '停止中';
  session.controller.abort();
  [...session.xhrs].forEach((xhr) => {
    try { xhr.abort(); } catch { /* already settled */ }
  });
  const ids = [...session.uploadIds];
  Promise.allSettled(ids.map((id) => cleanupLargeUpload(id)));
}

async function uploadFiles(files) {
  const list = [...files].filter(Boolean);
  if (!list.length) return;
  if (state.uploading) {
    toast('已有文件正在上传，请等待当前队列完成', true);
    return;
  }

  const valid = [];
  for (const file of list) {
    if (file.size > 4 * 1024 * 1024 * 1024) toast(`${file.name} 超过 4 GB，已跳过`, true);
    else valid.push(file);
  }
  if (!valid.length) return;

  // Returning from a system photo/file picker can leave the visual viewport at
  // an old scroll position. A local send is an explicit intent to return to the
  // newest message, so pin the chat before and after the upload lifecycle.
  state.followLatest = true;
  scrollLatest();

  state.uploading = true;
  const session = {
    cancelled: false,
    controller: new AbortController(),
    xhrs: new Set(),
    uploadIds: new Set(),
    confirmWaiters: new Set(),
  };
  state.uploadSession = session;
  els.attachButton.disabled = true;
  els.uploadCancel.hidden = false;
  els.uploadCancel.disabled = false;
  const mobile = isCompactPointer();
  const ios = isIOSWebKit();
  const totalBytes = valid.reduce((sum, file) => sum + file.size, 0);
  const loaded = new Array(valid.length).fill(0);
  const started = performance.now();
  const activeNames = new Set();
  const confirmingIndexes = new Set();
  const failures = [];
  let settled = 0;
  let succeeded = 0;
  let nextIndex = 0;

  const renderProgress = () => {
    const sent = loaded.reduce((sum, value) => sum + value, 0);
    const rawPercent = totalBytes ? Math.min(100, Math.round(sent / totalBytes * 100)) : 100;
    const fullySettled = settled >= valid.length;
    const percent = rawPercent >= 100 && !fullySettled ? 99 : rawPercent;
    const elapsed = Math.max(0.25, (performance.now() - started) / 1000);
    const speed = sent / elapsed;
    const waitingForServer = confirmingIndexes.size > 0 && rawPercent >= 100 && !fullySettled;
    const speedText = waitingForServer
      ? '服务器确认中'
      : sent <= 0
      ? '准备中'
      : speed >= 1024 * 1024
        ? `${(speed / 1024 / 1024).toFixed(1)} MB/s`
        : `${Math.max(1, Math.round(speed / 1024))} KB/s`;
    els.progressBar.style.width = `${percent}%`;
    const active = [...activeNames];
    if (waitingForServer && valid.length === 1) {
      els.uploadLabel.textContent = `已发送 · 等待服务器确认 · ${valid[0].name}`;
    } else if (waitingForServer) {
      els.uploadLabel.textContent = `已发送 · 正在确认 ${Math.max(1, confirmingIndexes.size)} 个文件`;
    } else if (valid.length === 1) {
      els.uploadLabel.textContent = `正在上传 · ${valid[0].name}`;
    } else if (active.length) {
      els.uploadLabel.textContent = `正在上传 ${Math.min(settled + 1, valid.length)}/${valid.length} · ${active[0]}${active.length > 1 ? ` +${active.length - 1}` : ''}`;
    } else {
      els.uploadLabel.textContent = `准备上传 · ${valid.length} 个文件`;
    }
    els.uploadPercent.textContent = `${percent}%`;
    els.uploadSpeed.textContent = speedText;
  };

  els.progressBar.style.width = '0%';
  els.uploadProgress.classList.remove('hidden');
  renderProgress();

  const worker = async () => {
    while (nextIndex < valid.length && !session.cancelled) {
      const index = nextIndex++;
      const file = valid[index];
      activeNames.add(file.name);
      renderProgress();
      try {
        // Mobile browsers use the resumable transport for every file. This avoids
        // relying on one long request/file-provider handle and makes retries safe.
        const uploader = ios || mobile || file.size > 90 * 1024 * 1024
          ? (target, progress, phase) => uploadLargeOne(target, progress, { mobile: mobile || ios, session, onPhase: phase })
          : (target, progress, phase) => uploadOne(target, progress, session, phase);
        const data = await uploader(file, (bytes) => {
          loaded[index] = bytes;
          renderProgress();
        }, (phase) => {
          if (phase === 'confirming') confirmingIndexes.add(index);
          renderProgress();
        });
        loaded[index] = file.size;
        confirmingIndexes.delete(index);
        succeeded += 1;
        addMessage(data, { keepScroll: false });
      } catch (error) {
        if (!session.cancelled && error.name !== 'UploadCancelledError' && error.name !== 'AbortError') {
          loaded[index] = 0;
          failures.push(file.name);
          toast(`${file.name}：${error.message || '发送失败'}`, true);
        }
      } finally {
        confirmingIndexes.delete(index);
        activeNames.delete(file.name);
        settled += 1;
        renderProgress();
      }
    }
  };

  try {
    // Keep at most two upload requests active on mobile. Small photo batches can
    // send two files in parallel; larger files use one file queue with two chunks
    // in flight, which avoids the memory pressure of parallel video reads.
    const mobileSmallBatch = mobile && !ios && valid.every((file) => file.size <= 4 * 1024 * 1024);
    const fileWorkers = ios ? 1 : mobileSmallBatch ? 2 : mobile ? 1 : 2;
    await Promise.all(Array.from({ length: Math.min(fileWorkers, valid.length) }, () => worker()));

    if (session.cancelled) {
      els.uploadLabel.textContent = `已停止上传 · 已完成 ${succeeded}/${valid.length}`;
      els.uploadSpeed.textContent = '已停止';
      setTimeout(() => els.uploadProgress.classList.add('hidden'), 2800);
    } else if (failures.length) {
      els.uploadLabel.textContent = `上传结束 · 成功 ${succeeded}/${valid.length} · 失败 ${failures.length}`;
      els.uploadPercent.textContent = `${Math.round((succeeded / valid.length) * 100)}%`;
      els.uploadSpeed.textContent = '有失败';
      setTimeout(() => els.uploadProgress.classList.add('hidden'), 5000);
    } else {
      els.uploadLabel.textContent = valid.length === 1 ? `上传完成 · ${valid[0].name}` : `上传完成 · ${valid.length} 个文件`;
      els.uploadPercent.textContent = '100%';
      els.uploadSpeed.textContent = '完成';
      els.progressBar.style.width = '100%';
      setTimeout(() => els.uploadProgress.classList.add('hidden'), 900);
    }
    if (succeeded > 0 && !session.cancelled) scrollLatest();
  } finally {
    if (state.uploadSession === session) {
      state.uploadSession = null;
      state.uploading = false;
      els.attachButton.disabled = false;
      els.uploadCancel.hidden = true;
      els.uploadCancel.disabled = false;
    }
    els.photoInput.value = '';
    els.fileInput.value = '';
    if (succeeded > 0 && !session.cancelled) setTimeout(snapLatest, 120);
  }
}

function isCompactPointer() {
  return matchMedia('(max-width: 760px), (pointer: coarse)').matches;
}

function openAttachmentSheet() {
  els.attachmentSheet.classList.add('open');
  els.attachmentSheet.setAttribute('aria-hidden', 'false');
}

function closeAttachmentSheet() {
  els.attachmentSheet.classList.remove('open');
  els.attachmentSheet.setAttribute('aria-hidden', 'true');
}

function closePurgeSheet() {
  els.purgeSheet.classList.remove('open');
  els.purgeSheet.setAttribute('aria-hidden', 'true');
}

function setPurgeBusy(busy) {
  els.purgeFiles.disabled = busy;
  els.purgeAll.disabled = busy;
  $('#purgeCancel').disabled = busy;
}

async function openPurgeSheet() {
  closeOverlays();
  els.purgeSummary.classList.remove('error');
  els.purgeSummary.innerHTML = '正在读取本地存储…';
  els.purgeFiles.disabled = true;
  els.purgeAll.disabled = true;
  els.purgeSheet.classList.add('open');
  els.purgeSheet.setAttribute('aria-hidden', 'false');
  try {
    const response = await fetch('/api/storage', { cache: 'no-store', credentials: 'same-origin' });
    const data = await readApiJson(response);
    if (!response.ok) throw new Error(data.error || '无法读取本地存储');
    els.purgeSummary.innerHTML = `<strong>${data.fileCount} 个文件记录 · 可释放 ${formatSize(data.diskBytes || 0)}</strong><span>Drop 在 Server 上缓存了 ${data.historyCount} 条消息，其中 ${data.textCount} 条纯文字。清理只删除 Drop 的服务器副本，不会删除手机或电脑上的原始文件。</span>`;
    els.purgeFiles.disabled = data.fileCount === 0;
    els.purgeAll.disabled = data.historyCount === 0 && data.rowCount === 0;
  } catch (error) {
    els.purgeSummary.classList.add('error');
    els.purgeSummary.textContent = error.message || '无法读取本地存储';
  }
}

async function runStoragePurge(mode) {
  const filesOnly = mode === 'files';
  const warning = filesOnly
    ? '将永久删除 Server 上所有 Drop 图片、视频和文件副本及其聊天记录，纯文字消息会保留。不会删除手机或电脑上的原始文件。继续吗？'
    : '将永久删除“我的传输”在 Server 上的全部 Drop 历史和缓存文件。不会删除手机或电脑上的原始文件。继续吗？';
  if (!window.confirm(warning)) return;
  setPurgeBusy(true);
  els.purgeSummary.classList.remove('error');
  els.purgeSummary.textContent = filesOnly ? '正在删除 Drop 文件记录和 Server 缓存副本…' : '正在删除 Server 上的全部 Drop 历史…';
  try {
    const response = await fetch('/api/storage/purge', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, confirm: mode }),
    });
    const data = await readApiJson(response);
    if (!response.ok) throw new Error(data.error || '清理失败');
    state.hiddenIds.clear();
    saveHiddenMessages();
    await loadMessages({ quiet: true });
    closePurgeSheet();
    const deleted = data.deleted || {};
    toast(filesOnly
      ? `已彻底删除 ${deleted.fileCount || 0} 个文件记录 · 释放 ${formatSize(deleted.diskBytes || 0)}`
      : `已彻底删除 ${deleted.historyCount || 0} 条本地历史`);
  } catch (error) {
    els.purgeSummary.classList.add('error');
    els.purgeSummary.textContent = error.message || '清理失败';
  } finally {
    setPurgeBusy(false);
  }
}

function openAttachmentPicker() {
  // Close the iOS keyboard before showing the bottom sheet. Keeping both visible
  // makes WebKit shift the visual viewport and can place the sheet in the document flow.
  els.messageInput.blur();
  if (isCompactPointer()) openAttachmentSheet();
  else els.fileInput.click();
}

function resumeConnection() {
  if (document.hidden || !navigator.onLine) return;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(async () => {
    try {
      await loadMessages({ quiet: true });
    } catch {
      setConnection('offline');
      scheduleReconnect();
    }
  }, 120);
}

function resizeComposer() {
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = `${Math.min(132, els.messageInput.scrollHeight)}px`;
}

function scrollLatest() {
  state.followLatest = true;
  state.userScrollIntent = false;
  // Snap first for correctness. Then repeat briefly while WebKit settles the
  // visual viewport, upload progress area, and asynchronously decoded images.
  requestAnimationFrame(snapLatest);
  setTimeout(snapLatest, 80);
  setTimeout(snapLatest, 320);
}

function switchView(view) {
  state.view = view;
  $$('.view-panel').forEach((panel) => panel.classList.remove('active'));
  $(`#${view}View`).classList.add('active');
  $$('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  closeOverlays();
  if (view === 'chat') requestAnimationFrame(scrollLatest);
}

function openDetails() {
  els.detailsPanel.classList.add('open');
  els.detailsPanel.setAttribute('aria-hidden', 'false');
  els.scrim.classList.add('visible');
}

function closeOverlays() {
  closeAttachmentSheet();
  closePurgeSheet();
  els.detailsPanel.classList.remove('open');
  els.detailsPanel.setAttribute('aria-hidden', 'true');
  els.scrim.classList.remove('visible');
}

function toast(message, error = false) {
  const node = document.createElement('div');
  node.className = `toast${error ? ' error' : ''}`;
  node.textContent = message;
  els.toastRegion.append(node);
  setTimeout(() => node.remove(), 3200);
}

function bindEvents() {
  els.sendButton.addEventListener('click', sendText);
  els.messageInput.addEventListener('input', resizeComposer);
  els.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendText();
    }
  });
  els.messageInput.addEventListener('paste', (event) => {
    const files = [...event.clipboardData.files];
    if (files.length) {
      event.preventDefault();
      uploadFiles(files);
    }
  });
  els.attachButton.addEventListener('click', openAttachmentPicker);
  els.uploadCancel.addEventListener('click', cancelCurrentUpload);
  $('#pickPhotos').addEventListener('click', () => { closeAttachmentSheet(); els.photoInput.click(); });
  $('#pickFiles').addEventListener('click', () => { closeAttachmentSheet(); els.fileInput.click(); });
  $('#attachmentCancel').addEventListener('click', closeAttachmentSheet);
  els.attachmentSheet.addEventListener('click', (event) => { if (event.target === els.attachmentSheet) closeAttachmentSheet(); });
  $('#purgeStorageOpen').addEventListener('click', openPurgeSheet);
  $('#purgeCancel').addEventListener('click', closePurgeSheet);
  els.purgeFiles.addEventListener('click', () => runStoragePurge('files'));
  els.purgeAll.addEventListener('click', () => runStoragePurge('all'));
  els.purgeSheet.addEventListener('click', (event) => { if (event.target === els.purgeSheet) closePurgeSheet(); });
  els.photoInput.addEventListener('change', () => uploadFiles(els.photoInput.files));
  els.fileInput.addEventListener('change', () => uploadFiles(els.fileInput.files));
  els.jumpLatest.addEventListener('click', scrollLatest);
  const markUserScrollIntent = () => { state.userScrollIntent = true; };
  els.messageStage.addEventListener('wheel', markUserScrollIntent, { passive: true });
  els.messageStage.addEventListener('touchmove', markUserScrollIntent, { passive: true });
  let scrollPointerY = null;
  els.messageStage.addEventListener('pointerdown', (event) => { scrollPointerY = event.clientY; }, { passive: true });
  els.messageStage.addEventListener('pointermove', (event) => {
    if (scrollPointerY !== null && Math.abs(event.clientY - scrollPointerY) > 6) markUserScrollIntent();
  }, { passive: true });
  const clearScrollPointer = () => { scrollPointerY = null; };
  els.messageStage.addEventListener('pointerup', clearScrollPointer, { passive: true });
  els.messageStage.addEventListener('pointercancel', clearScrollPointer, { passive: true });
  els.messageStage.addEventListener('scroll', () => {
    const nearBottom = isNearBottom();
    if (nearBottom) {
      state.followLatest = true;
      state.userScrollIntent = false;
    } else if (state.userScrollIntent) {
      state.followLatest = false;
    }
    els.jumpLatest.classList.toggle('visible', !nearBottom);
  }, { passive: true });
  // Message/image height can change after the DOM render (especially on iOS
  // when previews decode later). Keep the bottom anchored only while the user
  // has not intentionally scrolled up.
  if (typeof ResizeObserver === 'function') {
    const followObserver = new ResizeObserver(() => {
      if (state.followLatest) snapLatest();
    });
    followObserver.observe(els.messageList);
    followObserver.observe(els.messageStage);
  }
  els.messageList.addEventListener('load', () => {
    if (state.followLatest) snapLatest();
  }, true);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (state.followLatest) snapLatest();
    }, { passive: true });
  }
  $('#detailsOpen').addEventListener('click', openDetails);
  $('#settingsOpen').addEventListener('click', openDetails);
  $('#detailsClose').addEventListener('click', closeOverlays);
  els.scrim.addEventListener('click', closeOverlays);
  $('#syncButton').addEventListener('click', async () => {
    try { await loadMessages(); toast('已同步'); } catch (error) { toast(error.message, true); }
  });
  $$('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $$('[data-file-filter]').forEach((button) => button.addEventListener('click', () => {
    state.fileFilter = button.dataset.fileFilter;
    $$('[data-file-filter]').forEach((item) => item.classList.toggle('active', item === button));
    renderFiles();
  }));
  $$('[data-theme-option]').forEach((button) => button.addEventListener('click', () => applyTheme(button.dataset.themeOption)));
  els.deviceInput.addEventListener('change', () => updateDevice(els.deviceInput.value));
  els.deviceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { updateDevice(els.deviceInput.value); event.currentTarget.blur(); }
  });
  $('#openFilesFromDetails').addEventListener('click', () => switchView('files'));
  $('#clearDisplay').addEventListener('click', clearDisplay);
  $('#restoreDisplay').addEventListener('click', restoreDisplay);
  els.messageList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-message]');
    if (!button) return;
    button.disabled = true;
    try {
      await deleteMessage(button.dataset.deleteMessage);
      toast('消息已删除');
    } catch (error) {
      toast(error.message || '删除失败', true);
      if (button.isConnected) button.disabled = false;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeOverlays();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(state.reconnectTimer);
      state.eventSource?.close();
      state.eventSource = null;
    } else {
      resumeConnection();
    }
  });
  window.addEventListener('pageshow', resumeConnection);
  window.addEventListener('online', resumeConnection);
  window.addEventListener('offline', () => {
    clearTimeout(state.reconnectTimer);
    state.eventSource?.close();
    state.eventSource = null;
    setConnection('offline');
  });

  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    dragDepth += 1;
    els.dropOverlay.classList.add('visible');
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropOverlay.classList.remove('visible');
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.dropOverlay.classList.remove('visible');
    uploadFiles(event.dataTransfer.files);
  });
  const colorSchemeMedia = matchMedia('(prefers-color-scheme: dark)');
  const handleColorScheme = () => { if (state.theme === 'system') applyTheme('system'); };
  if (typeof colorSchemeMedia.addEventListener === 'function') colorSchemeMedia.addEventListener('change', handleColorScheme);
  else if (typeof colorSchemeMedia.addListener === 'function') colorSchemeMedia.addListener(handleColorScheme);
}

async function boot() {
  applyTheme(state.theme);
  updateDevice(state.device);
  saveHiddenMessages();
  bindEvents();
  resizeComposer();
  renderMessages(false);
  try {
    await loadMessages();
  } catch (error) {
    setConnection('offline');
    toast(error.message || '连接失败', true);
  }
}

boot();
