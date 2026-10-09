import http from 'node:http';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const HOST = process.env.DROP_CHAT_HOST || '127.0.0.1';
const PORT = Number(process.env.DROP_CHAT_PORT || 2585);
const NTFY_BASE = (process.env.NTFY_BASE_URL || 'http://127.0.0.1:2586').replace(/\/$/, '');
const TOPIC = process.env.NTFY_TOPIC || 'inbox';
const CREDENTIALS = process.env.NTFY_CREDENTIALS || join(homedir(), '.config/ntfy/owner-credentials.txt');
const MAX_UPLOAD = 90 * 1024 * 1024;
const LARGE_CHUNK_SIZE = 16 * 1024 * 1024;
const MIN_CHUNK_SIZE = 1 * 1024 * 1024;
const MAX_LARGE_UPLOAD = 4 * 1024 * 1024 * 1024;
const LARGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DATA_DIR = process.env.DROP_CHAT_DATA_DIR || join(homedir(), '.local/share/drop-chat');
const LARGE_DIR = join(DATA_DIR, 'large');
const UPLOAD_DIR = join(DATA_DIR, 'uploads');
const NTFY_CACHE_FILE = process.env.NTFY_CACHE_FILE || join(homedir(), '.local/share/ntfy/cache.db');
const NTFY_ATTACHMENT_DIR = process.env.NTFY_ATTACHMENT_DIR || join(homedir(), '.local/share/ntfy/attachments');
const LARGE_MARKER = '__DROP_FILE_V1__:';
const purgeClients = new Set();
let purgeInProgress = false;

function loadCredentials() {
  const envUsername = String(process.env.NTFY_USERNAME || '').trim();
  const envPassword = String(process.env.NTFY_PASSWORD || '');
  if (envUsername) return { username: envUsername, password: envPassword };

  try {
    const values = Object.fromEntries(
      readFileSync(CREDENTIALS, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf('=');
          return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : [line, ''];
        }),
    );
    if (!values.username || !values.password) throw new Error(`Invalid ntfy credentials file: ${CREDENTIALS}`);
    return values;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function authorization() {
  const credentials = loadCredentials();
  if (!credentials) return null;
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

function safeDevice(value) {
  return String(value || '未知设备').trim().slice(0, 48) || '未知设备';
}

function safeFilename(value) {
  return String(value || 'file').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 220) || 'file';
}

function parseLargeMarker(value) {
  const text = String(value || '');
  if (!text.startsWith(LARGE_MARKER)) return null;
  try {
    const data = JSON.parse(Buffer.from(text.slice(LARGE_MARKER.length), 'base64url').toString('utf8'));
    if (!data?.id || !data?.name || !Number.isFinite(Number(data.size))) return null;
    return data;
  } catch {
    return null;
  }
}

function broadcastPurge(scope) {
  const payload = `data: ${JSON.stringify({ event: 'purge', scope, time: Math.floor(Date.now() / 1000) })}\n\n`;
  for (const res of [...purgeClients]) {
    try {
      if (!res.writableEnded) res.write(payload);
    } catch {
      purgeClients.delete(res);
    }
  }
}

async function openCacheDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(NTFY_CACHE_FILE);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name));
  for (const name of ['mid', 'sequence_id', 'topic', 'event', 'message', 'attachment_size']) {
    if (!columns.has(name)) {
      db.close();
      throw Object.assign(new Error(`ntfy cache schema missing ${name}`), { statusCode: 503 });
    }
  }
  return db;
}

function purgeInventoryFromRows(rows) {
  const messages = rows.filter((row) => row.event === 'message');
  const fileRows = [];
  let fileBytes = 0;
  for (const row of messages) {
    const large = parseLargeMarker(row.message);
    const attachmentSize = Number(row.attachment_size) || 0;
    if (!large && attachmentSize <= 0) continue;
    fileRows.push(row);
    fileBytes += large ? Number(large.size) || 0 : attachmentSize;
  }
  return {
    historyCount: messages.length,
    textCount: Math.max(0, messages.length - fileRows.length),
    fileCount: fileRows.length,
    fileBytes,
    rowCount: rows.length,
  };
}

