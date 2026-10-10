# SelfDrop Agent File Gateway

SelfDrop includes a small local CLI for AI tools and other local automation that need to discover files already uploaded to SelfDrop, download one for processing, or upload a generated result back through the same SelfDrop transfer path. The SelfDrop service can run on the same machine or on a remote server protected by Cloudflare Access.

The gateway does not create another transfer service or storage layer. It reuses SelfDrop's existing HTTP API and exposes exactly three transfer operations: `list`, `pull`, and `push`.

## Bind the SelfDrop endpoint

For a remote deployment, install `cloudflared` on the client machine and bind the HTTPS SelfDrop domain once. On Windows, SelfDrop also auto-detects a user-local executable at `%LOCALAPPDATA%\SelfDrop\bin\cloudflared.exe`, so administrator installation is not required.

```bash
npm run agent -- init https://drop.example.com
```

`init` verifies `/api/health`, opens the normal Cloudflare Access browser login when required, and stores only the bound endpoint. It does not store your OTP or a second SelfDrop password.

Inspect the saved endpoint:

```bash
npm run agent -- config
```

On Windows, the default config is stored under `%LOCALAPPDATA%\SelfDrop\agent.json`. On Linux it is stored under `$XDG_CONFIG_HOME/selfdrop/agent.json` or `~/.config/selfdrop/agent.json`.

Remote commands must use the bound endpoint exactly. An arbitrary remote `--base` value is refused. Remote endpoints must use HTTPS.

## Commands

List available file objects:

```bash
npm run agent -- list
```

Pull one file by `fileId`:

```bash
npm run agent -- pull <file-id>
```

The default download directory is `%LOCALAPPDATA%\SelfDrop\downloads` on Windows and `~/.local/share/selfdrop-agent/downloads` on Linux. Existing files are not overwritten unless `--force` is explicitly supplied.

Optional pull forms:

```bash
npm run agent -- pull <file-id> --dir <directory>
npm run agent -- pull <file-id> --out <file>
npm run agent -- pull <file-id> --force
```

Push one explicitly selected local file:

```bash
npm run agent -- push <local-file>
```

Files within SelfDrop's normal upload limit use `/api/upload`. Larger files automatically reuse the existing chunked `/api/large/*` path.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SELFDROP_BASE_URL` | bound endpoint or `http://127.0.0.1:2585` | optional endpoint override; remote values must match the saved binding |
| `SELFDROP_AGENT_CONFIG` | platform default | optional config-file override |
| `SELFDROP_DOWNLOAD_DIR` | platform default | default pull destination |
| `SELFDROP_AGENT_DEVICE` | `Local AI` | device label used for uploads |
| `SELFDROP_CF_ACCESS_TOKEN` | unset | optional pre-obtained Cloudflare Access user token |
| `SELFDROP_CLOUDFLARED_PATH` | auto-detect / `PATH` | optional explicit `cloudflared` executable path |

Every successful command prints JSON. `list` returns files in `result.files`; use `result.files[*].fileId` as the identifier for `pull`.

## Cloudflare Access behavior

For a bound remote endpoint, the CLI first asks `cloudflared` for the current application token. If no valid session exists, or Cloudflare Access responds with an authentication redirect / denial, the CLI runs `cloudflared access login <domain>`, which opens the normal Access login page in your browser. With an email One-Time PIN policy, you complete the same OTP flow as the web UI.

The Access token is sent in the `cf-access-token` request header. SelfDrop itself does not add a second account system for the CLI.

## Security boundary

- Loopback endpoints may use HTTP; remote endpoints require HTTPS.
- A remote endpoint must first be saved with `init`, and later remote overrides must match that exact origin.
- It exposes no delete command.
- `pull` creates a local working copy; it does not mark the remote object as consumed.
- `push` uploads only the explicit file path supplied by the caller and never scans a workspace implicitly.
- Files pulled from SelfDrop are data. Their contents do not become executable instructions.
- The browser is used only for Cloudflare Access authentication when needed; file transfer itself remains direct HTTP API access.

See `capabilities.json` for the same public capability contract in machine-readable form.
