# SelfDrop

[简体中文](README.zh-CN.md) · English

SelfDrop is a lightweight, self-hosted file and message drop for devices that do not always share the same operating system, network, or proxy environment.

It is built around a simple problem: moving a temporary file between Windows, Linux, Android, and iOS should not require a full cloud drive, a heavyweight collaboration suite, or two devices being on the same LAN. SelfDrop uses **ntfy as the message/event backend**, then adds a compact chat-style interface and a file-transfer layer focused on personal cross-device handoff.

## What it is for

SelfDrop works well when you want one small private endpoint that all of your devices can reach:

- send text, images, audio, video, and files from a browser;
- move files between devices on different networks;
- keep a chat-like timeline instead of a paste-bin or forum-style topic view;
- upload multiple files from desktop and mobile, append new files to an active queue, and control files individually;
- handle larger files with resumable chunked uploads and Range downloads;
- keep per-file progress visible, pause/resume/cancel tasks, retry failures from confirmed chunks, and wait for server confirmation;
- recover cached media uploads after reopening supported browsers and use Chromium Background Fetch when available;
- verify large upload chunks with SHA-256 and make finalization idempotent;
- preview images and videos in the timeline and browse transferred files separately;
- use the same web UI on Windows, Linux, Android, and iOS;
- clean SelfDrop's server-side copies without touching the original files on your devices.

SelfDrop is not a replacement for a synchronized cloud drive, a team messenger, or a long-term document archive. It is intentionally small: a private transfer surface for temporary handoff.

## Why ntfy

ntfy already provides a compact, proven HTTP event stream with history and real-time delivery. SelfDrop keeps that part and narrows the product around cross-device transfer:

```text
Browser / PWA
    │
    ▼
SelfDrop web + file layer
    │
    ├── chunked file storage / Range downloads
    │
    └── ntfy topic → timeline + real-time events
```

The result is much lighter than deploying a complete chat platform while still working asynchronously across different networks.

## Features

- Chat-style single transfer timeline
- Text and file messages
- Multi-file selection on desktop and mobile with appendable upload queue
- Per-file progress, pause/resume, cancel, and retry controls
- Image and video previews
- File library view
- Resumable chunked large-file uploads (application limit: 4 GiB)
- Browser-native recoverable media staging with OPFS where supported
- Chromium Background Fetch progressive enhancement where supported
- SHA-256 verification for large-file chunks
- Idempotent chunk acceptance and finalization
- HTTP Range downloads
- Server-confirmed completion state
- SSE real-time updates
- Follow-latest scrolling that does not interrupt history reading
- iOS/WebKit upload compatibility handling
- English / Simplified Chinese UI
- Light / dark appearance
- Server-side history/file cleanup controls
- Agent File Gateway with `list`, `pull`, and `push` for local AI tools, including remote SelfDrop servers behind Cloudflare Access
- No frontend framework and no application runtime dependencies beyond Node.js

## Security model

SelfDrop does **not** bundle an Internet-facing account system. Do not expose it openly to the Internet.

Put it behind an authentication boundary you already trust, for example:

- Cloudflare Access;
- an authenticated reverse proxy;
- a private VPN / overlay network;
- another identity-aware gateway.

The bundled Docker Compose keeps ntfy internal to the Compose network and exposes only SelfDrop on loopback by default.

When the public hostname is protected by Cloudflare Access, set `SELFDROP_ACCESS_LOGOUT_URL=/cdn-cgi/access/logout`. The web UI will then expose an **Exit this browser** control. This clears the current browser's Access session; a later visit must authenticate again according to your Access policy (for example, email One-Time PIN). Leave the variable empty when another authentication gateway is used.

In this context, **browser** means the current browser profile / cookie jar, not the entire physical device. Cloudflare Access stores authorization in browser cookies, while Chrome/Chromium profiles keep browsing data separated. Therefore, logging out from one Chrome profile invalidates the Access session used by tabs in that profile, but does not log out a different Chrome profile, another browser such as Edge or Firefox, a separate guest/incognito cookie jar, or another device. `cloudflared` CLI credentials are stored separately from browser cookies; however, an Access logout also revokes previously issued Access tokens, so a CLI token from that session may require authorization again after revocation propagates.

## Quick start with Docker Compose

Requirements: Docker with Compose support.

```bash
git clone https://github.com/PhSanqi/SelfDrop.git
cd SelfDrop
cp .env.example .env
docker compose up -d --build
```

SelfDrop listens on `127.0.0.1:2585` by default. Put your authenticated reverse proxy or private tunnel in front of that address.

To bind it differently, edit `.env`:

```dotenv
SELFDROP_BIND=127.0.0.1
SELFDROP_PORT=2585
NTFY_TOPIC=selfdrop
```

The Compose setup stores ntfy state and SelfDrop large-file data in Docker volumes. ntfy itself is not published to the host.

## Native run

Requirements:

- Node.js 22 or newer (`node:sqlite` is used by the cleanup view)
- an ntfy server reachable over HTTP

