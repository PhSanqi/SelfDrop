#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'http://127.0.0.1:2585';
const DEFAULT_DOWNLOAD_DIR = join(homedir(), '.local/share/selfdrop-agent/downloads');
const SMALL_UPLOAD_LIMIT = 90 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;

function fail(message, code = 'agent_error') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  const url = new URL(String(value || DEFAULT_BASE_URL));
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1';
  if (!loopback) throw fail('Phase 1 仅允许连接本机 SelfDrop（127.0.0.1 / localhost / ::1）', 'remote_base_blocked');
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw fail(body?.error || `${label} failed with HTTP ${response.status}`, 'http_error');
  return body;
}

async function getHistory(baseUrl) {
  const response = await fetch(`${baseUrl}/api/messages`, { cache: 'no-store' });
  return responseJson(response, 'list');
}

export async function listFiles(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.SELFDROP_BASE_URL);
  const history = await getHistory(baseUrl);
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 100));
  const files = (history.messages || [])
    .filter((message) => message?.attachment?.url)
    .map((message) => ({
      fileId: message.sequenceId || message.id,
      messageId: message.id,
      time: message.time,
      expires: message.attachment.expires,
      device: message.device,
      name: message.attachment.name,
      type: message.attachment.type,
      size: Number(message.attachment.size) || 0,
      url: message.attachment.url,
      large: Boolean(message.attachment.large),
    }))
    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0))
    .slice(0, limit);
  return { baseUrl, count: files.length, files };
}

function safeLocalName(value) {
  const normalized = String(value || 'file').replace(/\\/g, '/');
  const name = basename(normalized).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 220);
  return !name || name === '.' || name === '..' ? 'file' : name;
}

function ensureSameOriginDownload(baseUrl, value) {
  const base = new URL(baseUrl);
  const target = new URL(String(value || ''), `${baseUrl}/`);
  if (target.origin !== base.origin) throw fail('SelfDrop 返回了非同源下载地址，已拒绝', 'cross_origin_download');
  return target;
}

export async function pullFile(fileId, options = {}) {
  const id = String(fileId || '').trim();
  if (!id) throw fail('pull 需要 file-id', 'missing_file_id');
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.SELFDROP_BASE_URL);
  const history = await getHistory(baseUrl);
  const message = (history.messages || []).find((item) => item?.attachment?.url && (item.sequenceId === id || item.id === id));
  if (!message) throw fail(`未找到文件：${id}`, 'file_not_found');

  const filename = safeLocalName(message.attachment.name);
  const destination = options.output
    ? resolve(String(options.output))
    : join(resolve(String(options.dir || process.env.SELFDROP_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR)), filename);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

  const target = ensureSameOriginDownload(baseUrl, message.attachment.url);
  const temporary = options.force ? `${destination}.selfdrop-${process.pid}-${Date.now()}.tmp` : destination;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw fail(`目标文件已存在：${destination}；如确需覆盖请显式使用 --force`, 'destination_exists');
    throw error;
  }

  try {
    const response = await fetch(target, { cache: 'no-store' });
    if (!response.ok || !response.body) throw fail(`下载失败：HTTP ${response.status}`, 'download_failed');
    const output = handle.createWriteStream({ autoClose: true });
    await pipeline(Readable.fromWeb(response.body), output);
    handle = null;
    if (options.force) await rename(temporary, destination);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  const info = await stat(destination);
  return {
    fileId: message.sequenceId || message.id,
    name: filename,
    size: info.size,
    localPath: destination,
  };
}

function contentTypeFor(filename) {
  const ext = extname(filename).toLowerCase();
  return ({
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.zip': 'application/zip',
  })[ext] || 'application/octet-stream';
}

async function pushSmall(baseUrl, filePath, info, device) {
  const filename = safeLocalName(filePath);
  const query = new URLSearchParams({ filename, device });
  const response = await fetch(`${baseUrl}/api/upload?${query}`, {
    method: 'POST',
    headers: {
      'content-type': contentTypeFor(filename),
      'content-length': String(info.size),
      'x-drop-filename': filename,
      'x-drop-device': device,
    },
    body: createReadStream(filePath),
    duplex: 'half',
  });
  return responseJson(response, 'push');
}

