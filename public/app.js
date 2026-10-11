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
  uploadTasks: new Map(),
  wakeLock: null,
  wakeLockRequest: null,
  transferWorkerPromise: null,
  backgroundTransfers: new Map(),
  backgroundControlBusy: false,
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
  uploadTaskList: $('#uploadTaskList'),
  dropOverlay: $('#dropOverlay'),
  toastRegion: $('#toastRegion'),
  restoreDisplay: $('#restoreDisplay'),
  restoreDisplayNote: $('#restoreDisplayNote'),
  attachmentSheet: $('#attachmentSheet'),
  purgeSheet: $('#purgeSheet'),
  purgeSummary: $('#purgeSummary'),
  purgeFiles: $('#purgeFiles'),
  purgeAll: $('#purgeAll'),
  accessLogoutGroup: $('#accessLogoutGroup'),
  accessLogout: $('#accessLogout'),
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

function isLoopbackPage() {
  const host = location.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
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
  const previewable = attachment?.type?.startsWith('image/') || attachment?.type?.startsWith('video/');
  return previewable && url.startsWith('/large/')
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
  if (attachment.type?.startsWith('video/')) {
    const previewUrl = attachmentPreviewUrl(attachment);
    return `<div class="video-attachment">
      <video class="attachment-video" controls playsinline preload="metadata" src="${previewUrl}"></video>
      <a class="video-download" href="${url}" download="${escapeText(attachment.name || '视频')}">${downloadSvg()}<span>${escapeText(attachment.name || '视频')} · ${formatSize(attachment.size)}</span></a>
    </div>`;
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
    if (a.type?.startsWith('video/')) {
      return `<article class="library-card">
        <div class="library-video"><video controls playsinline preload="metadata" src="${previewUrl}"></video></div>
        <a class="library-copy" href="${url}" download="${escapeText(a.name)}"><strong>${escapeText(a.name)}</strong><span>${formatSize(a.size)} · ${escapeText(message.device)} · ${formatDay(message.time)} ${formatTime(message.time)}</span></a>
      </article>`;
    }
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
  if (!navigator.onLine) return;
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

const BACKGROUND_FETCH_PREFIX = 'selfdrop-upload:';

async function ensureTransferWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  if (!state.transferWorkerPromise) {
    state.transferWorkerPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(() => navigator.serviceWorker.ready)
      .catch(() => null);
  }
  return state.transferWorkerPromise;
}

function uploadIdFromBackgroundJobId(jobId) {
  const match = /^selfdrop-upload:([0-9a-f-]{36})(?::|$)/i.exec(String(jobId || ''));
  return match ? match[1] : null;
}

function pendingUploadById(uploadId) {
  return loadPendingUploads().find((item) => item.uploadId === uploadId) || null;
}

function updatePendingUpload(uploadId, patch) {
  const items = loadPendingUploads();
  const index = items.findIndex((item) => item.uploadId === uploadId);
  if (index < 0) return;
  items[index] = { ...items[index], ...patch };
  savePendingUploads(items);
}

async function storedUploadProgress(uploadId) {
  try {
    const response = await fetch(`/api/large/${encodeURIComponent(uploadId)}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.state === 'complete') return { state: 'complete', loaded: Number(data.size || 0), data };
    let loaded = 0;
    for (const index of Array.isArray(data.received) ? data.received : []) {
      const start = Number(index) * Number(data.chunkSize || 0);
      loaded += Math.max(0, Math.min(Number(data.chunkSize || 0), Number(data.size || 0) - start));
    }
    return { state: data.state || 'uploading', loaded, data };
  } catch {
    return null;
  }
}

function taskForUploadId(uploadId) {
  if (!uploadId) return null;
  return [...state.uploadTasks.values()].find((task) => task.uploadId === uploadId) || null;
}

function uploadTaskStateText(task) {
  const labels = {
    queued: '等待中',
    offline: '等待网络',
    staging: '准备可恢复缓存',
    verifying: '校验中',
    uploading: '上传中',
    background: '后台发送中',
    pausing: '暂停中',
    paused: '已暂停',
    resuming: '继续中',
    confirming: '服务器确认中',
    cancelling: '取消中',
    cancelled: '已取消',
    complete: '已完成',
    failed: '发送失败',
  };
  return labels[task.status] || task.status || '等待中';
}

function renderUploadTasks() {
  const tasks = [...state.uploadTasks.values()].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  if (!els.uploadTaskList) return;
  els.uploadTaskList.innerHTML = tasks.map((task) => {
    const size = Number(task.size || 0);
    const loaded = Math.min(size, Math.max(0, Number(task.loaded || 0)));
    const percent = size ? Math.min(100, Math.round(loaded / size * 100)) : 0;
    const finalState = ['complete', 'cancelled'].includes(task.status);
    const busy = ['pausing', 'resuming', 'cancelling'].includes(task.status);
    const primaryAction = task.status === 'failed' ? 'retry' : task.status === 'paused' ? 'resume' : 'pause';
    const pauseLabel = task.status === 'failed' ? '重试' : task.status === 'paused' ? '继续' : '暂停';
    const pauseDisabled = finalState || busy || task.status === 'confirming';
    const cancelDisabled = finalState || task.status === 'cancelling';
    return `<div class="upload-task-row" data-upload-task="${escapeText(task.id)}">
      <div class="upload-task-main">
        <div class="upload-task-head"><span class="upload-task-name">${escapeText(task.name || '文件')}</span><span class="upload-task-state">${uploadTaskStateText(task)}</span></div>
        <div class="upload-task-track"><span style="width:${percent}%"></span></div>
        <div class="upload-task-meta"><span>${percent}%</span><span>${formatSize(loaded)} / ${formatSize(size)}</span></div>
      </div>
      <div class="upload-task-actions">
        <button class="upload-task-action" type="button" data-upload-action="${primaryAction}" ${pauseDisabled ? 'disabled' : ''}>${pauseLabel}</button>
        <button class="upload-task-action danger" type="button" data-upload-action="cancel" ${cancelDisabled ? 'disabled' : ''}>取消</button>
      </div>
    </div>`;
  }).join('');
}

function uploadTaskIsTerminal(task) {
  return ['complete', 'cancelled', 'failed'].includes(task?.status);
}

function liveUploadTasks() {
  return [...state.uploadTasks.values()].filter((task) => !uploadTaskIsTerminal(task));
}

function transferNeedsWakeLock() {
  return liveUploadTasks().some((task) => ['queued', 'staging', 'verifying', 'uploading', 'resuming', 'confirming'].includes(task.status));
}

async function syncTransferWakeLock() {
  if (!navigator.wakeLock?.request) return;
  const needed = transferNeedsWakeLock() && !document.hidden;
  if (!needed) {
    if (state.wakeLock) {
      const lock = state.wakeLock;
      state.wakeLock = null;
      try { await lock.release(); } catch { /* already released by the browser */ }
    }
    return;
  }
  if (state.wakeLock || state.wakeLockRequest) return;
  state.wakeLockRequest = navigator.wakeLock.request('screen')
    .then((lock) => {
      state.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (state.wakeLock === lock) state.wakeLock = null;
      });
      return lock;
    })
    .catch(() => null)
    .finally(() => {
      state.wakeLockRequest = null;
      if (!transferNeedsWakeLock() || document.hidden) syncTransferWakeLock().catch(() => {});
    });
  await state.wakeLockRequest;
}

function shouldWarnBeforeUnload() {
  return liveUploadTasks().some((task) => task.status !== 'background');
}

function reconcileUploadSurface() {
  renderUploadTasks();
  syncTransferWakeLock().catch(() => {});
  const hasLiveTasks = liveUploadTasks().length > 0;
  const hasBackground = state.backgroundTransfers.size > 0;
  const failedTasks = [...state.uploadTasks.values()].filter((task) => task.status === 'failed');
  if (hasLiveTasks || hasBackground) return true;
  if (failedTasks.length) {
    els.uploadProgress.classList.remove('hidden');
    els.uploadCancel.hidden = true;
    els.progressBar.style.width = '0%';
    els.uploadPercent.textContent = '';
    els.uploadSpeed.textContent = '可重试或取消';
    els.uploadLabel.textContent = failedTasks.length === 1 ? `发送失败 · ${failedTasks[0].name}` : `${failedTasks.length} 个文件发送失败`;
    return true;
  }
  els.uploadCancel.hidden = true;
  els.uploadCancel.disabled = false;
  els.uploadCancel.textContent = '全部取消';
  els.progressBar.style.width = '0%';
  els.uploadPercent.textContent = '0%';
  els.uploadSpeed.textContent = '';
  els.uploadLabel.textContent = '正在发送文件';
  els.uploadProgress.classList.add('hidden');
  return false;
}

function updateUploadTask(task, patch = {}) {
  if (!task) return;
  Object.assign(task, patch);
  renderUploadTasks();
  syncTransferWakeLock().catch(() => {});
}

async function retryUploadTask(task) {
  if (!task || task.status !== 'failed' || !task.file) return;
  const session = state.uploadSession;
  if (state.uploading && session?.retryTask?.(task)) return;
  session?.failedTaskIds?.delete(task.id);
  session?.tasks?.delete(task.id);
  state.uploadTasks.delete(task.id);
  renderUploadTasks();
  await uploadFiles([task.file]);
}

async function setLargeUploadControl(uploadId, action) {
  if (!uploadId) return null;
  const response = await fetch(`/api/large/${encodeURIComponent(uploadId)}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ action }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !(action === 'cancel' && response.status === 410)) throw new Error(data.error || `上传控制失败 (${response.status})`);
  return data;
}

function requestLargeUploadCancel(uploadId) {
  if (!uploadId) return;
  const url = `/api/large/${encodeURIComponent(uploadId)}/control`;
  const body = JSON.stringify({ action: 'cancel' });
  try {
    navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }));
  } catch { /* normal fetch below remains the primary path */ }
  const send = () => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    keepalive: true,
    priority: 'high',
    body,
  }).catch(() => null);
  send().then((response) => {
    if (response?.ok || response?.status === 410 || response?.status === 404) return;
    setTimeout(send, 700);
  });
}

