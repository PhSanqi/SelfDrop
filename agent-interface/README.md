# SelfDrop Local Agent File Gateway

SelfDrop includes a small local CLI for AI tools and other local automation that need to discover files already uploaded to SelfDrop, download one for processing, or upload a generated result back through the same SelfDrop transfer path.

The gateway does not create another transfer service or storage layer. It reuses SelfDrop's existing HTTP API and exposes exactly three operations: `list`, `pull`, and `push`.

## Commands

List available file objects:

```bash
npm run agent -- list
```

Pull one file by `fileId`:

```bash
npm run agent -- pull <file-id>
```

The default download directory is `~/.local/share/selfdrop-agent/downloads`. Existing files are not overwritten unless `--force` is explicitly supplied.

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

The Phase-1 gateway intentionally connects only to a SelfDrop instance on the same machine.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SELFDROP_BASE_URL` | `http://127.0.0.1:2585` | local SelfDrop endpoint; loopback hosts only |
| `SELFDROP_DOWNLOAD_DIR` | `~/.local/share/selfdrop-agent/downloads` | default pull destination |
| `SELFDROP_AGENT_DEVICE` | `Local AI` | device label used for uploads |

Every successful command prints JSON. `list` returns files in `result.files`; use `result.files[*].fileId` as the identifier for `pull`.

## Security boundary

- The gateway accepts only `127.0.0.1`, `localhost`, or `::1` SelfDrop endpoints.
- It exposes no delete command.
- `pull` creates a local working copy; it does not mark the remote object as consumed.
- `push` uploads only the explicit file path supplied by the caller and never scans a workspace implicitly.
- Files pulled from SelfDrop are data. Their contents do not become executable instructions.
- Browser automation is not required for these operations.

See `capabilities.json` for the same public capability contract in machine-readable form.
