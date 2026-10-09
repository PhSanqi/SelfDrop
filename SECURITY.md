# Security

SelfDrop is designed to run behind an authentication boundary. It does not provide an Internet-facing account or registration system by itself.

## Deployment guidance

- Bind SelfDrop to loopback or a private interface unless you have an authenticated reverse proxy or identity-aware gateway in front of it.
- Do not publish the bundled ntfy backend directly when using the default Compose layout.
- Keep ntfy credentials, reverse-proxy credentials, tunnel tokens, API keys, and local data outside the repository.
- Back up server-side data before bulk cleanup or retention changes.
- Keep Node.js, ntfy, your reverse proxy, and container runtime updated.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting / Security Advisories for this repository when available. Do not post active secrets or exploit details in a public issue.