function releasePauseWaiters(control) {
  if (!control?.pauseWaiters) return;
  for (const resolve of [...control.pauseWaiters]) resolve();
  control.pauseWaiters.clear();
}

function watchForegroundPause(task) {
  const control = task?.control;
  if (!control) return;
  const check = () => {
    if (!control.paused || control.cancelled || ['complete', 'cancelled', 'failed'].includes(task.status)) return;
    if (control.xhrs.size === 0) {
      updateUploadTask(task, { status: 'paused' });
      return;
    }
    setTimeout(check, 100);
  };
  check();
}

async function pauseUploadTask(task) {
  if (!task || ['paused', 'pausing', 'complete', 'cancelled'].includes(task.status)) return;
  const transfer = task.uploadId ? state.backgroundTransfers.get(task.uploadId) : null;
  if (transfer?.registration) {
    updateUploadTask(task, { status: 'pausing' });
    transfer.status = 'pausing';
    renderBackgroundTransfers();
    try {
      // Background Fetch has no pause API. Do not abort the browser-owned job: it
      // can destabilize Chromium. The server rejects not-yet-started chunks and
      // the browser job settles naturally; completed chunks remain resumable.
      await setLargeUploadControl(task.uploadId, 'pause');
      updatePendingUpload(task.uploadId, { backgroundPauseRequested: true });
    } catch (error) {
      transfer.status = 'running';
      updateUploadTask(task, { status: 'background' });
      toast(error.message || '暂停失败', true);
    }
    return;
  }
  if (!task.control) return;
  task.control.paused = true;
  updateUploadTask(task, { status: 'pausing' });
  watchForegroundPause(task);
}

async function resumeUploadTask(task) {
  if (!task || task.status !== 'paused') return;
  const transfer = task.uploadId ? state.backgroundTransfers.get(task.uploadId) : null;
  if (transfer) {
    updateUploadTask(task, { status: 'resuming' });
    transfer.status = 'resuming';
    renderBackgroundTransfers();
    try {
      await setLargeUploadControl(task.uploadId, 'resume');
      updatePendingUpload(task.uploadId, { backgroundPauseRequested: false, backgroundPaused: false });
      const source = await sourceForBackgroundTransfer(transfer);
      if (!source) throw new Error('请重新选择同一文件继续发送');
      removeBackgroundTransfer(task.uploadId);
      task.control.paused = false;
      releasePauseWaiters(task.control);
      const data = await uploadLargeOneInBackground(source, (bytes) => updateUploadTask(task, { loaded: bytes }), {
        session: task.control,
        onPhase: () => {},
      });
      if (!data?.background) {
        if (data?.alreadyComplete) loadMessages({ quiet: true }).catch(() => {});
        else if (data) addMessage(data, { keepScroll: false });
        updateUploadTask(task, { loaded: task.size, status: 'complete' });
      }
    } catch (error) {
      await markBackgroundTransferPaused(task.uploadId);
      updateUploadTask(task, { status: 'paused' });
      toast(`${task.name}：${error.message || '继续发送失败'}`, true);
    }
    return;
  }
  if (!task.control) return;
  task.control.paused = false;
  releasePauseWaiters(task.control);
  updateUploadTask(task, { status: 'uploading' });
}

async function cancelUploadTask(task) {
  if (!task || ['cancelled', 'complete', 'cancelling'].includes(task.status)) return;
  updateUploadTask(task, { status: 'cancelling' });
  const control = task.control;
  if (control) {
    control.cancelled = true;
    control.paused = false;
    releasePauseWaiters(control);
    try { control.controller.abort(); } catch { /* already aborted */ }
    for (const xhr of [...control.xhrs]) {
      try { xhr.abort(); } catch { /* already settled */ }
    }
  }
  if (task.uploadId) {
    requestLargeUploadCancel(task.uploadId);
    removeBackgroundTransfer(task.uploadId);
    forgetPendingUpload(task.uploadId);
  }
  if (control?.mediaCacheKeys) for (const cacheKey of control.mediaCacheKeys) forgetMediaCache(cacheKey);
  state.uploadSession?.failedTaskIds?.delete(task.id);
  updateUploadTask(task, { status: 'cancelled' });
  const session = state.uploadSession;
  if (session && [...session.tasks.values()].every((item) => uploadTaskIsTerminal(item) || item.control?.cancelled)) {
    session.cancelled = true;
  }
  reconcileUploadSurface();
  setTimeout(() => {
    state.uploadTasks.delete(task.id);
    reconcileUploadSurface();
  }, 350);
}

function removeBackgroundTransfer(uploadId) {
  const transfer = state.backgroundTransfers.get(uploadId);
  if (transfer?.registration && transfer.progressHandler) {
    try { transfer.registration.removeEventListener('progress', transfer.progressHandler); } catch { /* already detached */ }
  }
  state.backgroundTransfers.delete(uploadId);
}