async function pushLarge(baseUrl, filePath, info, device) {
  const filename = safeLocalName(filePath);
  const initResponse = await fetch(`${baseUrl}/api/large/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: filename,
      type: contentTypeFor(filename),
      size: info.size,
      device,
      chunkSize: DEFAULT_CHUNK_SIZE,
    }),
  });
  const init = await responseJson(initResponse, 'large upload init');
  const uploadId = init.uploadId;
  const file = await open(filePath, 'r');
  try {
    for (let index = 0; index < init.chunkCount; index++) {
      const offset = index * init.chunkSize;
      const length = Math.min(init.chunkSize, info.size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw fail(`读取分块失败：${index + 1}/${init.chunkCount}`, 'chunk_read_failed');
      const response = await fetch(`${baseUrl}/api/large/${encodeURIComponent(uploadId)}/chunk/${index}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(length) },
        body: buffer,
      });
      await responseJson(response, `large upload chunk ${index}`);
    }
  } catch (error) {
    await fetch(`${baseUrl}/api/large/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }

  const completeResponse = await fetch(`${baseUrl}/api/large/${encodeURIComponent(uploadId)}/complete`, { method: 'POST' });
  return responseJson(completeResponse, 'large upload complete');
}

export async function pushFile(inputPath, options = {}) {
  const filePath = resolve(String(inputPath || ''));
  if (!inputPath) throw fail('push 需要本地文件路径', 'missing_path');
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw fail(`不是可上传的普通文件：${filePath}`, 'invalid_path');

  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.SELFDROP_BASE_URL);
  const device = String(options.device || process.env.SELFDROP_AGENT_DEVICE || 'Local AI').trim().slice(0, 48) || 'Local AI';
  const message = info.size <= SMALL_UPLOAD_LIMIT
    ? await pushSmall(baseUrl, filePath, info, device)
    : await pushLarge(baseUrl, filePath, info, device);
  return {
    fileId: message.sequenceId || message.id,
    messageId: message.id,
    name: message.attachment?.name || safeLocalName(filePath),
    size: Number(message.attachment?.size) || info.size,
    url: message.attachment?.url,
    large: Boolean(message.attachment?.large),
  };
}

function usage() {
  return `SelfDrop Local Agent File Gateway\n\nUsage:\n  selfdrop-agent list [--limit N] [--base URL]\n  selfdrop-agent pull <file-id> [--dir DIR | --out FILE] [--force] [--base URL]\n  selfdrop-agent push <file> [--device NAME] [--base URL]\n\nEnvironment:\n  SELFDROP_BASE_URL       defaults to http://127.0.0.1:2585\n  SELFDROP_DOWNLOAD_DIR   defaults to ~/.local/share/selfdrop-agent/downloads\n  SELFDROP_AGENT_DEVICE   defaults to Local AI\n\nPhase 1 intentionally accepts loopback SelfDrop URLs only and exposes no delete command.`;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const positional = [];
  const options = {};
  while (args.length) {
    const arg = args.shift();
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'force') {
      options.force = true;
      continue;
    }
    const value = args.shift();
    if (value == null || value.startsWith('--')) throw fail(`选项 --${key} 缺少值`, 'invalid_args');
    if (key === 'base') options.baseUrl = value;
    else if (key === 'limit') options.limit = value;
    else if (key === 'dir') options.dir = value;
    else if (key === 'out') options.output = value;
    else if (key === 'device') options.device = value;
    else throw fail(`未知选项：--${key}`, 'invalid_args');
  }
  return { command, positional, options };
}

export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const { command, positional, options } = parseArgs(argv);
  let result;
  if (command === 'list') result = await listFiles(options);
  else if (command === 'pull') result = await pullFile(positional[0], options);
  else if (command === 'push') result = await pushFile(positional[0], options);
  else throw fail(`未知命令：${command}`, 'invalid_command');
  process.stdout.write(`${JSON.stringify({ ok: true, command, result }, null, 2)}\n`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code || 'agent_error' })}\n`);
    process.exitCode = 1;
  });
}
