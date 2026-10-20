# Privacy policy

Last updated: October 2026

## What this is

This is a self hosted instance of Orbit maintained by OSSC DBIT, Bangalore.
When you use the Discord bot or the GitHub integration of this instance, the
operator of this instance processes the data described below. This document
is served publicly at `/privacy` on the instance host
(https://orbit-staging.webuildnow.in for the staging deployment).

## Data we collect

- Discord identifiers: guild (server) id, configured channel and role ids,
  user id and interaction metadata for slash commands you run.
- Configuration the server admins set: feature toggles, channel bindings,
  preference settings, and the audit trail of admin actions.
- GitHub webhook data for repositories you monitor: repository name, event
  type, commit/branch/run references and redacted summaries of CI failures.
  Tokens, secrets and personal emails are redacted before storage.
- Opportunity listings fetched from public third party APIs (public data,
  kept with source attribution).

## What we do not collect

- Message contents: the bot has no message content intent and does not
  read, log or store messages.
- Direct messages, your Discord password, or payment information.

## Where data lives

In the instance's own PostgreSQL database on the operator's host. Secrets
such as GitHub installation tokens are encrypted at rest (AES-256-GCM) with
a key kept in the operator's environment file. Application secrets never
enter logs or public repositories.

## Optional AI processing

If enabled, short redacted excerpts may be sent to the Groq API to produce
one line summaries. This is budget capped, optional and fails closed:
without AI the product remains fully functional.

## Third party services

Discord (bot platform), GitHub (webhooks and API), the public source APIs
listed in `docs/sources.md`, and optionally Groq. This project is not
affiliated with any of them.

## Retention

- Guild configuration, deliveries and audit entries are kept while the bot
  is in your server.
- When the bot leaves a server, or when monitoring is removed, rows for
  that guild are marked deleted; the nightly retention job prunes aged
  event and log rows (default window: 90 days, `RETENTION_DAYS`).
- You can request earlier deletion of your guild's data from the
  maintainers.

## Your rights

Access, correction and deletion: contact the maintainers via the project
repository or this host's contact information. If you operate your own
Orbit instance, you are the controller of that data; review this document
and adapt it to your deployment before making it public.