function renderBackgroundTransfers() {
  const transfers = [...state.backgroundTransfers.values()];
  renderUploadTasks();
  if (!transfers.length) return reconcileUploadSurface();

  const total = transfers.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const loaded = transfers.reduce((sum, item) => sum + Math.min(Number(item.size || 0), Number(item.loaded || 0)), 0);
  const percent = total ? Math.min(99, Math.round(loaded / total * 100)) : 0;
  const running = transfers.filter((item) => ['running', 'resuming', 'pausing', 'finishing'].includes(item.status));
  const first = transfers[0];

  els.uploadProgress.classList.remove('hidden');
  els.progressBar.style.width = `${percent}%`;
  els.uploadPercent.textContent = `${percent}%`;
  els.uploadSpeed.textContent = `${formatSize(loaded)} / ${formatSize(total)}`;
  if (running.length) {
    els.uploadLabel.textContent = transfers.length === 1
      ? `后台发送中 · ${first.name}`
      : `后台发送中 · ${running.length}/${transfers.length} 个文件`;
  } else {
    els.uploadLabel.textContent = transfers.length === 1
      ? `已暂停 · ${first.name}`
      : `已暂停 · ${transfers.length} 个文件`;
  }
  els.uploadCancel.hidden = false;
  els.uploadCancel.disabled = state.backgroundControlBusy;
  els.uploadCancel.textContent = '全部取消';
  return true;
}

function trackBackgroundTransfer({ uploadId, registration, source, name, size, baseBytes = 0, jobId, taskId = null }) {
  const previous = state.backgroundTransfers.get(uploadId);
  if (previous?.registration && previous.progressHandler) {
    try { previous.registration.removeEventListener('progress', previous.progressHandler); } catch { /* ignore */ }
  }
  const transfer = {
    ...previous,
    uploadId,
    registration,
    source: source || previous?.source || null,
    name: name || previous?.name || pendingUploadById(uploadId)?.name || '后台文件',
    size: Number(size || previous?.size || pendingUploadById(uploadId)?.size || registration?.uploadTotal || 0),
    baseBytes: Number(baseBytes || 0),
    loaded: Math.min(Number(size || previous?.size || 0), Number(baseBytes || 0) + Number(registration?.uploaded || 0)),
    jobId: jobId || registration?.id || previous?.jobId || null,
    status: registration?.result === 'failure' ? 'paused' : registration?.result === 'success' ? 'finishing' : 'running',
    taskId: taskId || previous?.taskId || taskForUploadId(uploadId)?.id || null,
  };
  const progressHandler = () => {
    transfer.loaded = Math.min(transfer.size, transfer.baseBytes + Number(registration.uploaded || 0));
    if (registration.result === 'failure') transfer.status = 'paused';
    else if (registration.result === 'success') transfer.status = 'finishing';
    const task = transfer.taskId ? state.uploadTasks.get(transfer.taskId) : taskForUploadId(uploadId);
    if (task) updateUploadTask(task, {
      uploadId,
      loaded: transfer.loaded,
      status: transfer.status === 'paused' ? 'paused' : transfer.status === 'finishing' ? 'confirming' : transfer.status === 'pausing' ? 'pausing' : 'background',
    });
    renderBackgroundTransfers();
  };
  transfer.progressHandler = progressHandler;
  registration.addEventListener('progress', progressHandler);
  state.backgroundTransfers.set(uploadId, transfer);
  progressHandler();
  return transfer;
}

async function sourceForBackgroundTransfer(transfer) {
  if (transfer?.source) return transfer.source;
  const pending = pendingUploadById(transfer?.uploadId);
  if (!pending?.cacheKey) return null;
  const entry = loadMediaCacheEntries().find((item) => item.cacheKey === pending.cacheKey);
  if (!entry) return null;
  const source = await cachedMediaFile(entry);
  if (source) transfer.source = source;
  return source;
}

async function markBackgroundTransferPaused(uploadId) {
  let transfer = state.backgroundTransfers.get(uploadId);
  const pending = pendingUploadById(uploadId);
  if (!transfer && pending) {
    transfer = {
      uploadId,
      registration: null,
      source: null,
      name: pending.name || '后台文件',
      size: Number(pending.size || 0),
      baseBytes: 0,
      loaded: 0,
      jobId: pending.backgroundJobId || null,
      status: 'paused',
    };
    state.backgroundTransfers.set(uploadId, transfer);
  }
  if (!transfer) return;
  if (transfer.registration && transfer.progressHandler) {
    try { transfer.registration.removeEventListener('progress', transfer.progressHandler); } catch { /* ignore */ }
  }
  const progress = await storedUploadProgress(uploadId);
  if (progress?.state === 'complete') {
    const task = transfer?.taskId ? state.uploadTasks.get(transfer.taskId) : taskForUploadId(uploadId);
    if (task) updateUploadTask(task, { loaded: task.size, status: 'complete' });
    removeBackgroundTransfer(uploadId);
    forgetPendingUpload(uploadId);
    loadMessages({ quiet: true }).catch(() => {});
    return;
  }
  if (progress?.state === 'cancelled') {
    const task = transfer?.taskId ? state.uploadTasks.get(transfer.taskId) : taskForUploadId(uploadId);
    if (task) updateUploadTask(task, { status: 'cancelled' });
    removeBackgroundTransfer(uploadId);
    forgetPendingUpload(uploadId);
    return;
  }
  transfer.registration = null;
  transfer.status = 'paused';
  if (progress) transfer.loaded = progress.loaded;
  updatePendingUpload(uploadId, { backgroundJobId: null, backgroundBaseBytes: Number(transfer.loaded || 0), backgroundPaused: true, backgroundPauseRequested: false });
  const task = transfer.taskId ? state.uploadTasks.get(transfer.taskId) : taskForUploadId(uploadId);
  if (task) updateUploadTask(task, { loaded: Number(transfer.loaded || 0), status: 'paused' });
  renderBackgroundTransfers();
}

