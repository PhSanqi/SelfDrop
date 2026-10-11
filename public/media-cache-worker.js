self.onmessage = async (event) => {
  const { file, cacheKey, directory } = event.data || {};
  if (!file || !cacheKey || !directory) {
    self.postMessage({ type: 'error', error: '缓存任务参数无效' });
    return;
  }

  let access;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(directory, { create: true });
    const handle = await dir.getFileHandle(cacheKey, { create: true });
    access = await handle.createSyncAccessHandle();
    access.truncate(0);

    const chunkSize = 4 * 1024 * 1024;
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(file.size, offset + chunkSize);
      const buffer = await file.slice(offset, end).arrayBuffer();
      const view = new Uint8Array(buffer);
      let written = 0;
      while (written < view.byteLength) {
        const count = access.write(view.subarray(written), { at: offset + written });
        if (!count) throw new Error('浏览器未写入媒体缓存');
        written += count;
      }
      offset = end;
      self.postMessage({ type: 'progress', loaded: offset });
    }
    access.truncate(file.size);
    access.flush();
    access.close();
    access = null;
    self.postMessage({ type: 'done' });
  } catch (error) {
    try { access?.close(); } catch { /* ignore */ }
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(directory, { create: true });
      await dir.removeEntry(cacheKey);
    } catch { /* best effort cleanup */ }
    self.postMessage({ type: 'error', error: error?.message || 'Safari 媒体缓存失败' });
  }
};