```bash
npm run check
npm start
```

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DROP_CHAT_HOST` | `127.0.0.1` | SelfDrop listen address |
| `DROP_CHAT_PORT` | `2585` | SelfDrop listen port |
| `NTFY_BASE_URL` | `http://127.0.0.1:2586` | ntfy HTTP endpoint |
| `NTFY_TOPIC` | `inbox` | ntfy topic used by SelfDrop |
| `NTFY_USERNAME` | unset | optional ntfy Basic Auth user |
| `NTFY_PASSWORD` | unset | optional ntfy Basic Auth password |
| `NTFY_CREDENTIALS` | `~/.config/ntfy/owner-credentials.txt` | optional `username=...` / `password=...` credential file |
| `DROP_CHAT_DATA_DIR` | `~/.local/share/drop-chat` | large-file and upload state |
| `NTFY_CACHE_FILE` | `~/.local/share/ntfy/cache.db` | ntfy cache DB used by cleanup controls |
| `NTFY_ATTACHMENT_DIR` | `~/.local/share/ntfy/attachments` | ntfy attachment directory used by cleanup controls |
| `SELFDROP_ACCESS_LOGOUT_URL` | unset | optional external-auth logout URL; use `/cdn-cgi/access/logout` with Cloudflare Access |

If no ntfy credentials are configured, SelfDrop talks to ntfy without an Authorization header. This is useful when ntfy is private on localhost or an internal container network.

## Agent File Gateway

SelfDrop also includes a small CLI for local AI tools such as coding agents that need file access without operating the browser UI. The SelfDrop server can remain on one machine while Windows/Linux client machines use the same remote files through the protected SelfDrop domain. The CLI reuses the same SelfDrop file objects and upload/download HTTP paths; it is not a second transfer service.

For a remote SelfDrop protected by Cloudflare Access, install `cloudflared` on the client machine and bind the domain once. Windows can use a user-local `%LOCALAPPDATA%\SelfDrop\bin\cloudflared.exe` without changing the system `PATH`.

```bash
npm run agent -- init https://drop.example.com
npm run agent -- config
```

If there is no current Access session, `cloudflared` opens the normal browser login flow. With a One-Time PIN Access policy, the CLI therefore uses the same email OTP identity as the web page. SelfDrop stores the bound endpoint, not the OTP.

The browser authorization step is only a bridge that returns an Access token to `cloudflared`; the CLI does not reuse or copy the browser cookie itself. Once the CLI token is valid, normal `list`, `pull`, and `push` commands do not need to reopen the browser until the Access token expires or is revoked.

```bash
# discover files already uploaded to SelfDrop
npm run agent -- list

# download one file by the fileId returned above
npm run agent -- pull <file-id>

# upload one generated or modified local file
npm run agent -- push <local-file>
```

Loopback endpoints can still be used directly. Remote endpoints must use HTTPS and must first be bound with `init`; later remote `--base` / `SELFDROP_BASE_URL` values are refused unless they match that exact saved endpoint. The CLI exposes no delete operation. `pull` refuses to overwrite an existing file unless `--force` is explicit.

Windows and Linux use the same commands. The default endpoint config is `%LOCALAPPDATA%\SelfDrop\agent.json` on Windows and `$XDG_CONFIG_HOME/selfdrop/agent.json` (or `~/.config/selfdrop/agent.json`) on Linux. Default pull destinations are `%LOCALAPPDATA%\SelfDrop\downloads` on Windows and `~/.local/share/selfdrop-agent/downloads` on Linux.

Configuration and the machine-readable capability contract are documented in [`agent-interface/README.md`](agent-interface/README.md) and [`agent-interface/capabilities.json`](agent-interface/capabilities.json).

## Data and cleanup

SelfDrop stores large/chunked file copies in its own data directory and uses ntfy for the message timeline and smaller attachments. The cleanup controls delete **server-side SelfDrop copies and timeline records only**. They cannot delete the source photo/video/file from the phone or computer that uploaded it.

For a public deployment, back up data before changing retention or using bulk cleanup.

## Browser notes

The UI is browser-first, so no per-device SelfDrop client is required. Modern Chromium, Safari/WebKit, and mobile browsers are supported. Uploads use one resumable chunk protocol across browsers. Chromium can progressively hand eligible transfers to Background Fetch; browsers with Origin Private File System support can stage media temporarily so reopening the page can continue an interrupted upload without starting from byte zero. iOS/WebKit still cannot guarantee indefinite network execution after the browser is fully closed, so SelfDrop treats reopen-and-resume as the reliable fallback rather than pretending background execution is guaranteed. Screen Wake Lock and a leave-page warning are used when the active transfer still depends on the page lifecycle.

## Development

```bash
npm run check
```

The project deliberately keeps the frontend dependency-free. `public/app.js`, `public/styles.css`, and `public/index.html` are the main UI files; `server.mjs` provides the HTTP API, ntfy bridge, large-file storage, cleanup, and SSE endpoints; `selfdrop-agent.mjs` is the `list` / `pull` / `push` client for local AI tools and automation, including clients that authenticate to a remote SelfDrop through Cloudflare Access.

## Upstream

SelfDrop depends on [ntfy](https://github.com/binwiederhier/ntfy) as its message/event backend. SelfDrop is a separate project and does not redistribute ntfy source code in this repository.

## License

SelfDrop is released under the MIT License. See [LICENSE](LICENSE).
