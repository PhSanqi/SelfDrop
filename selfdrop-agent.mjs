#!/usr/bin/env node

import { createReadStream, existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const DEFAULT_BASE_URL = 'http://127.0.0.1:2585';
const DEFAULT_DOWNLOAD_DIR = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'SelfDrop', 'downloads')
  : join(homedir(), '.local/share/selfdrop-agent/downloads');
const SMALL_UPLOAD_LIMIT = 90 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function fail(message, code = 'agent_error') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const parts = host.split('.').map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 127;
}

function normalizeEndpoint(value = DEFAULT_BASE_URL) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_BASE_URL));
  } catch {
    throw fail(`SelfDrop 地址无效：${value}`, 'invalid_base_url');
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('SelfDrop 地址必须使用 HTTP 或 HTTPS', 'invalid_base_url');
  if (!loopback && url.protocol !== 'https:') throw fail('远程 SelfDrop 必须使用 HTTPS', 'remote_https_required');
  if (url.username || url.password) throw fail('SelfDrop 地址不能在 URL 中包含用户名或密码', 'invalid_base_url');
  if (url.pathname && url.pathname !== '/') throw fail('SelfDrop 远程地址必须指向域名根路径，不能附带子路径', 'invalid_base_url');
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return { baseUrl: url.toString().replace(/\/$/, ''), loopback };
}

function configPath() {
  if (process.env.SELFDROP_AGENT_CONFIG) return resolve(process.env.SELFDROP_AGENT_CONFIG);
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(root, 'SelfDrop', 'agent.json');
  }
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(root, 'selfdrop', 'agent.json');
}

async function readConfig() {
  const path = configPath();
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { path, config: null };
    throw error;
  }
  try {
    const config = JSON.parse(raw);
    if (config?.version !== 1 || typeof config?.endpoint !== 'string') throw new Error('invalid shape');
    return { path, config };
  } catch {
    throw fail(`SelfDrop Agent 配置损坏：${path}`, 'invalid_config');
  }
}

async function writeConfig(endpoint) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.selfdrop-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, endpoint }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return path;
}

async function resolveEndpoint(options = {}) {
  const saved = await readConfig();
  const requested = options.baseUrl || process.env.SELFDROP_BASE_URL;
  if (requested) {
    const endpoint = normalizeEndpoint(requested);
    if (!endpoint.loopback) {
      if (!saved.config?.endpoint) throw fail(`远程 SelfDrop 尚未绑定；先运行 selfdrop-agent init ${endpoint.baseUrl}`, 'remote_not_bound');
      const bound = normalizeEndpoint(saved.config.endpoint);
      if (bound.baseUrl !== endpoint.baseUrl) {
        throw fail(`远程地址与已绑定 SelfDrop 不一致：${endpoint.baseUrl}`, 'remote_base_mismatch');
      }
    }
    return endpoint;
  }
  if (saved.config?.endpoint) return normalizeEndpoint(saved.config.endpoint);
  return normalizeEndpoint(DEFAULT_BASE_URL);
}

function cloudflaredError(error, action) {
  if (error?.code === 'ENOENT') {
    return fail('未找到 cloudflared。远程 SelfDrop 需要先安装 Cloudflare cloudflared CLI。', 'cloudflared_missing');
  }
  return fail(`cloudflared ${action} 失败${error?.message ? `：${error.message}` : ''}`, 'cloudflared_error');
}

function cloudflaredExecutable() {
  const explicit = String(process.env.SELFDROP_CLOUDFLARED_PATH || '').trim();
  if (explicit) return resolve(explicit);
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const bundled = join(root, 'SelfDrop', 'bin', 'cloudflared.exe');
    if (existsSync(bundled)) return bundled;
  } else {
    const local = join(homedir(), '.local', 'bin', 'cloudflared');
    if (existsSync(local)) return local;
  }
  return 'cloudflared';
}