async function readPurgeInventory() {
  const db = await openCacheDb();
  try {
    const rows = db.prepare(`SELECT mid, sequence_id, event, message, attachment_size FROM messages WHERE topic = ? ORDER BY time`).all(TOPIC);
    const summary = purgeInventoryFromRows(rows);
    let diskBytes = 0;
    for (const row of rows) {
      if (row.event !== 'message') continue;
      if (Number(row.attachment_size) > 0 && /^[A-Za-z0-9]{12}$/.test(String(row.mid || ''))) {
        const info = await stat(join(NTFY_ATTACHMENT_DIR, row.mid)).catch(() => null);
        if (info?.isFile()) diskBytes += info.size;
      }
      const large = parseLargeMarker(row.message);
      if (large?.id && /^[0-9a-f-]{36}$/i.test(large.id)) {
        const info = await stat(largeFilePath(large.id)).catch(() => null);
        if (info?.isFile()) diskBytes += info.size;
      }
    }
    return { ...summary, diskBytes };
  } finally {
    db.close();
  }
}

async function storageSummary(res) {
  const summary = await readPurgeInventory();
  return json(res, 200, { topic: TOPIC, ...summary });
}

async function moveIfExists(source, target, moved) {
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) return 0;
  await rename(source, target);
  moved.push([source, target]);
  return info.size;
}

async function rollbackMovedFiles(moved) {
  for (const [source, target] of [...moved].reverse()) {
    const info = await stat(target).catch(() => null);
    if (!info) continue;
    await rename(target, source).catch(() => {});
  }
}