async function restoreBackgroundTransfers() {
  const registration = await ensureTransferWorker();
  const manager = registration?.backgroundFetch;
  if (!manager || typeof manager.getIds !== 'function' || typeof manager.get !== 'function') return 0;
  let ids = [];
  try { ids = await manager.getIds(); } catch { return 0; }
  let restored = 0;
  for (const jobId of ids) {
    const uploadId = uploadIdFromBackgroundJobId(jobId);
    if (!uploadId) continue;
    const pending = pendingUploadById(uploadId);
    let background;
    try { background = await manager.get(jobId); } catch { continue; }
    if (!background) continue;
    let source = null;
    if (pending?.cacheKey) {
      const entry = loadMediaCacheEntries().find((item) => item.cacheKey === pending.cacheKey);
      if (entry) source = await cachedMediaFile(entry);
    }
    trackBackgroundTransfer({
      uploadId,
      registration: background,
      source,
      name: pending?.name,
      size: pending?.size || Number(pending?.backgroundBaseBytes || 0) + Number(background.uploadTotal || 0),
      baseBytes: Number(pending?.backgroundBaseBytes || 0),
      jobId,
    });
    let task = taskForUploadId(uploadId);
    if (!task) {
      const taskId = `restored:${uploadId}`;
      const control = {
        taskId,
        cancelled: false,
        paused: false,
        controller: new AbortController(),
        xhrs: new Set(),
        uploadIds: new Set([uploadId]),
        confirmWaiters: new Set(),
        backgroundFetches: new Map(),
        mediaCacheKeys: new Set(pending?.cacheKey ? [pending.cacheKey] : []),
        pauseWaiters: new Set(),
      };
      task = { id: taskId, name: pending?.name || '后台文件', size: Number(pending?.size || background.uploadTotal || 0), loaded: Number(pending?.backgroundBaseBytes || 0) + Number(background.uploaded || 0), uploadId, status: background.result === 'failure' ? 'paused' : background.result === 'success' ? 'confirming' : 'background', control, createdAt: Number(pending?.createdAt || Date.now()) };
      state.uploadTasks.set(taskId, task);
      const transfer = state.backgroundTransfers.get(uploadId);
      if (transfer) transfer.taskId = taskId;
    }
    restored += 1;
  }
  for (const pending of loadPendingUploads().filter((item) => item.backgroundPaused && !state.backgroundTransfers.has(item.uploadId))) {
    let source = null;
    if (pending.cacheKey) {
      const entry = loadMediaCacheEntries().find((item) => item.cacheKey === pending.cacheKey);
      if (entry) source = await cachedMediaFile(entry);
    }
    state.backgroundTransfers.set(pending.uploadId, {
      uploadId: pending.uploadId,
      registration: null,
      source,
      name: pending.name || '后台文件',
      size: Number(pending.size || 0),
      baseBytes: Number(pending.backgroundBaseBytes || 0),
      loaded: Number(pending.backgroundBaseBytes || 0),
      jobId: null,
      status: 'paused',
      taskId: `restored:${pending.uploadId}`,
    });
    if (!state.uploadTasks.has(`restored:${pending.uploadId}`)) {
      const taskId = `restored:${pending.uploadId}`;
      const control = {
        taskId,
        cancelled: false,
        paused: true,
        controller: new AbortController(),
        xhrs: new Set(),
        uploadIds: new Set([pending.uploadId]),
        confirmWaiters: new Set(),
        backgroundFetches: new Map(),
        mediaCacheKeys: new Set(pending.cacheKey ? [pending.cacheKey] : []),
        pauseWaiters: new Set(),
      };
      state.uploadTasks.set(taskId, { id: taskId, name: pending.name || '后台文件', size: Number(pending.size || 0), loaded: Number(pending.backgroundBaseBytes || 0), uploadId: pending.uploadId, status: 'paused', control, createdAt: Number(pending.createdAt || Date.now()) });
    }
    restored += 1;
  }
  renderBackgroundTransfers();
  return restored;
}

async function pauseBackgroundTransfers() {
  if (state.backgroundControlBusy) return;
  const running = [...state.backgroundTransfers.values()].filter((item) => item.registration && item.status !== 'paused');
  if (!running.length) return;
  state.backgroundControlBusy = true;
  await Promise.allSettled(running.map((item) => {
    const task = item.taskId ? state.uploadTasks.get(item.taskId) : taskForUploadId(item.uploadId);
    return task ? pauseUploadTask(task) : setLargeUploadControl(item.uploadId, 'pause');
  }));
  state.backgroundControlBusy = false;
  renderBackgroundTransfers();
}

async function resumeBackgroundTransfers() {
  if (state.backgroundControlBusy) return;
  const paused = [...state.backgroundTransfers.values()].filter((item) => item.status === 'paused');
  if (!paused.length) return;
  state.backgroundControlBusy = true;
  paused.forEach((item) => { item.status = 'resuming'; });
  renderBackgroundTransfers();
  for (const item of paused) {
    const task = item.taskId ? state.uploadTasks.get(item.taskId) : taskForUploadId(item.uploadId);
    if (task) await resumeUploadTask(task);
  }
  state.backgroundControlBusy = false;
  renderBackgroundTransfers();
}

function handleUploadControl() {
  cancelCurrentUpload();
}

function handleTransferWorkerMessage(event) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'selfdrop-background-upload-complete') {
    const task = taskForUploadId(data.uploadId);
    if (task) updateUploadTask(task, { loaded: task.size, status: 'complete' });
    removeBackgroundTransfer(data.uploadId);
    forgetPendingUpload(data.uploadId);
    if (data.message) addMessage(data.message, { keepScroll: false });
    if (!renderBackgroundTransfers() && !state.uploading) {
      els.uploadLabel.textContent = '后台发送完成';
      els.uploadPercent.textContent = '100%';
      els.uploadSpeed.textContent = '完成';
      els.progressBar.style.width = '100%';
      els.uploadCancel.hidden = true;
      setTimeout(() => { if (!state.uploading && !state.backgroundTransfers.size) els.uploadProgress.classList.add('hidden'); }, 1200);
    }
    if (task) setTimeout(() => {
      if (task.status === 'complete') {
        state.uploadTasks.delete(task.id);
        renderUploadTasks();
      }
    }, 1800);
    return;
  }
  if (data.type === 'selfdrop-background-upload-finalize-failed') {
    if (!pendingUploadById(data.uploadId) && !state.backgroundTransfers.has(data.uploadId) && !taskForUploadId(data.uploadId)) return;
    storedUploadProgress(data.uploadId).then((progress) => {
      if (progress?.state === 'paused') return markBackgroundTransferPaused(data.uploadId);
      if (progress?.state === 'cancelled') {
        removeBackgroundTransfer(data.uploadId);
        forgetPendingUpload(data.uploadId);
        return;
      }
      toast(data.error || '后台文件已上传，但服务器确认失败', true);
      return markBackgroundTransferPaused(data.uploadId);
    }).catch(() => {});
    return;
  }
  if (data.type === 'selfdrop-background-upload-failed') {
    if (!pendingUploadById(data.uploadId) && !state.backgroundTransfers.has(data.uploadId) && !taskForUploadId(data.uploadId)) return;
    storedUploadProgress(data.uploadId).then((progress) => {
      if (progress?.state === 'cancelled') {
        removeBackgroundTransfer(data.uploadId);
        forgetPendingUpload(data.uploadId);
        return;
      }
      if (progress?.state !== 'paused') toast('后台发送中断；已保留完成分片，可以继续发送', true);
      return markBackgroundTransferPaused(data.uploadId);
    }).catch(() => {});
    return;
  }
  if (data.type === 'selfdrop-background-upload-aborted') {
    markBackgroundTransferPaused(data.uploadId).catch(() => {});
  }
}

async function canUseBackgroundFetch() {
  const registration = await ensureTransferWorker();
  return Boolean(registration && 'backgroundFetch' in registration);
}

function backgroundTransferError(message) {
  const error = new Error(message || '浏览器后台传送不可用');
  error.name = 'BackgroundTransferError';
  return error;
}

function uploadCancelledError() {
  const error = new Error('上传已取消');
  error.name = 'UploadCancelledError';
  return error;
}

function throwIfUploadCancelled(session) {
  if (session?.cancelled) throw uploadCancelledError();
}

const PENDING_UPLOADS_KEY = 'drop.pendingUploads.v1';
const MEDIA_CACHE_INDEX_KEY = 'drop.mediaCache.v1';
const MEDIA_CACHE_DIR = 'selfdrop-media-cache-v1';
const mediaCacheSources = new WeakMap();

function pendingUploadFingerprint(file) {
  return `${file.name}\n${file.size}\n${Number(file.lastModified || 0)}`;
}


function isMediaFile(file) {
  const type = String(file?.type || '').toLowerCase();
  return type.startsWith('image/') || type.startsWith('video/');
}

function loadMediaCacheEntries() {
  try {
    const value = JSON.parse(localStorage.getItem(MEDIA_CACHE_INDEX_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item) => item?.cacheKey && item?.fingerprint) : [];
  } catch {
    return [];
  }
}

function saveMediaCacheEntries(items) {
  localStorage.setItem(MEDIA_CACHE_INDEX_KEY, JSON.stringify(items.slice(-20)));
}

function findMediaCacheEntry(file) {
  const fingerprint = pendingUploadFingerprint(file);
  return loadMediaCacheEntries().reverse().find((item) => item.fingerprint === fingerprint) || null;
}

