# SelfDrop v0.1.0

SelfDrop's first public release focuses on one job: lightweight file and message handoff between personal devices that may be on different operating systems and different networks.

The release uses ntfy for the message/event layer and adds a chat-style web interface, chunked file transfer, mobile multi-select, previews, transfer progress/speed, cancellation, server-confirmed completion, real-time updates, and server-side cleanup.

The web UI is browser-first and includes iOS/WebKit compatibility handling, so a separate SelfDrop client is not required on each device.

SelfDrop does not include public-facing authentication. Deploy it behind an authenticated reverse proxy, Cloudflare Access, a private VPN, or an equivalent access layer.