async function purgeStorage(req, res) {
  if (purgeInProgress) return json(res, 409, { error: '已有清理任务正在进行' });
  const input = await readJsonBody(req, 16 * 1024);
  const mode = input.mode === 'all' ? 'all' : input.mode === 'files' ? 'files' : '';
  if (!mode || input.confirm !== mode) return json(res, 400, { error: '清理确认无效' });

  purgeInProgress = true;
  const trashDir = join(DATA_DIR, 'purge-trash', randomUUID());
  const moved = [];
  let db;
  let committed = false;
  try {
    db = await openCacheDb();
    const rows = db.prepare(`SELECT mid, sequence_id, event, message, attachment_size FROM messages WHERE topic = ? ORDER BY time`).all(TOPIC);
    const inventory = purgeInventoryFromRows(rows);
    const targetSequences = new Set();
    const attachmentMids = new Set();
    const largeIds = new Set();
    let deletedDiskBytes = 0;

    for (const row of rows) {
      if (row.event !== 'message') continue;
      const large = parseLargeMarker(row.message);
      const isFile = Boolean(large) || Number(row.attachment_size) > 0;
      if (mode === 'files' && !isFile) continue;
      const sequence = String(row.sequence_id || row.mid || '').trim();
      if (sequence) targetSequences.add(sequence);
      if (Number(row.attachment_size) > 0 && /^[A-Za-z0-9]{12}$/.test(String(row.mid || ''))) attachmentMids.add(row.mid);
      if (large?.id && /^[0-9a-f-]{36}$/i.test(large.id)) largeIds.add(large.id);
    }

    if (mode === 'all') {
      for (const row of rows) {
        if (Number(row.attachment_size) > 0 && /^[A-Za-z0-9]{12}$/.test(String(row.mid || ''))) attachmentMids.add(row.mid);
        const large = parseLargeMarker(row.message);
        if (large?.id && /^[0-9a-f-]{36}$/i.test(large.id)) largeIds.add(large.id);
      }
    }

    await mkdir(trashDir, { recursive: true, mode: 0o700 });
    for (const mid of attachmentMids) {
      deletedDiskBytes += await moveIfExists(join(NTFY_ATTACHMENT_DIR, mid), join(trashDir, `ntfy-${mid}`), moved);
    }
    for (const id of largeIds) {
      deletedDiskBytes += await moveIfExists(largeFilePath(id), join(trashDir, `large-${id}.bin`), moved);
      deletedDiskBytes += await moveIfExists(largeManifestPath(id), join(trashDir, `large-${id}.json`), moved);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      if (mode === 'all') {
        db.prepare('DELETE FROM messages WHERE topic = ?').run(TOPIC);
      } else {
        const removeSequence = db.prepare('DELETE FROM messages WHERE topic = ? AND (sequence_id = ? OR mid = ?)');
        for (const sequence of targetSequences) removeSequence.run(TOPIC, sequence, sequence);
      }
      db.exec('COMMIT');
      committed = true;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      await rollbackMovedFiles(moved);
      throw error;
    }

    await rm(trashDir, { recursive: true, force: true });
    const remainingRows = db.prepare(`SELECT mid, sequence_id, event, message, attachment_size FROM messages WHERE topic = ? ORDER BY time`).all(TOPIC);
    const remaining = purgeInventoryFromRows(remainingRows);
    const deleted = mode === 'all'
      ? { ...inventory, diskBytes: deletedDiskBytes }
      : {
          historyCount: Math.max(0, inventory.historyCount - remaining.historyCount),
          textCount: Math.max(0, inventory.textCount - remaining.textCount),
          fileCount: Math.max(0, inventory.fileCount - remaining.fileCount),
          fileBytes: Math.max(0, inventory.fileBytes - remaining.fileBytes),
          diskBytes: deletedDiskBytes,
          rowCount: Math.max(0, inventory.rowCount - remaining.rowCount),
        };
    broadcastPurge(mode);
    return json(res, 200, { ok: true, mode, deleted, remaining });
  } catch (error) {
    if (!committed) await rollbackMovedFiles(moved);
    await rm(trashDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
    purgeInProgress = false;
  }
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error('请求过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('请求格式错误'), { statusCode: 400 });
  }
}

function mapMessage(message) {
  const large = parseLargeMarker(message.message);
  const attachment = large
    ? {
        name: large.name,
        type: large.type || 'application/octet-stream',
        size: Number(large.size) || 0,
        expires: large.expires,
        url: `/large/${encodeURIComponent(large.id)}`,
        large: true,
      }
    : message.attachment
    ? {
        name: message.attachment.name,
        type: message.attachment.type || 'application/octet-stream',
        size: message.attachment.size || 0,
        expires: message.attachment.expires,
        url: (() => {
          try {
            return new URL(message.attachment.url).pathname;
          } catch {
            return message.attachment.url;
          }
        })(),
      }
    : null;
  return {
    event: 'message',
    id: message.id,
    sequenceId: message.sequence_id || message.id,
    time: message.time,
    expires: message.expires,
    device: message.title || '历史设备',
    text: large || (attachment && /^You received a file:/i.test(message.message || '')) ? '' : message.message || '',
    attachment,
  };
}

function mapDelete(message) {
  return {
    event: 'delete',
    id: message.id,
    sequenceId: message.sequence_id,
    time: message.time,
  };
}

function foldHistory(items) {
  const current = new Map();
  for (const item of items) {
    if (item.event === 'message') {
      const message = mapMessage(item);
      current.set(message.sequenceId, message);
    } else if (item.event === 'message_delete' && item.sequence_id) {
      current.delete(item.sequence_id);
    }
  }
  return [...current.values()].sort((a, b) => a.time - b.time);
}

async function ntfyFetch(path, init = {}) {
  const headers = new Headers(init.headers || {});
  const auth = authorization();
  if (auth) headers.set('authorization', auth);
  return fetch(`${NTFY_BASE}${path}`, { ...init, headers });
}

async function readHistory(res) {
  const upstream = await ntfyFetch(`/${encodeURIComponent(TOPIC)}/json?poll=1&since=all`);
  if (!upstream.ok) return json(res, 502, { error: `ntfy history returned ${upstream.status}` });
  const text = await upstream.text();
  const items = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const messages = foldHistory(items);
  const cursor = items.reduce((latest, item) => Math.max(latest, Number(item.time) || 0), 0) || 'all';
  return json(res, 200, { topic: TOPIC, cursor, messages });
}

async function findLargeFileForSequence(sequenceId) {
  try {
    const upstream = await ntfyFetch(`/${encodeURIComponent(TOPIC)}/json?poll=1&since=all`);
    if (!upstream.ok) return null;
    const items = (await upstream.text()).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    let large = null;
    for (const item of items) {
      const currentSequence = item.sequence_id || item.id;
      if (currentSequence !== sequenceId) continue;
      if (item.event === 'message') large = parseLargeMarker(item.message);
      if (item.event === 'message_delete') large = null;
    }
    return large;
  } catch {
    return null;
  }
}

async function deleteMessage(res, sequenceId) {
  const value = String(sequenceId || '').trim();
  if (!value || value.length > 128) return json(res, 400, { error: '消息标识无效' });
  const large = await findLargeFileForSequence(value);
  const upstream = await ntfyFetch(`/${encodeURIComponent(TOPIC)}/${encodeURIComponent(value)}`, {
    method: 'DELETE',
  });
  const body = await upstream.text();
  if (!upstream.ok) return json(res, 502, { error: `ntfy delete returned ${upstream.status}` });
  if (large?.id) {
    await Promise.all([
      rm(largeFilePath(large.id), { force: true }).catch(() => {}),
      rm(largeManifestPath(large.id), { force: true }).catch(() => {}),
    ]);
  }
  try {
    return json(res, 200, mapDelete(JSON.parse(body)));
  } catch {
    return json(res, 200, { event: 'delete', sequenceId: value });
  }
}

async function publishText(req, res) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 24 * 1024) return json(res, 413, { error: '消息过长' });
  }
  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    return json(res, 400, { error: '请求格式错误' });
  }
  const text = String(input.text || '').trim();
  if (!text) return json(res, 400, { error: '消息不能为空' });
  if (Buffer.byteLength(text) > 4096) return json(res, 413, { error: '单条消息最多约 4 KB' });
  const query = new URLSearchParams({ title: safeDevice(input.device) });
  const upstream = await ntfyFetch(`/${encodeURIComponent(TOPIC)}?${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
    body: text,
  });
  const body = await upstream.text();
  if (!upstream.ok) return json(res, 502, { error: `ntfy publish returned ${upstream.status}` });
  return json(res, 200, mapMessage(JSON.parse(body)));
}

async function publishFile(req, res, url) {
  const length = Number(req.headers['content-length'] || 0);
  if (length && length > MAX_UPLOAD) return json(res, 413, { error: '单个文件不能超过 90 MB' });
  const filename = safeFilename(req.headers['x-drop-filename'] || url.searchParams.get('filename'));
  const device = safeDevice(req.headers['x-drop-device'] || url.searchParams.get('device'));
  const query = new URLSearchParams({ filename, title: device });
  const upstream = await ntfyFetch(`/${encodeURIComponent(TOPIC)}?${query}`, {
    method: 'POST',
    headers: {
      'content-type': req.headers['content-type'] || 'application/octet-stream',
      ...(length ? { 'content-length': String(length) } : {}),
    },
    body: req,
    duplex: 'half',
  });
  const body = await upstream.text();
  if (!upstream.ok) return json(res, upstream.status === 413 ? 413 : 502, { error: `ntfy upload returned ${upstream.status}` });
  return json(res, 200, mapMessage(JSON.parse(body)));
}

function largeUploadPath(id) {
  return join(UPLOAD_DIR, id);
}

function largeFilePath(id) {
  return join(LARGE_DIR, `${id}.bin`);
}

function largeManifestPath(id) {
  return join(LARGE_DIR, `${id}.json`);
}

async function readLargeMeta(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error('上传标识无效'), { statusCode: 400 });
  try {
    return JSON.parse(await readFile(join(largeUploadPath(id), 'meta.json'), 'utf8'));
  } catch {
    throw Object.assign(new Error('上传任务不存在或已过期'), { statusCode: 404 });
  }
}

async function initLargeUpload(req, res) {
  const input = await readJsonBody(req);
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) return json(res, 400, { error: '文件大小无效' });
  if (size > MAX_LARGE_UPLOAD) return json(res, 413, { error: '单个文件暂时最多支持 4 GB' });
  const requestedChunkSize = Number(input.chunkSize || LARGE_CHUNK_SIZE);
  const chunkSize = Math.min(
    LARGE_CHUNK_SIZE,
    Math.max(MIN_CHUNK_SIZE, Number.isFinite(requestedChunkSize) ? Math.floor(requestedChunkSize) : LARGE_CHUNK_SIZE),
  );
  const id = randomUUID();
  const meta = {
    id,
    name: safeFilename(input.name),
    type: String(input.type || 'application/octet-stream').slice(0, 160),
    size,
    device: safeDevice(input.device),
    chunkSize,
    chunkCount: Math.ceil(size / chunkSize),
    createdAt: Date.now(),
  };
  const dir = largeUploadPath(id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
  return json(res, 200, { uploadId: id, chunkSize: meta.chunkSize, chunkCount: meta.chunkCount, maxSize: MAX_LARGE_UPLOAD });
}

async function writeLargeChunk(req, res, id, indexValue) {
  const meta = await readLargeMeta(id);
  const index = Number(indexValue);
  if (!Number.isInteger(index) || index < 0 || index >= meta.chunkCount) return json(res, 400, { error: '分块编号无效' });
  const expected = Math.min(meta.chunkSize, meta.size - index * meta.chunkSize);
  const length = Number(req.headers['content-length'] || 0);
  if (length && length !== expected) return json(res, 400, { error: '分块大小不匹配' });

  const dir = largeUploadPath(id);
  const temp = join(dir, `${index}.tmp`);
  const target = join(dir, `${index}.part`);
  const output = createWriteStream(temp, { flags: 'w', mode: 0o600 });
  let received = 0;
  try {
    for await (const chunk of req) {
      received += chunk.length;
      if (received > expected) throw Object.assign(new Error('分块超过预期大小'), { statusCode: 413 });
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'finish');
    if (received !== expected) throw Object.assign(new Error('分块未完整上传'), { statusCode: 400 });
    await rename(temp, target);
    return json(res, 200, { ok: true, index, size: received });
  } catch (error) {
    output.destroy();
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function cancelLargeUpload(res, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 400, { error: '上传标识无效' });
  await rm(largeUploadPath(id), { recursive: true, force: true });
  return json(res, 200, { ok: true, uploadId: id });
}

async function completeLargeUpload(res, id) {
  const meta = await readLargeMeta(id);
  const dir = largeUploadPath(id);
  for (let index = 0; index < meta.chunkCount; index++) {
    const info = await stat(join(dir, `${index}.part`)).catch(() => null);
    const expected = Math.min(meta.chunkSize, meta.size - index * meta.chunkSize);
    if (!info || info.size !== expected) return json(res, 409, { error: `分块 ${index + 1}/${meta.chunkCount} 尚未完整上传` });
  }

  await mkdir(LARGE_DIR, { recursive: true, mode: 0o700 });
  const tempFinal = `${largeFilePath(id)}.tmp`;
  const output = createWriteStream(tempFinal, { flags: 'w', mode: 0o600 });
  try {
    for (let index = 0; index < meta.chunkCount; index++) {
      for await (const chunk of createReadStream(join(dir, `${index}.part`))) {
        if (!output.write(chunk)) await once(output, 'drain');
      }
    }
    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    await rm(tempFinal, { force: true }).catch(() => {});
    throw error;
  }
  const finalInfo = await stat(tempFinal);
  if (finalInfo.size !== meta.size) {
    await rm(tempFinal, { force: true });
    return json(res, 500, { error: '合并后的文件大小校验失败' });
  }
  await rename(tempFinal, largeFilePath(id));
  const expires = Math.floor((Date.now() + LARGE_RETENTION_MS) / 1000);
  const manifest = { id, name: meta.name, type: meta.type, size: meta.size, device: meta.device, createdAt: meta.createdAt, expires };
  await writeFile(largeManifestPath(id), JSON.stringify(manifest), { mode: 0o600 });
  await rm(dir, { recursive: true, force: true });

  const marker = `${LARGE_MARKER}${Buffer.from(JSON.stringify(manifest)).toString('base64url')}`;
  const query = new URLSearchParams({ title: meta.device });
  const upstream = await ntfyFetch(`/${encodeURIComponent(TOPIC)}?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: marker,
  });
  const body = await upstream.text();
  if (!upstream.ok) return json(res, 502, { error: `ntfy publish returned ${upstream.status}` });
  return json(res, 200, mapMessage(JSON.parse(body)));
}