async function removeMediaCacheFile(cacheKey) {
  if (!cacheKey || !navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(MEDIA_CACHE_DIR, { create: true });
    await dir.removeEntry(cacheKey);
  } catch { /* cache may already be gone or unavailable in private browsing */ }
}

function forgetMediaCache(cacheKey) {
  if (!cacheKey) return;
  saveMediaCacheEntries(loadMediaCacheEntries().filter((item) => item.cacheKey !== cacheKey));
  removeMediaCacheFile(cacheKey).catch(() => {});
}

async function cachedMediaFile(entry) {
  if (!entry?.cacheKey || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(MEDIA_CACHE_DIR, { create: true });
    const handle = await dir.getFileHandle(entry.cacheKey);
    const stored = await handle.getFile();
    if (stored.size !== Number(entry.size)) throw new Error('缓存文件大小不匹配');
    const file = new File([stored], entry.name, {
      type: entry.type || stored.type || 'application/octet-stream',
      lastModified: Number(entry.lastModified || 0),
    });
    mediaCacheSources.set(file, entry.cacheKey);
    return file;
  } catch {
    forgetMediaCache(entry.cacheKey);
    return null;
  }
}

async function writeMediaCacheWithWorker(file, cacheKey, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/media-cache-worker.js');
    const finish = () => worker.terminate();
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'progress') onProgress(Number(data.loaded || 0), file.size);
      if (data.type === 'done') { finish(); resolve(); }
      if (data.type === 'error') { finish(); reject(new Error(data.error || 'Safari 媒体缓存失败')); }
    };
    worker.onerror = () => { finish(); reject(new Error('Safari 媒体缓存 Worker 失败')); };
    worker.postMessage({ file, cacheKey, directory: MEDIA_CACHE_DIR });
  });
}

async function writeMediaCache(file, cacheKey, onProgress) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(MEDIA_CACHE_DIR, { create: true });
  const handle = await dir.getFileHandle(cacheKey, { create: true });
  if (typeof handle.createWritable === 'function') {
    const writable = await handle.createWritable();
    try {
      await writable.write(file);
      await writable.close();
      onProgress(file.size, file.size);
      return;
    } catch (error) {
      try { await writable.abort?.(); } catch { /* ignore */ }
      throw error;
    }
  }
  await writeMediaCacheWithWorker(file, cacheKey, onProgress);
}

async function stageMediaForResume(file, session, onProgress = () => {}) {
  if (!isMediaFile(file) || !navigator.storage?.getDirectory) return file;
  throwIfUploadCancelled(session);
  if (mediaCacheSources.has(file)) {
    session?.mediaCacheKeys.add(mediaCacheSources.get(file));
    return file;
  }

  const existing = findMediaCacheEntry(file);
  if (existing) {
    const cached = await cachedMediaFile(existing);
    if (cached) {
      session?.mediaCacheKeys.add(existing.cacheKey);
      return cached;
    }
  }

  let cacheKey = null;
  try {
    const estimate = await navigator.storage.estimate?.();
    if (estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)) {
      const available = Math.max(0, estimate.quota - estimate.usage);
      const reserve = Math.min(128 * 1024 * 1024, Math.max(16 * 1024 * 1024, file.size * 0.05));
      if (available < file.size + reserve) return file;
    }
    if (typeof navigator.storage.persist === 'function') await navigator.storage.persist().catch(() => false);
    cacheKey = `${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}.bin`;
    await writeMediaCache(file, cacheKey, onProgress);
    if (session?.cancelled) {
      await removeMediaCacheFile(cacheKey).catch(() => {});
      throw uploadCancelledError();
    }
    const entry = {
      cacheKey,
      fingerprint: pendingUploadFingerprint(file),
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      lastModified: Number(file.lastModified || 0),
      createdAt: Date.now(),
    };
    const items = loadMediaCacheEntries().filter((item) => item.fingerprint !== entry.fingerprint && item.cacheKey !== cacheKey);
    items.push(entry);
    saveMediaCacheEntries(items);
    const cached = await cachedMediaFile(entry);
    if (cached) {
      session?.mediaCacheKeys.add(cacheKey);
      return cached;
    }
    return file;
  } catch (error) {
    if (session?.cancelled || error?.name === 'UploadCancelledError') {
      if (cacheKey) await removeMediaCacheFile(cacheKey).catch(() => {});
      throw uploadCancelledError();
    }
    return file;
  }
}

async function resumeCachedMediaUploads() {
  if (state.uploading || !navigator.storage?.getDirectory) return;
  const entries = loadMediaCacheEntries();
  if (!entries.length) return;
  const files = [];
  for (const entry of entries) {
    if (Date.now() - Number(entry.createdAt || 0) > 24 * 60 * 60 * 1000) {
      forgetMediaCache(entry.cacheKey);
      continue;
    }
    const pending = loadPendingUploads().find((item) => item.cacheKey === entry.cacheKey);
    if (pending && (state.backgroundTransfers.has(pending.uploadId) || pending.backgroundPaused || pending.backgroundPauseRequested)) continue;
    const file = await cachedMediaFile(entry);
    if (file) files.push(file);
  }
  if (!files.length) return;
  toast(files.length === 1 ? '正在继续上次未完成的照片/视频发送' : `正在继续 ${files.length} 个未完成的照片/视频发送`);
  await uploadFiles(files);
}

async function resumeCachedMediaUploadsCoordinated() {
  if (!navigator.locks?.request) return resumeCachedMediaUploads();
  try {
    return await navigator.locks.request('selfdrop-auto-resume-v1', { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await resumeCachedMediaUploads();
    });
  } catch {
    // Older engines may expose Web Locks incompletely. The existing resume
    // protocol remains safe as the compatibility fallback.
    return resumeCachedMediaUploads();
  }
}

function loadPendingUploads() {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_UPLOADS_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item) => item?.uploadId && item?.fingerprint) : [];
  } catch {
    return [];
  }
}

function savePendingUploads(items) {
  localStorage.setItem(PENDING_UPLOADS_KEY, JSON.stringify(items.slice(-20)));
}

function rememberPendingUpload(file, upload) {
  const fingerprint = pendingUploadFingerprint(file);
  const cacheKey = mediaCacheSources.get(file) || findMediaCacheEntry(file)?.cacheKey || null;
  const items = loadPendingUploads().filter((item) => item.fingerprint !== fingerprint && item.uploadId !== upload.uploadId);
  items.push({
    uploadId: upload.uploadId,
    fingerprint,
    name: file.name,
    size: file.size,
    lastModified: Number(file.lastModified || 0),
    chunkSize: upload.chunkSize,
    chunkCount: upload.chunkCount,
    cacheKey,
    createdAt: Date.now(),
  });
  savePendingUploads(items);
}

function forgetPendingUpload(uploadId, { removeMedia = true } = {}) {
  if (!uploadId) return;
  const items = loadPendingUploads();
  const target = items.find((item) => item.uploadId === uploadId);
  savePendingUploads(items.filter((item) => item.uploadId !== uploadId));
  if (removeMedia && target?.cacheKey) forgetMediaCache(target.cacheKey);
}

function findPendingUpload(file) {
  const fingerprint = pendingUploadFingerprint(file);
  return loadPendingUploads().reverse().find((item) => item.fingerprint === fingerprint) || null;
}