async function readCloudflareAccessToken(baseUrl) {
  try {
    const { stdout } = await execFileAsync(cloudflaredExecutable(), ['access', 'token', `-app=${baseUrl}`], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const token = lines.at(-1) || '';
    if (!token) throw fail('cloudflared 未返回 Access token', 'cloudflared_token_missing');
    return token;
  } catch (error) {
    if (error?.code === 'cloudflared_token_missing') throw error;
    throw cloudflaredError(error, 'access token');
  }
}

async function loginCloudflareAccess(baseUrl) {
  await new Promise((resolveLogin, rejectLogin) => {
    const child = spawn(cloudflaredExecutable(), ['access', 'login', baseUrl], {
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', (error) => rejectLogin(cloudflaredError(error, 'access login')));
    child.once('exit', (code, signal) => {
      if (code === 0) resolveLogin();
      else rejectLogin(fail(`Cloudflare Access 登录未完成${signal ? `（${signal}）` : `（exit ${code}）`}`, 'cloudflared_login_failed'));
    });
  });
}

async function getCloudflareAccessToken(baseUrl, { forceLogin = false } = {}) {
  const supplied = String(process.env.SELFDROP_CF_ACCESS_TOKEN || '').trim();
  if (supplied) return supplied;
  if (!forceLogin) {
    try {
      return await readCloudflareAccessToken(baseUrl);
    } catch (error) {
      if (error?.code === 'cloudflared_missing') throw error;
    }
  }
  await loginCloudflareAccess(baseUrl);
  return readCloudflareAccessToken(baseUrl);
}

async function requestContext(options = {}) {
  const endpoint = options.endpoint || await resolveEndpoint(options);
  return {
    ...endpoint,
    accessToken: endpoint.loopback ? null : await getCloudflareAccessToken(endpoint.baseUrl),
  };
}

function isAuthenticationResponse(response) {
  return response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400);
}

async function accessFetch(context, input, init = {}, canRetry = true) {
  const headers = new Headers(init.headers || {});
  if (!context.loopback) headers.set('cf-access-token', context.accessToken || await getCloudflareAccessToken(context.baseUrl));
  const response = await fetch(input, { ...init, headers, redirect: 'manual' });
  if (!context.loopback && canRetry && isAuthenticationResponse(response)) {
    context.accessToken = await getCloudflareAccessToken(context.baseUrl, { forceLogin: true });
    return accessFetch(context, input, init, false);
  }
  if (!context.loopback && isAuthenticationResponse(response)) {
    throw fail(`Cloudflare Access 未授权或登录已失效（HTTP ${response.status}）`, 'cloudflare_access_denied');
  }
  return response;
}

async function responseJson(response, label) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw fail(`${label} 返回了非 JSON 响应（HTTP ${response.status}）`, 'unexpected_response');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw fail(body?.error || `${label} failed with HTTP ${response.status}`, 'http_error');
  return body;
}

async function getHistory(context) {
  const response = await accessFetch(context, `${context.baseUrl}/api/messages`, { cache: 'no-store' });
  return responseJson(response, 'list');
}

export async function listFiles(options = {}) {
  const context = await requestContext(options);
  const history = await getHistory(context);
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
  return { baseUrl: context.baseUrl, count: files.length, files };
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
  const context = await requestContext(options);
  const history = await getHistory(context);
  const message = (history.messages || []).find((item) => item?.attachment?.url && (item.sequenceId === id || item.id === id));
  if (!message) throw fail(`未找到文件：${id}`, 'file_not_found');

  const filename = safeLocalName(message.attachment.name);
  const destination = options.output
    ? resolve(String(options.output))
    : join(resolve(String(options.dir || process.env.SELFDROP_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR)), filename);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

  const target = ensureSameOriginDownload(context.baseUrl, message.attachment.url);
  const temporary = options.force ? `${destination}.selfdrop-${process.pid}-${Date.now()}.tmp` : destination;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw fail(`目标文件已存在：${destination}；如确需覆盖请显式使用 --force`, 'destination_exists');
    throw error;
  }

  try {
    const response = await accessFetch(context, target, { cache: 'no-store' });
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

async function pushSmall(context, filePath, info, device) {
  const filename = safeLocalName(filePath);
  const query = new URLSearchParams({ filename, device });
  const response = await accessFetch(context, `${context.baseUrl}/api/upload?${query}`, {
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

async function pushLarge(context, filePath, info, device) {
  const filename = safeLocalName(filePath);
  const initResponse = await accessFetch(context, `${context.baseUrl}/api/large/init`, {
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
      const response = await accessFetch(context, `${context.baseUrl}/api/large/${encodeURIComponent(uploadId)}/chunk/${index}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(length) },
        body: buffer,
      });
      await responseJson(response, `large upload chunk ${index}`);
    }
  } catch (error) {
    await accessFetch(context, `${context.baseUrl}/api/large/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }

  const completeResponse = await accessFetch(context, `${context.baseUrl}/api/large/${encodeURIComponent(uploadId)}/complete`, { method: 'POST' });
  return responseJson(completeResponse, 'large upload complete');
}

export async function pushFile(inputPath, options = {}) {
  const filePath = resolve(String(inputPath || ''));
  if (!inputPath) throw fail('push 需要本地文件路径', 'missing_path');
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw fail(`不是可上传的普通文件：${filePath}`, 'invalid_path');

  const context = await requestContext(options);
  const device = String(options.device || process.env.SELFDROP_AGENT_DEVICE || 'Local AI').trim().slice(0, 48) || 'Local AI';
  const message = info.size <= SMALL_UPLOAD_LIMIT
    ? await pushSmall(context, filePath, info, device)
    : await pushLarge(context, filePath, info, device);
  return {
    fileId: message.sequenceId || message.id,
    messageId: message.id,
    name: message.attachment?.name || safeLocalName(filePath),
    size: Number(message.attachment?.size) || info.size,
    url: message.attachment?.url,
    large: Boolean(message.attachment?.large),
  };
}

async function probeSelfDrop(endpoint) {
  const context = await requestContext({ endpoint });
  const response = await accessFetch(context, `${context.baseUrl}/api/health`, { cache: 'no-store' });
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw fail(`目标地址不像 SelfDrop：/api/health 返回非 JSON（HTTP ${response.status}）`, 'not_selfdrop');
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body.ok !== 'boolean' || typeof body.topic !== 'string') {
    throw fail('目标地址没有返回预期的 SelfDrop health 响应', 'not_selfdrop');
  }
  if (response.status !== 200 && response.status !== 503) {
    throw fail(`SelfDrop health 检查失败（HTTP ${response.status}）`, 'health_check_failed');
  }
  return body;
}

export async function initEndpoint(input) {
  if (!input) throw fail('init 需要 SelfDrop 地址，例如 https://drop.example.com', 'missing_base_url');
  const endpoint = normalizeEndpoint(input);
  const health = await probeSelfDrop(endpoint);
  const path = await writeConfig(endpoint.baseUrl);
  return {
    baseUrl: endpoint.baseUrl,
    mode: endpoint.loopback ? 'local' : 'cloudflare-access',
    configPath: path,
    serverOk: health.ok,
  };
}

export async function showConfig() {
  const saved = await readConfig();
  const endpoint = saved.config?.endpoint ? normalizeEndpoint(saved.config.endpoint) : null;
  return {
    configPath: saved.path,
    endpoint: endpoint?.baseUrl || null,
    mode: endpoint ? (endpoint.loopback ? 'local' : 'cloudflare-access') : 'default-local',
  };
}

function usage() {
  return `SelfDrop Agent File Gateway\n\nUsage:\n  selfdrop-agent init <SelfDrop URL>\n  selfdrop-agent config\n  selfdrop-agent list [--limit N] [--base URL]\n  selfdrop-agent pull <file-id> [--dir DIR | --out FILE] [--force] [--base URL]\n  selfdrop-agent push <file> [--device NAME] [--base URL]\n\nRemote mode:\n  Run init once with the HTTPS domain protected by Cloudflare Access.\n  Remote commands use cloudflared access login/token under your user identity.\n  A remote --base / SELFDROP_BASE_URL must exactly match the saved endpoint.\n\nEnvironment:\n  SELFDROP_BASE_URL         optional endpoint override; remote values must match the saved endpoint\n  SELFDROP_AGENT_CONFIG     optional config-file override\n  SELFDROP_DOWNLOAD_DIR     optional pull destination override; otherwise platform default\n  SELFDROP_AGENT_DEVICE     defaults to Local AI\n  SELFDROP_CF_ACCESS_TOKEN  optional pre-obtained Cloudflare Access user token\n  SELFDROP_CLOUDFLARED_PATH optional cloudflared executable path\n\nTransfer capabilities remain list, pull, and push. No delete capability is exposed.`;
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
  if (command === 'init') result = await initEndpoint(positional[0]);
  else if (command === 'config') result = await showConfig();
  else if (command === 'list') result = await listFiles(options);
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
