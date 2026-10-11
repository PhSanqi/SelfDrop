# SelfDrop

简体中文 · [English](README.md)

SelfDrop 是一个轻量、自托管的跨设备文件与消息传输工具，面向“不在同一系统、不在同一网络、甚至代理环境也不同”的设备之间做临时内容交接。

它解决的问题很直接：Windows、Linux、Android、iOS 各有各的优势，但只是临时把一个文件从 A 设备拿到 B 设备，不应该被迫使用完整云盘、重型协作平台，也不应该要求两台设备必须处在同一个局域网。SelfDrop 以 **ntfy 作为消息 / 事件内核**，在上面增加了更接近聊天群的时间线界面和专门面向文件互传的传输层。

## 适合什么场景

如果你希望所有设备都有一个很小、长期可访问的私人中转站，SelfDrop 比较适合：

- 浏览器直接发送文字、图片、音频、视频和普通文件；
- 不同网络环境之间互传文件；
- 用聊天时间线查看内容，而不是论坛式 topic 或 paste 页面；
- 电脑和手机一次选择多个文件，并可在已有传输过程中继续追加到队列；
- 通过可断点恢复的分块上传与 Range 下载传输较大的文件；
- 每个文件独立显示进度，并支持暂停 / 继续 / 取消；失败后可从服务器已确认的分块继续重试；
- 支持的浏览器可用 OPFS 临时缓存媒体，重新打开页面后自动续传；Chromium 可在可用时渐进增强到 Background Fetch；
- 大文件分块使用 SHA-256 校验，分块接收与最终合并均按幂等方式处理；
- 文件真正被服务器确认后才显示完成；
- 图片和视频可直接在聊天记录中预览，并提供独立文件视图；
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
- 桌面端 / 手机端多文件选择与可追加上传队列
- 每个文件独立进度、暂停 / 继续、取消与失败重试
- 图片和视频预览
- 独立文件视图
- 可断点恢复的大文件分块上传（应用层上限 4 GiB）
- 支持时使用 OPFS 做浏览器本地可恢复媒体暂存
- Chromium 支持时使用 Background Fetch 渐进增强
- 大文件分块 SHA-256 完整性校验
- 分块接收与最终合并幂等化
- HTTP Range 下载
- 服务器确认后再显示完成
- SSE 实时消息
- “跟随最新”滚动，同时不打断向上查看历史
- iOS / WebKit 上传兼容处理
- 中文 / 英文界面
- 明暗外观
- 服务器侧旧历史 / 文件副本清理
- 面向本机 AI 工具的 Agent File Gateway：`list`、`pull`、`push`，可访问由 Cloudflare Access 保护的远程 SelfDrop
- 前端无框架，应用运行时只依赖 Node.js

## 安全边界

SelfDrop **不内置面向公网的账号系统**，不要把它裸露在互联网上。

建议把它放在你已经信任的认证边界之后，例如：

- Cloudflare Access；
- 带认证的反向代理；
- 私有 VPN / Overlay Network；
- 其他 Identity-aware Gateway。

仓库提供的 Docker Compose 默认只在本机 loopback 暴露 SelfDrop，ntfy 只存在于 Compose 内部网络中。

当公网域名由 Cloudflare Access 保护时，设置 `SELFDROP_ACCESS_LOGOUT_URL=/cdn-cgi/access/logout`，Web UI 就会提供 **退出此浏览器** 操作。点击后清除当前浏览器的 Access 会话；之后再次访问时，需要按照你的 Access Policy 重新认证，例如重新完成邮箱 One-Time PIN。若使用其他认证网关，则保持该变量为空。

这里的“浏览器”准确指 **当前 browser profile / cookie jar**，而不是整台物理设备。Cloudflare Access 的网页授权保存在浏览器 cookie 中，而 Chrome / Chromium 的不同 Profile 会隔离浏览数据。因此，在某个 Chrome Profile 中退出，会让该 Profile 内的标签页失去这次 Access 会话；但不会让另一个 Chrome Profile、Edge / Firefox 等其他浏览器、独立的 Guest / Incognito cookie jar 或另一台设备一起退出。`cloudflared` CLI 凭据不保存在浏览器 cookie 中，但 Access logout 会撤销此前签发的 Access token，因此同一次 Access 会话产生的 CLI token 在撤销传播后也可能需要重新授权。

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
| `SELFDROP_ACCESS_LOGOUT_URL` | 未设置 | 可选的外部认证退出地址；使用 Cloudflare Access 时可设为 `/cdn-cgi/access/logout` |

如果没有配置 ntfy 凭据，SelfDrop 不发送 Authorization header。这适合 ntfy 只运行在 localhost 或容器内部网络的部署方式。

