# SelfDrop

[简体中文](README.zh-CN.md) · English

SelfDrop is a lightweight, self-hosted file and message drop for devices that do not always share the same operating system, network, or proxy environment.

It is built around a simple problem: moving a temporary file between Windows, Linux, Android, and iOS should not require a full cloud drive, a heavyweight collaboration suite, or two devices being on the same LAN. SelfDrop uses **ntfy as the message/event backend**, then adds a compact chat-style interface and a file-transfer layer focused on personal cross-device handoff.

## What it is for

SelfDrop works well when you want one small private endpoint that all of your devices can reach:

- send text, images, audio, video, and files from a browser;
- move files between devices on different networks;
- keep a chat-like timeline instead of a paste-bin or forum-style topic view;
- upload multiple files from desktop and mobile;
- handle larger files with chunked uploads and Range downloads;
- see upload progress, transfer speed, stop an upload, and wait for server confirmation;
- preview images in the timeline and browse transferred files separately;
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
- Multi-file selection on desktop and mobile
- Image previews
- File library view
- Chunked large-file uploads (application limit: 4 GiB)
- HTTP Range downloads
- Upload progress and speed
- Stop/cancel upload
- Server-confirmed completion state
- SSE real-time updates
- Follow-latest scrolling that does not interrupt history reading
- iOS/WebKit upload compatibility handling
- English / Simplified Chinese UI
- Light / dark appearance
- Server-side history/file cleanup controls
- Local Agent File Gateway with `list`, `pull`, and `push` for same-machine AI tools
- No frontend framework and no application runtime dependencies beyond Node.js

## Security model

SelfDrop does **not** bundle an Internet-facing account system. Do not expose it openly to the Internet.

Put it behind an authentication boundary you already trust, for example:

- Cloudflare Access;
- an authenticated reverse proxy;
- a private VPN / overlay network;
- another identity-aware gateway.

The bundled Docker Compose keeps ntfy internal to the Compose network and exposes only SelfDrop on loopback by default.

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

If no ntfy credentials are configured, SelfDrop talks to ntfy without an Authorization header. This is useful when ntfy is private on localhost or an internal container network.

## Local Agent File Gateway

SelfDrop also includes a small CLI for local AI tools such as coding agents that need file access without operating the browser UI. It reuses the same SelfDrop file objects and upload/download HTTP paths; it is not a second transfer service.

```bash
# discover files already uploaded to SelfDrop
npm run agent -- list

# download one file by the fileId returned above
npm run agent -- pull <file-id>

# upload one generated or modified local file
npm run agent -- push <local-file>
```

Phase 1 is intentionally local-machine only: the CLI accepts loopback SelfDrop endpoints (`127.0.0.1`, `localhost`, or `::1`) and exposes no delete operation. `pull` defaults to `~/.local/share/selfdrop-agent/downloads` and refuses to overwrite an existing file unless `--force` is explicit.

Configuration and the machine-readable capability contract are documented in [`agent-interface/README.md`](agent-interface/README.md) and [`agent-interface/capabilities.json`](agent-interface/capabilities.json).

## Data and cleanup

SelfDrop stores large/chunked file copies in its own data directory and uses ntfy for the message timeline and smaller attachments. The cleanup controls delete **server-side SelfDrop copies and timeline records only**. They cannot delete the source photo/video/file from the phone or computer that uploaded it.

For a public deployment, back up data before changing retention or using bulk cleanup.

## Browser notes

The UI is browser-first, so no per-device SelfDrop client is required. Modern Chromium, Safari/WebKit, and mobile browsers are supported. iOS uses a compatibility path that materializes picker-backed files before network upload and serializes file/chunk transfer to avoid known WebKit file-upload failure modes.

## Development

```bash
npm run check
```

The project deliberately keeps the frontend dependency-free. `public/app.js`, `public/styles.css`, and `public/index.html` are the main UI files; `server.mjs` provides the HTTP API, ntfy bridge, large-file storage, cleanup, and SSE endpoints; `selfdrop-agent.mjs` is the local `list` / `pull` / `push` client for AI tools and automation.

## Upstream

SelfDrop depends on [ntfy](https://github.com/binwiederhier/ntfy) as its message/event backend. SelfDrop is a separate project and does not redistribute ntfy source code in this repository.

## License

SelfDrop is released under the MIT License. See [LICENSE](LICENSE).