async function recoverLargeUpload(file, session) {
  const pending = findPendingUpload(file);
  if (!pending) return null;
  const response = await fetch(`/api/large/${encodeURIComponent(pending.uploadId)}`, {
    method: 'GET',
    cache: 'no-store',
    signal: session?.controller.signal,
  });
  if (response.status === 404) {
    forgetPendingUpload(pending.uploadId, { removeMedia: false });
    return null;
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '无法恢复未完成的上传');
  if (data.state === 'complete') {
    forgetPendingUpload(pending.uploadId);
    return data;
  }
  if (Number(data.size) !== file.size || data.name !== file.name) {
    forgetPendingUpload(pending.uploadId, { removeMedia: false });
    return null;
  }
  return data;
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

async function sha256Hex(blob) {
  if (!globalThis.crypto?.subtle?.digest) return null;
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function uploadChunk(uploadId, index, blob, onProgress, session, digest = null) {
  return new Promise((resolve, reject) => {
    try { throwIfUploadCancelled(session); } catch (error) { reject(error); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/large/${encodeURIComponent(uploadId)}/chunk/${index}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    if (digest) xhr.setRequestHeader('x-drop-chunk-sha256', digest);
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
  if (session?.paused) {
    return new Promise((resolve, reject) => {
      const onResume = () => {
        cleanup();
        waitForUploadWindow(session).then(resolve, reject);
      };
      const onAbort = () => {
        cleanup();
        reject(uploadCancelledError());
      };
      const cleanup = () => {
        session.pauseWaiters?.delete(onResume);
        session.controller.signal.removeEventListener('abort', onAbort);
      };
      session.pauseWaiters?.add(onResume);
      session.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  // Do not gate uploads on page visibility. A hidden/background tab is still
  // allowed to use the network, and pausing here made every large upload stall
  // as soon as the user switched tabs, locked the screen, or backgrounded the
  // browser. Only pause when the browser reports that the device is offline.
  if (navigator.onLine) return Promise.resolve();
  const task = session?.taskId ? state.uploadTasks.get(session.taskId) : null;
  if (task && !['paused', 'pausing'].includes(task.status)) updateUploadTask(task, { status: 'offline' });
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('online', check);
      session?.controller.signal.removeEventListener('abort', onAbort);
    };
    const check = () => {
      if (!navigator.onLine) return;
      cleanup();
      if (task?.status === 'offline') updateUploadTask(task, { status: 'uploading' });
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(uploadCancelledError());
    };
    window.addEventListener('online', check);
    session?.controller.signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function uploadChunkWithRetry(uploadId, index, blob, onProgress, session, attempts = 3) {
  const digest = await sha256Hex(blob);
  throwIfUploadCancelled(session);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfUploadCancelled(session);
    await waitForUploadWindow(session);
    onProgress(0, blob.size);
    try {
      return await uploadChunk(uploadId, index, blob, onProgress, session, digest);
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
  removeBackgroundTransfer(uploadId);
  forgetPendingUpload(uploadId);
  try {
    await fetch(`/api/large/${encodeURIComponent(uploadId)}`, { method: 'DELETE', cache: 'no-store' });
  } catch { /* best-effort cleanup; server retention also removes abandoned tasks */ }
}

async function uploadLargeOneInBackground(file, onProgress, { session, onPhase = () => {} } = {}) {
  throwIfUploadCancelled(session);
  const registration = await ensureTransferWorker();
  if (!registration || !('backgroundFetch' in registration)) return null;

  let init = await recoverLargeUpload(file, session);
  if (!init) {
    const initResponse = await fetch('/api/large/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: session?.controller.signal,
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        device: state.device,
        // Background Fetch stores request bodies before taking ownership. Use
        // the largest server chunk to keep the number of durable requests small.
        chunkSize: 16 * 1024 * 1024,
      }),
    });
    init = await initResponse.json();
    if (!initResponse.ok) throw new Error(init.error || '无法创建后台上传任务');
    rememberPendingUpload(file, init);
  }
  if (init?.state === 'complete') {
    onProgress(file.size, file.size);
    return { alreadyComplete: true, uploadId: init.uploadId };
  }

  const uploadId = init.uploadId;
  const task = session?.taskId ? state.uploadTasks.get(session.taskId) : null;
  if (task) updateUploadTask(task, { uploadId });
  const received = new Set(Array.isArray(init.received) ? init.received.map(Number) : []);
  const requests = [];
  let alreadyStored = 0;
  if (received.size < Number(init.chunkCount || 0)) onPhase('verifying');
  for (let index = 0; index < init.chunkCount; index++) {
    const start = index * init.chunkSize;
    const end = Math.min(file.size, start + init.chunkSize);
    if (received.has(index)) {
      alreadyStored += end - start;
      continue;
    }
    throwIfUploadCancelled(session);
    const blob = file.slice(start, end);
    const digest = await sha256Hex(blob);
    throwIfUploadCancelled(session);
    requests.push(new Request(`/api/large/${encodeURIComponent(uploadId)}/chunk/${index}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'content-type': 'application/octet-stream',
        ...(digest ? { 'x-drop-chunk-sha256': digest } : {}),
      },
      body: blob,
    }));
  }
  onProgress(alreadyStored, file.size);
  session?.uploadIds.add(uploadId);

  // A previous attempt may have uploaded every chunk but failed before the tiny
  // finalization request. Finish that directly instead of creating an empty job.
  if (!requests.length) {
    const completeResponse = await fetch(`/api/large/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
      signal: session?.controller.signal,
      cache: 'no-store',
    });
    const completed = await completeResponse.json();
    if (!completeResponse.ok) throw new Error(completed.error || '后台上传确认失败');
    session?.uploadIds.delete(uploadId);
    forgetPendingUpload(uploadId);
    onProgress(file.size, file.size);
    return completed;
  }

  const jobId = `${BACKGROUND_FETCH_PREFIX}${uploadId}:${Date.now().toString(36)}`;
  onPhase('background-staging');
  try {
    const background = await registration.backgroundFetch.fetch(jobId, requests, {
      title: `发送 ${file.name}`,
    });
    updatePendingUpload(uploadId, { backgroundJobId: jobId, backgroundBaseBytes: alreadyStored, backgroundPaused: false });
    trackBackgroundTransfer({
      uploadId,
      registration: background,
      source: file,
      name: file.name,
      size: file.size,
      baseBytes: alreadyStored,
      jobId,
      taskId: session?.taskId || null,
    });
    session?.backgroundFetches.set(uploadId, background);
    if (session?.cancelled) {
      await setLargeUploadControl(uploadId, 'cancel').catch(() => {});
      removeBackgroundTransfer(uploadId);
      forgetPendingUpload(uploadId);
      session?.uploadIds.delete(uploadId);
      throw uploadCancelledError();
    }

    // fetch() resolves only after the browser has stored the request bodies.
    // From this point the browser, not the document, owns the network job.
    onProgress(Math.min(file.size, alreadyStored + Number(background.uploaded || 0)), file.size);
    onPhase('background-queued');
    return { background: true, uploadId, jobId };
  } catch (error) {
    session?.uploadIds.delete(uploadId);
    session?.backgroundFetches.delete(uploadId);
    if (session?.cancelled || error.name === 'AbortError' || error.name === 'UploadCancelledError') {
      await setLargeUploadControl(uploadId, 'cancel').catch(() => {});
      removeBackgroundTransfer(uploadId);
      forgetPendingUpload(uploadId);
      throw uploadCancelledError();
    }
    // Preserve completed chunks and the resume ticket. The foreground fallback
    // can continue the same upload instead of restarting from byte zero.
    throw backgroundTransferError(error.message || '浏览器无法接管后台上传');
  }
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
  let init = await recoverLargeUpload(source, session);
  if (!init) {
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
    init = await initResponse.json();
    if (!initResponse.ok) throw new Error(init.error || '无法创建大文件上传任务');
    rememberPendingUpload(source, init);
  }
  if (init?.state === 'complete') {
    session?.uploadIds.delete(init.uploadId);
    onProgress(file.size, file.size);
    return { alreadyComplete: true, uploadId: init.uploadId };
  }
  const task = session?.taskId ? state.uploadTasks.get(session.taskId) : null;
  if (task) updateUploadTask(task, { uploadId: init.uploadId });
  session?.uploadIds.add(init.uploadId);

  const chunkLoaded = new Array(init.chunkCount).fill(0);
  const received = new Set(Array.isArray(init.received) ? init.received.map(Number) : []);
  for (const index of received) {
    if (!Number.isInteger(index) || index < 0 || index >= init.chunkCount) continue;
    chunkLoaded[index] = Math.min(init.chunkSize, source.size - index * init.chunkSize);
  }
  const pendingIndexes = [];
  for (let index = 0; index < init.chunkCount; index++) {
    if (!received.has(index)) pendingIndexes.push(index);
  }
  let nextChunk = 0;
  const report = () => onProgress(chunkLoaded.reduce((sum, value) => sum + value, 0), file.size);
  report();
  const worker = async () => {
    while (nextChunk < pendingIndexes.length && !session?.cancelled) {
      const index = pendingIndexes[nextChunk++];
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
    await Promise.all(Array.from({ length: Math.min(chunkWorkers, Math.max(1, pendingIndexes.length)) }, () => worker()));
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
    forgetPendingUpload(init.uploadId);
    onProgress(file.size, file.size);
    return completed;
  } catch (error) {
    if (session?.cancelled || error.name === 'AbortError' || error.name === 'UploadCancelledError') {
      await cleanupLargeUpload(init.uploadId);
      session?.uploadIds.delete(init.uploadId);
      throw uploadCancelledError();
    }
    // Keep completed chunks and the local resume ticket on ordinary network or
    // server failures. The server expires abandoned upload sessions after its retention window.
    session?.uploadIds.delete(init.uploadId);
    throw error;
  }
}

async function cancelCurrentUpload() {
  const active = liveUploadTasks();
  if (!active.length) {
    reconcileUploadSurface();
    return;
  }
  const session = state.uploadSession;
  if (session) session.cancelled = true;
  els.uploadCancel.disabled = true;
  els.uploadLabel.textContent = '正在取消上传…';
  els.uploadSpeed.textContent = '取消中';
  await Promise.allSettled(active.map((task) => cancelUploadTask(task)));
  els.uploadCancel.disabled = false;
  reconcileUploadSurface();
}

async function uploadFiles(files) {
  const list = [...files].filter(Boolean);
  if (!list.length) return;

  const valid = [];
  for (const file of list) {
    if (file.size > 4 * 1024 * 1024 * 1024) toast(`${file.name} 超过 4 GB，已跳过`, true);
    else valid.push(file);
  }
  if (!valid.length) return;
  if (state.uploading) {
    const added = state.uploadSession?.enqueueFiles?.(valid) || 0;
    if (added) toast(added === 1 ? `${valid[0].name} 已加入上传队列` : `${added} 个文件已加入上传队列`);
    else toast('当前上传队列暂时无法接收新文件', true);
    els.photoInput.value = '';
    els.fileInput.value = '';
    return;
  }

  // Returning from a system photo/file picker can leave the visual viewport at
  // an old scroll position. A local send is an explicit intent to return to the
  // newest message, so pin the chat before and after the upload lifecycle.
  state.followLatest = true;
  scrollLatest();

  state.uploading = true;
  const session = {
    cancelled: false,
    tasks: new Map(),
    failedTaskIds: new Set(),
  };
  state.uploadSession = session;
  const tasks = valid.map((file, index) => {
    const taskId = `upload:${crypto.randomUUID?.() || `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`}`;
    const control = {
      taskId,
      cancelled: false,
      paused: false,
      controller: new AbortController(),
      xhrs: new Set(),
      uploadIds: new Set(),
      confirmWaiters: new Set(),
      backgroundFetches: new Map(),
      mediaCacheKeys: new Set(),
      pauseWaiters: new Set(),
    };
    const task = {
      id: taskId,
      file,
      name: file.name,
      size: file.size,
      loaded: 0,
      uploadId: null,
      status: 'queued',
      control,
      createdAt: Date.now() + index,
    };
    session.tasks.set(taskId, task);
    state.uploadTasks.set(taskId, task);
    return task;
  });
  els.attachButton.disabled = false;
  els.uploadCancel.hidden = false;
  els.uploadCancel.disabled = false;
  els.uploadCancel.textContent = '全部取消';
  const mobile = isCompactPointer();
  const ios = isIOSWebKit();
  let totalBytes = valid.reduce((sum, file) => sum + file.size, 0);
  const loaded = new Array(valid.length).fill(0);
  const started = performance.now();
  const activeNames = new Set();
  const confirmingIndexes = new Set();
  let settled = 0;
  let succeeded = 0;
  let backgroundQueued = 0;
  let nextIndex = 0;

  const renderProgress = () => {
    if (!liveUploadTasks().length && !state.backgroundTransfers.size) {
      reconcileUploadSurface();
      return;
    }
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
    els.uploadCancel.textContent = '全部取消';
    renderUploadTasks();
  };

  session.enqueueFiles = (incoming) => {
    if (session.cancelled) return 0;
    let added = 0;
    for (const file of incoming) {
      const index = valid.length;
      const taskId = `upload:${crypto.randomUUID?.() || `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`}`;
      const control = {
        taskId,
        cancelled: false,
        paused: false,
        controller: new AbortController(),
        xhrs: new Set(),
        uploadIds: new Set(),
        confirmWaiters: new Set(),
        backgroundFetches: new Map(),
        mediaCacheKeys: new Set(),
        pauseWaiters: new Set(),
      };
      const task = {
        id: taskId,
        file,
        name: file.name,
        size: file.size,
        loaded: 0,
        uploadId: null,
        status: 'queued',
        control,
        createdAt: Date.now() + index,
      };
      valid.push(file);
      tasks.push(task);
      loaded.push(0);
      totalBytes += file.size;
      session.tasks.set(taskId, task);
      state.uploadTasks.set(taskId, task);
      added += 1;
    }
    if (added) {
      els.uploadProgress.classList.remove('hidden');
      els.uploadCancel.hidden = false;
      els.uploadCancel.textContent = '全部取消';
      renderProgress();
    }
    return added;
  };

  session.retryTask = (task) => {
    if (session.cancelled || task?.status !== 'failed' || !task.file || !session.tasks.has(task.id)) return false;
    const control = task.control;
    if (!control) return false;
    if (control.controller.signal.aborted) control.controller = new AbortController();
    control.cancelled = false;
    control.paused = false;
    const index = valid.length;
    valid.push(task.file);
    tasks.push(task);
    loaded.push(0);
    session.failedTaskIds.delete(task.id);
    updateUploadTask(task, { loaded: 0, status: 'queued', createdAt: Date.now() + index });
    els.uploadProgress.classList.remove('hidden');
    els.uploadCancel.hidden = false;
    renderProgress();
    return true;
  };

  els.progressBar.style.width = '0%';
  els.uploadProgress.classList.remove('hidden');
  renderProgress();

  const worker = async () => {
    while (nextIndex < valid.length && !session.cancelled) {
      const index = nextIndex++;
      const file = valid[index];
      const task = tasks[index];
      const control = task.control;
      if (control.cancelled) {
        settled += 1;
        continue;
      }
      activeNames.add(file.name);
      updateUploadTask(task, { status: control.paused ? 'paused' : 'uploading' });
      renderProgress();
      try {
        await waitForUploadWindow(control);
        let source = file;
        if (isMediaFile(file) && navigator.storage?.getDirectory) {
          updateUploadTask(task, { status: 'staging' });
          els.uploadLabel.textContent = `正在准备可恢复上传 · ${file.name}`;
          els.uploadSpeed.textContent = '建立可恢复缓存';
          source = await stageMediaForResume(file, control, (done, total) => {
            const percent = total ? Math.min(100, Math.round(done / total * 100)) : 0;
            els.progressBar.style.width = `${percent}%`;
            els.uploadPercent.textContent = `${percent}%`;
            els.uploadLabel.textContent = `正在准备可恢复上传 · ${file.name}`;
            els.uploadSpeed.textContent = '建立可恢复缓存';
          });
          loaded[index] = 0;
          updateUploadTask(task, { loaded: 0, status: control.paused ? 'paused' : 'uploading' });
          renderProgress();
        }
        const progress = (bytes) => {
          loaded[index] = bytes;
          updateUploadTask(task, { loaded: bytes });
          renderProgress();
        };
        const phase = (value) => {
          if (value === 'confirming') confirmingIndexes.add(index);
          if (value === 'confirming') updateUploadTask(task, { status: 'confirming' });
          if (value === 'verifying') {
            updateUploadTask(task, { status: 'verifying' });
            els.uploadLabel.textContent = `正在校验 · ${file.name}`;
            els.uploadSpeed.textContent = '完整性校验';
          }
          if (value === 'background-staging') {
            updateUploadTask(task, { status: 'background' });
            els.uploadLabel.textContent = `正在交给浏览器后台 · ${file.name}`;
            els.uploadSpeed.textContent = '准备后台发送';
          }
          if (value === 'background-queued') updateUploadTask(task, { status: 'background' });
          renderProgress();
        };

        await waitForUploadWindow(control);
        if (task.status === 'paused') updateUploadTask(task, { status: 'uploading' });
        let data = null;
        if (await canUseBackgroundFetch()) {
          try {
            data = await uploadLargeOneInBackground(source, progress, { session: control, onPhase: phase });
          } catch (error) {
            if (error.name !== 'BackgroundTransferError') throw error;
            toast(`${file.name}：后台接管不可用，继续当前页面上传`, true);
          }
        }
        if (!data) {
          // Use the same resumable chunk protocol on every browser. Keeping the
          // old one-shot XHR as the desktop fallback made small files impossible
          // to recover after a real page close on Firefox/Safari.
          data = await uploadLargeOne(source, progress, {
            mobile: mobile || ios,
            session: control,
            onPhase: phase,
          });
        }

        confirmingIndexes.delete(index);
        if (data?.background) {
          backgroundQueued += 1;
          updateUploadTask(task, { status: 'background' });
        } else {
          loaded[index] = file.size;
          succeeded += 1;
          updateUploadTask(task, { loaded: file.size, status: 'complete' });
          if (data?.alreadyComplete) loadMessages({ quiet: true }).catch(() => {});
          else addMessage(data, { keepScroll: false });
          setTimeout(() => {
            if (task.status === 'complete') {
              state.uploadTasks.delete(task.id);
              renderUploadTasks();
            }
          }, 1800);
        }
      } catch (error) {
        if (control.cancelled || error.name === 'UploadCancelledError' || error.name === 'AbortError') {
          updateUploadTask(task, { status: 'cancelled' });
        } else if (!session.cancelled) {
          loaded[index] = 0;
          session.failedTaskIds.add(task.id);
          updateUploadTask(task, { status: 'failed' });
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

    const sessionTasks = [...session.tasks.values()];
    const failureCount = session.failedTaskIds.size;
    const cancelledCount = sessionTasks.filter((task) => task.status === 'cancelled').length;
    const completedCount = sessionTasks.filter((task) => task.status === 'complete').length;
    if (session.cancelled) {
      els.uploadLabel.textContent = `已取消上传 · 已完成 ${completedCount}/${sessionTasks.length}`;
      els.uploadSpeed.textContent = '已取消';
      setTimeout(() => els.uploadProgress.classList.add('hidden'), 2800);
    } else if (failureCount) {
      els.uploadLabel.textContent = `上传结束 · 已完成 ${completedCount} · 后台 ${backgroundQueued} · 失败 ${failureCount}`;
      els.uploadPercent.textContent = `${Math.round(((completedCount + backgroundQueued) / Math.max(1, sessionTasks.length)) * 100)}%`;
      els.uploadSpeed.textContent = '有失败';
      setTimeout(() => {
        if (!renderBackgroundTransfers() && !state.uploading) els.uploadProgress.classList.add('hidden');
      }, 5000);
    } else if (backgroundQueued > 0) {
      renderBackgroundTransfers();
    } else if (cancelledCount > 0) {
      els.uploadLabel.textContent = `上传结束 · 已完成 ${completedCount} · 已取消 ${cancelledCount}`;
      els.uploadSpeed.textContent = '已结束';
      setTimeout(() => { if (!state.backgroundTransfers.size) els.uploadProgress.classList.add('hidden'); }, 2200);
    } else {
      els.uploadLabel.textContent = sessionTasks.length === 1 ? `上传完成 · ${sessionTasks[0].name}` : `上传完成 · ${sessionTasks.length} 个文件`;
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
      els.uploadCancel.disabled = false;
      if (!renderBackgroundTransfers()) {
        els.uploadCancel.hidden = true;
        els.uploadCancel.textContent = '全部取消';
      }
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
      await restoreBackgroundTransfers();
      resumeCachedMediaUploadsCoordinated().catch(() => {});
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

async function configureAccessLogout() {
  if (isLoopbackPage()) return;
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const health = await readApiJson(response);
    const logoutUrl = typeof health?.accessLogoutUrl === 'string' ? health.accessLogoutUrl.trim() : '';
    if (!logoutUrl) return;
    els.accessLogoutGroup.hidden = false;
    els.accessLogout.addEventListener('click', () => {
      window.location.assign(logoutUrl);
    });
  } catch {
    // Logout is an optional deployment capability. Do not block SelfDrop boot
    // when the health probe or external authentication layer is unavailable.
  }
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
  els.uploadCancel.addEventListener('click', handleUploadControl);
  els.uploadTaskList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-upload-action]');
    const row = event.target.closest('[data-upload-task]');
    if (!button || !row) return;
    const task = state.uploadTasks.get(row.dataset.uploadTask);
    if (!task) return;
    if (button.dataset.uploadAction === 'pause') pauseUploadTask(task);
    if (button.dataset.uploadAction === 'resume') resumeUploadTask(task);
    if (button.dataset.uploadAction === 'retry') retryUploadTask(task);
    if (button.dataset.uploadAction === 'cancel') cancelUploadTask(task);
  });
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
    // Keep the live connection alive while the tab is merely hidden. Browsers
    // may throttle or suspend it themselves, in which case EventSource.onerror
    // and the visible-page resume path already recover. Closing it here made a
    // normal tab/app switch look exactly like a network disconnect.
    syncTransferWakeLock().catch(() => {});
    if (!document.hidden) resumeConnection();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!shouldWarnBeforeUnload()) return;
    event.preventDefault();
    event.returnValue = '';
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
  configureAccessLogout();
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', handleTransferWorkerMessage);
  ensureTransferWorker();
  resizeComposer();
  renderMessages(false);
  try {
    await loadMessages();
    await restoreBackgroundTransfers();
    resumeCachedMediaUploadsCoordinated().catch(() => {});
  } catch (error) {
    setConnection('offline');
    toast(error.message || '连接失败', true);
  }
}

boot();