function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function serveLargeFile(req, res, id, url) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, 404, { error: 'Not found' });
  let manifest;
  let info;
  try {
    manifest = JSON.parse(await readFile(largeManifestPath(id), 'utf8'));
    info = await stat(largeFilePath(id));
  } catch {
    return json(res, 404, { error: '文件不存在或已过期' });
  }
  const preview = url?.searchParams?.get('preview') === '1';
  const baseHeaders = {
    'content-type': manifest.type || 'application/octet-stream',
    ...(preview ? {} : { 'content-disposition': contentDisposition(manifest.name || 'file') }),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
  };
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` });
      return res.end();
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= info.size) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, { ...baseHeaders, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(largeFilePath(id), { start, end }).pipe(res);
  }
  res.writeHead(200, { ...baseHeaders, 'content-length': info.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(largeFilePath(id)).pipe(res);
}

async function cleanupLargeFiles() {
  await mkdir(LARGE_DIR, { recursive: true, mode: 0o700 });
  await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const now = Date.now();
  for (const name of await readdir(LARGE_DIR)) {
    if (!name.endsWith('.json')) continue;
    const path = join(LARGE_DIR, name);
    try {
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      if (Number(manifest.expires || 0) * 1000 > now) continue;
      await rm(largeFilePath(manifest.id), { force: true });
      await rm(path, { force: true });
    } catch { /* leave unknown files untouched */ }
  }
  for (const name of await readdir(UPLOAD_DIR)) {
    const dir = join(UPLOAD_DIR, name);
    try {
      const info = await stat(dir);
      if (now - info.mtimeMs > 24 * 60 * 60 * 1000) await rm(dir, { recursive: true, force: true });
    } catch { /* ignore races */ }
  }
}

async function proxyEvents(req, res, url) {
  const since = url.searchParams.get('since') || 'all';
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const upstream = await ntfyFetch(`/${encodeURIComponent(TOPIC)}/sse?since=${encodeURIComponent(since)}`, {
    signal: controller.signal,
  });
  if (!upstream.ok || !upstream.body) return json(res, 502, { error: `ntfy stream returned ${upstream.status}` });
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  purgeClients.add(res);
  res.write('retry: 2500\n\n');
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: keepalive ${Date.now()}\n\n`);
  }, 25000);
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (!data) continue;
        try {
          const item = JSON.parse(data);
          if (item.event === 'message') res.write(`data: ${JSON.stringify(mapMessage(item))}\n\n`);
          if (item.event === 'message_delete' && item.sequence_id) res.write(`data: ${JSON.stringify(mapDelete(item))}\n\n`);
        } catch {
          // Ignore ntfy keepalive/open frames that do not contain message JSON.
        }
      }
    }
  } catch (error) {
    if (error?.name !== 'AbortError') console.error('event stream error', error);
  } finally {
    purgeClients.delete(res);
    clearInterval(heartbeat);
    res.end();
  }
}

