# Changelog

## Unreleased

- Agent File Gateway can bind one remote HTTPS SelfDrop endpoint protected by Cloudflare Access
- interactive `cloudflared` user authentication for Windows/Linux Agent clients without a local SelfDrop server
- remote endpoint binding rejects accidental access to a different SelfDrop origin
- optional Cloudflare Access “Exit this browser” control in the web UI

## 0.1.0 - 2026-10-10

Initial public release.

- ntfy-backed chat-style transfer timeline
- browser-first desktop and mobile interface
- text, image, video, audio, and generic file transfer
- multi-file selection
- chunked large-file upload and HTTP Range download
- upload progress, speed, cancellation, and server-confirmed completion
- SSE real-time updates and follow-latest scrolling
- iOS/WebKit upload compatibility path
- image previews and file library
- server-side history/file cleanup
- English / Simplified Chinese UI
- Docker Compose example and native Node.js deployment documentation
