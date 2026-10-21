# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 21.10.2026 (latest) | yes |
| older date releases | fixes land in the next dated release |

Releases are date based: the git tag and release name are the release date
itself (for example `21.10.2026`), not semver.

## Reporting a vulnerability

Please report vulnerabilities privately, not as a public issue:

- Use GitHub's private vulnerability reporting (Security tab of this
  repository), or
- Contact the maintainers directly through GitHub (private mention).

Include: a description, affected paths or endpoints, reproduction steps or a
proof of concept, and your assessment of impact and severity. You will get an
acknowledgement within 72 hours and progress updates at least weekly until
resolution. We credit reporters in release notes unless they prefer
anonymity.

## In scope

- The bot and API code in `src/`, especially: tenant isolation (row level
  security and service layer), webhook verification, secret storage and
  redaction, the admin and integration HTTP surfaces, scheduler integrity.
- Deployment assets: `Dockerfile`, `docker-compose.yml`, backup scripts.

## Out of scope

- Vulnerabilities in dependencies without a demonstrated exploit path in Orbit
  itself (still appreciated, send them the same way).
- Discord platform side issues; report those to Discord directly.
- Attacks requiring access to the host, its environment file, or the database
  volume (documented deployment assumes trusted operators).

## Security posture overview

Full details live in `docs/security.md` and `docs/architecture.md`. The
short version:

- Tenant boundary is enforced twice: PostgreSQL FORCE row level security with
  a per transaction `app.guild_id` setting and the `TenantService` service
  layer.
- Stored secrets (GitHub installation tokens) are AES-256-GCM encrypted at
  rest with `APP_ENCRYPTION_KEY`.
- GitHub webhooks: HMAC sha256 signature verification, constant time
  comparison, body size cap, delivery id dedupe.
- All untrusted source text and workflow logs are redacted before logging or
  AI processing; AI is budgeted, optional and fails closed.
- `.env`-style secrets never enter logs or the Docker build context.
  Generate tokens with `openssl rand -hex 32` and the encryption key with
  `openssl rand -base64 32`.
