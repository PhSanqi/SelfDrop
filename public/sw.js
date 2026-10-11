const BACKGROUND_FETCH_PREFIX = 'selfdrop-upload:';

function uploadIdFromRegistration(registration) {
  const id = String(registration?.id || '');
  const match = new RegExp(`^${BACKGROUND_FETCH_PREFIX}([0-9a-f-]{36})(?::|$)`, 'i').exec(id);
  return match ? match[1] : null;
}

async function updateBackgroundUI(registration, title) {
  try {
    await registration.updateUI({ title });
  } catch {
    // Browser UI updates are optional and vary by implementation.
  }
}

async function notifyClients(message) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) client.postMessage(message);
}

async function completeUpload(uploadId) {
  const response = await fetch(`/api/large/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
  });
  if (response.ok) return await response.json();
  const body = await response.json().catch(() => ({}));
  throw new Error(body.error || `服务器确认失败 (${response.status})`);
}

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('backgroundfetchsuccess', (event) => {
  const uploadId = uploadIdFromRegistration(event.registration);
  if (!uploadId) return;
  event.waitUntil((async () => {
    try {
      const message = await completeUpload(uploadId);
      await updateBackgroundUI(event.registration, 'Drop · 发送完成');
      await notifyClients({ type: 'selfdrop-background-upload-complete', uploadId, message });
    } catch (error) {
      await updateBackgroundUI(event.registration, 'Drop · 已上传，等待服务器确认');
      await notifyClients({ type: 'selfdrop-background-upload-finalize-failed', uploadId, error: error.message || '服务器确认失败' });
      throw error;
    }
  })());
});

self.addEventListener('backgroundfetchfail', (event) => {
  const uploadId = uploadIdFromRegistration(event.registration);
  if (!uploadId) return;
  event.waitUntil(Promise.all([
    updateBackgroundUI(event.registration, 'Drop · 后台发送中断'),
    notifyClients({ type: 'selfdrop-background-upload-failed', uploadId }),
  ]));
});

self.addEventListener('backgroundfetchabort', (event) => {
  const uploadId = uploadIdFromRegistration(event.registration);
  if (!uploadId) return;
  // Treat an external Background Fetch abort as resumable. Normal pause/cancel
  // controls are server-coordinated so the page never needs to abort the
  // browser-owned registration directly.
  event.waitUntil(Promise.all([
    updateBackgroundUI(event.registration, 'Drop · 已暂停'),
    notifyClients({ type: 'selfdrop-background-upload-aborted', uploadId }),
  ]));
});

self.addEventListener('backgroundfetchclick', (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.focus();
    return self.clients.openWindow('/');
  })());
});