async function proxyFile(req, res, pathname) {
  const upstream = await ntfyFetch(pathname, { method: req.method });
  if (!upstream.ok || !upstream.body) {
    res.writeHead(upstream.status || 502);
    return res.end();
  }
  const headers = {
    'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
    'cache-control': upstream.headers.get('cache-control') || 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
  };
  const length = upstream.headers.get('content-length');
  if (length) headers['content-length'] = length;
  res.writeHead(upstream.status, headers);
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC)) return false;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'content-length': info.size,
      // Drop is updated in place and does not use content-hashed filenames. Keeping
      // JS/CSS for an hour can mix a new HTML shell with an old client bundle on
      // mobile browsers, so all app-shell assets must revalidate immediately.
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const upstream = await ntfyFetch('/');
      return json(res, upstream.ok ? 200 : 503, { ok: upstream.ok, topic: TOPIC });
    }
    if (req.method === 'GET' && url.pathname === '/api/messages') return await readHistory(res);
    if (req.method === 'GET' && url.pathname === '/api/events') return await proxyEvents(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/storage') return await storageSummary(res);
    if (req.method === 'POST' && url.pathname === '/api/storage/purge') return await purgeStorage(req, res);
    if (req.method === 'POST' && url.pathname === '/api/messages') return await publishText(req, res);
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/messages/')) {
      return await deleteMessage(res, decodeURIComponent(url.pathname.slice('/api/messages/'.length)));
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') return await publishFile(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/large/init') return await initLargeUpload(req, res);
    const cancelLargeMatch = /^\/api\/large\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (req.method === 'DELETE' && cancelLargeMatch) return await cancelLargeUpload(res, cancelLargeMatch[1]);
    const chunkMatch = /^\/api\/large\/([0-9a-f-]{36})\/chunk\/(\d+)$/i.exec(url.pathname);
    if (req.method === 'PUT' && chunkMatch) return await writeLargeChunk(req, res, chunkMatch[1], chunkMatch[2]);
    const completeMatch = /^\/api\/large\/([0-9a-f-]{36})\/complete$/i.exec(url.pathname);
    if (req.method === 'POST' && completeMatch) return await completeLargeUpload(res, completeMatch[1]);
    const largeMatch = /^\/large\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if ((req.method === 'GET' || req.method === 'HEAD') && largeMatch) return await serveLargeFile(req, res, largeMatch[1], url);
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/file/')) return await proxyFile(req, res, url.pathname);
    if (req.method === 'GET' && (await serveStatic(res, url.pathname))) return;
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, Number(error?.statusCode) || 500, { error: error?.statusCode ? error.message : '服务器暂时不可用' });
    else res.end();
  }
});

cleanupLargeFiles().catch((error) => console.error('large file cleanup failed', error));
const cleanupTimer = setInterval(() => cleanupLargeFiles().catch((error) => console.error('large file cleanup failed', error)), 6 * 60 * 60 * 1000);
cleanupTimer.unref();

server.listen(PORT, HOST, () => {
  console.log(`Drop Chat listening on http://${HOST}:${PORT} -> ${NTFY_BASE}/${TOPIC}`);
});