## Agent File Gateway

SelfDrop 同时提供一个很小的本地 CLI，供编码 Agent 等本机 AI 工具直接发现、拉取和回传文件，不需要操作浏览器 UI。SelfDrop Server 可以始终只部署在一台服务器上，而 Windows / Linux 客户端通过受保护的 SelfDrop 域名访问同一批文件。CLI 复用现有 SelfDrop 文件对象和上传 / 下载 HTTP 链路，不建立第二套传输服务或存储。

远程 SelfDrop 如果由 Cloudflare Access 保护，先在客户端安装 `cloudflared`，然后只绑定一次 HTTPS 域名。Windows 也可以直接把 `cloudflared.exe` 放到 `%LOCALAPPDATA%\SelfDrop\bin\`，无需管理员安装或修改系统 `PATH`。

```bash
npm run agent -- init https://drop.example.com
npm run agent -- config
```

如果当前没有有效的 Access session，`cloudflared` 会打开正常的浏览器认证流程。若 Access Policy 使用邮箱 One-Time PIN，CLI 就会复用和网页一致的邮箱 OTP 身份验证；SelfDrop 只保存绑定域名，不保存 OTP。

这个浏览器步骤只负责把 Access token 安全交给 `cloudflared`，CLI 不会复制或复用浏览器 cookie。本机 CLI token 有效期间，正常执行 `list`、`pull`、`push` 不会反复打开浏览器；只有 token 到期或被撤销后才需要重新授权。

```bash
# 查看已经上传到 SelfDrop 的文件
npm run agent -- list

# 使用上一步返回的 fileId 拉取一个文件
npm run agent -- pull <file-id>

# 上传 AI 生成或修改后的一个本地文件
npm run agent -- push <local-file>
```

loopback 地址仍然可以直接使用。远程地址必须使用 HTTPS，并且必须先通过 `init` 绑定；之后如果显式传入远程 `--base` 或 `SELFDROP_BASE_URL`，只有与已保存地址完全一致才会接受。CLI 不提供删除能力；除非显式使用 `--force`，否则 `pull` 不会覆盖已有本地文件。

Windows 和 Linux 使用同一套命令。默认配置路径：Windows 为 `%LOCALAPPDATA%\SelfDrop\agent.json`；Linux 为 `$XDG_CONFIG_HOME/selfdrop/agent.json`，未设置 XDG 时为 `~/.config/selfdrop/agent.json`。默认下载目录：Windows 为 `%LOCALAPPDATA%\SelfDrop\downloads`，Linux 为 `~/.local/share/selfdrop-agent/downloads`。

完整配置和机器可读能力契约见 [`agent-interface/README.md`](agent-interface/README.md) 与 [`agent-interface/capabilities.json`](agent-interface/capabilities.json)。

## 数据与清理

较大的分块文件副本由 SelfDrop 自己保存，消息时间线和普通附件由 ntfy 负责。清理按钮删除的是 **服务器上的 SelfDrop 副本与对应历史记录**，不会也无法删除最初从 iPhone、Android、Windows 或 Linux 上传的原始文件。

正式部署中，调整保留时间或批量清理前仍建议先备份。

## 浏览器说明

SelfDrop 是 browser-first 的，因此每台设备都不要求额外安装专用客户端。现代 Chromium、Safari/WebKit 与移动浏览器复用同一套可断点恢复的分块协议。Chromium 在支持时可把合适的任务交给 Background Fetch；支持 Origin Private File System 的浏览器可先把媒体临时暂存到浏览器私有存储，页面重新打开后从已确认分块继续，而不是从零开始。iOS / WebKit 在浏览器被完全关闭后仍无法保证网络任务无限期继续，因此 SelfDrop 把“重新打开后自动恢复”作为可靠降级，而不是宣称浏览器后台一定持续运行。仍依赖当前页面生命周期的上传会尽可能申请 Screen Wake Lock，并在离开页面前给出提醒。

## 开发

```bash
npm run check
```

前端刻意不引入框架。主要界面文件是 `public/app.js`、`public/styles.css`、`public/index.html`；`server.mjs` 提供 HTTP API、ntfy bridge、大文件存储、清理与 SSE；`selfdrop-agent.mjs` 是给本机 AI 工具与自动化使用的 `list` / `pull` / `push` 客户端，也可通过 Cloudflare Access 访问远程 SelfDrop。

## 上游

SelfDrop 使用 [ntfy](https://github.com/binwiederhier/ntfy) 作为消息 / 事件后端。本仓库是独立项目，并不直接重新分发 ntfy 的源代码。

## 许可证

SelfDrop 使用 MIT License，见 [LICENSE](LICENSE)。
