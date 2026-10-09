# SelfDrop

简体中文 · [English](README.md)

SelfDrop 是一个轻量、自托管的跨设备文件与消息传输工具，面向“不在同一系统、不在同一网络、甚至代理环境也不同”的设备之间做临时内容交接。

它解决的问题很直接：Windows、Linux、Android、iOS 各有各的优势，但只是临时把一个文件从 A 设备拿到 B 设备，不应该被迫使用完整云盘、重型协作平台，也不应该要求两台设备必须处在同一个局域网。SelfDrop 以 **ntfy 作为消息 / 事件内核**，在上面增加了更接近聊天群的时间线界面和专门面向文件互传的传输层。

## 适合什么场景

如果你希望所有设备都有一个很小、长期可访问的私人中转站，SelfDrop 比较适合：

- 浏览器直接发送文字、图片、音频、视频和普通文件；
- 不同网络环境之间互传文件；
- 用聊天时间线查看内容，而不是论坛式 topic 或 paste 页面；
- 电脑和手机一次选择多个文件；
- 通过分块上传与 Range 下载传输较大的文件；
- 显示上传进度、实时速度，并支持停止上传；
- 文件真正被服务器确认后才显示完成；
- 图片直接在聊天记录中预览，并提供独立文件视图；
- Windows、Linux、Android、iOS 共用同一套 Web UI；
- 清理 SelfDrop 在服务器上的旧副本，而不会动手机或电脑上的原始文件。

SelfDrop 不打算替代同步云盘、团队 IM 或长期文档库。它刻意保持较小：核心用途就是私人、临时、跨设备的内容交接。

## 为什么使用 ntfy

ntfy 已经提供了轻量、成熟的 HTTP 消息流、历史记录和实时事件能力。SelfDrop 保留这一部分，把使用体验进一步裁剪到跨设备传输：

```text
浏览器 / PWA
    │
    ▼
SelfDrop Web + 文件传输层
    │
    ├── 分块文件存储 / Range 下载
    │
    └── ntfy topic → 时间线 + 实时事件
```

这样不需要部署完整聊天平台，也能让不同网络下的设备异步完成传输。

## 主要功能

- 聊天式单会话时间线
- 文字与文件消息
- 桌面端 / 手机端多文件选择
- 图片预览
- 独立文件视图
- 大文件分块上传（应用层上限 4 GiB）
- HTTP Range 下载
- 上传进度和速度
- 停止 / 取消上传
- 服务器确认后再显示完成
- SSE 实时消息
- “跟随最新”滚动，同时不打断向上查看历史
- iOS / WebKit 上传兼容处理
- 中文 / 英文界面
- 明暗外观
- 服务器侧旧历史 / 文件副本清理
- 前端无框架，应用运行时只依赖 Node.js

## 安全边界

SelfDrop **不内置面向公网的账号系统**，不要把它裸露在互联网上。

建议把它放在你已经信任的认证边界之后，例如：

- Cloudflare Access；
- 带认证的反向代理；
- 私有 VPN / Overlay Network；
- 其他 Identity-aware Gateway。

仓库提供的 Docker Compose 默认只在本机 loopback 暴露 SelfDrop，ntfy 只存在于 Compose 内部网络中。

## Docker Compose 快速运行

需要 Docker 与 Compose。

```bash
git clone https://github.com/PhSanqi/SelfDrop.git
cd SelfDrop
cp .env.example .env
docker compose up -d --build
```

默认访问地址为 `127.0.0.1:2585`。再把你自己的认证反向代理或私人 Tunnel 指向这里即可。

`.env` 可以调整：

```dotenv
SELFDROP_BIND=127.0.0.1
SELFDROP_PORT=2585
NTFY_TOPIC=selfdrop
```

Compose 会分别保存 ntfy 状态与 SelfDrop 大文件数据；ntfy 默认不映射到宿主机公网端口。

## 原生运行

要求：

- Node.js 22 或更高版本（清理页面使用 `node:sqlite`）
- 一个可通过 HTTP 访问的 ntfy server

```bash
npm run check
npm start
```

常用环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DROP_CHAT_HOST` | `127.0.0.1` | SelfDrop 监听地址 |
| `DROP_CHAT_PORT` | `2585` | SelfDrop 监听端口 |
| `NTFY_BASE_URL` | `http://127.0.0.1:2586` | ntfy HTTP 地址 |
| `NTFY_TOPIC` | `inbox` | SelfDrop 使用的 ntfy topic |
| `NTFY_USERNAME` | 未设置 | 可选 ntfy Basic Auth 用户名 |
| `NTFY_PASSWORD` | 未设置 | 可选 ntfy Basic Auth 密码 |
| `NTFY_CREDENTIALS` | `~/.config/ntfy/owner-credentials.txt` | 可选 `username=...` / `password=...` 凭据文件 |
| `DROP_CHAT_DATA_DIR` | `~/.local/share/drop-chat` | 大文件与上传状态目录 |
| `NTFY_CACHE_FILE` | `~/.local/share/ntfy/cache.db` | 清理功能读取的 ntfy cache DB |
| `NTFY_ATTACHMENT_DIR` | `~/.local/share/ntfy/attachments` | 清理功能读取的 ntfy 附件目录 |

如果没有配置 ntfy 凭据，SelfDrop 不发送 Authorization header。这适合 ntfy 只运行在 localhost 或容器内部网络的部署方式。

## 数据与清理

较大的分块文件副本由 SelfDrop 自己保存，消息时间线和普通附件由 ntfy 负责。清理按钮删除的是 **服务器上的 SelfDrop 副本与对应历史记录**，不会也无法删除最初从 iPhone、Android、Windows 或 Linux 上传的原始文件。

正式部署中，调整保留时间或批量清理前仍建议先备份。

## 浏览器说明

SelfDrop 是 browser-first 的，因此每台设备都不要求额外安装专用客户端。支持现代 Chromium、Safari/WebKit 及移动浏览器。针对 iOS，上传路径会先 materialize 系统 picker 返回的文件，再串行发送文件 / chunk，以规避 WebKit 对 picker-backed file 的已知上传异常。

## 开发

```bash
npm run check
```

前端刻意不引入框架。主要界面文件是 `public/app.js`、`public/styles.css`、`public/index.html`；`server.mjs` 提供 HTTP API、ntfy bridge、大文件存储、清理与 SSE。

## 上游

SelfDrop 使用 [ntfy](https://github.com/binwiederhier/ntfy) 作为消息 / 事件后端。本仓库是独立项目，并不直接重新分发 ntfy 的源代码。

## 许可证

SelfDrop 使用 MIT License，见 [LICENSE](LICENSE)。
