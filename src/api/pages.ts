import type { Request, Response, Router } from "express";

/**
 * Static public pages: landing (/), privacy (/privacy) and terms (/terms).
 * These are plain HTML by design: no client side code, no analytics, no
 * external assets, so legal pages are served even on a cold or offline
 * database. The same text lives in docs/privacy.md and docs/terms.md.
 */

const PUBLIC_URL = "https://orbit-staging.webuildnow.in";
const MAINTAINER = "OSSC DBIT, Bangalore";
const CONTACT_NOTE = "Contact: maintainers via the project repository or the deployment host contact.";

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Orbit</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:0 auto;padding:24px;line-height:1.6;color:#1c2333}
  h1{font-size:1.6em;border-bottom:2px solid #4c6ef5;padding-bottom:6px}
  h2{font-size:1.15em;margin-top:1.4em}
  code{background:#f1f3f5;padding:1px 5px;border-radius:4px}
  a{color:#3b5bdb}
  footer{margin-top:2em;border-top:1px solid #dee2e6;padding-top:8px;font-size:.85em;color:#666}
  nav a{margin-right:14px}
</style>
</head>
<body>
<nav><a href="/">Home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/healthz">Health</a></nav>
<h1>${title}</h1>
${body}
<footer>Orbit is maintained by ${MAINTAINER} (${PUBLIC_URL}). ${CONTACT_NOTE}</footer>
</body>
</html>`;
}

export function homeHtml(): string {
  return shell(
    "Orbit",
    `<p>Orbit is a multi tenant Discord bot and platform that discovers, normalizes,
deduplicates and delivers developer opportunities (hackathons, internships,
jobs).</p>
<p>This instance is the <strong>staging</strong> deployment, reachable at
<code>${PUBLIC_URL}</code> through a Cloudflare tunnel.</p>
<h2>Links</h2>
<ul>
<li><a href="/privacy">Privacy policy</a></li>
<li><a href="/terms">Terms of service</a></li>
<li><a href="/healthz"><code>/healthz</code></a> and <a href="/readyz"><code>/readyz</code></a> health surfaces</li>
</ul>`,
  );
}

export function privacyHtml(): string {
  return shell(
    "Privacy policy",
    `<p>Last updated: October 2026</p>
<h2>What this is</h2>
<p>This is a self hosted instance of Orbit maintained by ${MAINTAINER}. When
you use the Discord bot of this instance, the
operator of this instance processes the data described below.</p>
<h2>Data we collect</h2>
<ul>
<li>Discord identifiers: guild (server) id, configured channel and role ids,
user id and interaction metadata for slash commands you run.</li>
<li>Configuration the server admins set (feature toggles, channels,
preferences, audit trail).</li>
<li>Opportunity listings fetched from public third party APIs (public data,
with source attribution).</li>
</ul>
<h2>What we do not collect</h2>
<ul>
<li>Message contents: the bot has no message content intent and does not
read, log or store messages.</li>
<li>Direct messages, your Discord password, or payment information.</li>
</ul>
<h2>Where data lives</h2>
<p>In the instance's own PostgreSQL database on the operator's host. Discord
access tokens live only in the operator's environment file and are never
stored in the database.</p>
<h2>Optional AI processing</h2>
<p>If enabled, short redacted excerpts may be sent to the Groq API to produce
one line summaries. This is budget capped, optional and degrades silently:
without AI the bot remains fully functional.</p>
<h2>Third party services</h2>
<p>Discord (bot platform), the public source APIs
listed in <code>docs/sources.md</code>, and optionally Groq. This project is
not affiliated with any of them.</p>
<h2>Retention</h2>
<ul>
<li>Guild configuration, deliveries and audit entries are kept while the bot
is in your server.</li>
<li>When the bot leaves a server or monitoring is removed, rows for that
guild are marked deleted; the nightly retention job prunes aged event and
log rows (default window: 90 days).</li>
<li>You can request earlier deletion of your guild's data from the
maintainers.</li>
</ul>
<h2>Your rights</h2>
<p>Access, correction and deletion: contact the maintainers via the project
repository or this host's contact. If you operate your own Orbit instance,
you are the controller of that data; review this document and adapt it to
your deployment.</p>`,
  );
}

export function termsHtml(): string {
  return shell(
    "Terms of service",
    `<p>Last updated: October 2026</p>
<h2>The service</h2>
<p>This instance is a self hosted deployment of Orbit, open source software
released under the MIT license (<code>LICENSE</code>), maintained by
${MAINTAINER}. Using the Discord bot or the integration API
of this instance means you agree to these terms.</p>
<h2>Use of the bot</h2>
<ul>
<li>You must follow Discord's Terms of Service and community rules in every
server this bot operates in.</li>
<li>Do not spam, harass, deliver misleading content, or use the bot for any
unlawful purpose.</li>
<li>Administrator capability in a Discord server determines who configures
the bot there; guard your server accordingly.</li>
</ul>
<h2>Sources</h2>
<p>The platform respects upstream APIs of public sources and their rate limits;
do not configure it to scrape or hammer third party services.</p>
<h2>Information quality</h2>
<p>Listings and deadlines come from public sources. AI assistance (optional)
may summarize but can be wrong. Always verify application deadlines and
details on the official event or employer site; Orbit is a discovery aid,
not a source of truth.</p>
<h2>Availability and warranty</h2>
<p>The service is provided on a best effort basis without any service level
agreement. Staging instances may be reset at any time. THE SOFTWARE IS
PROVIDED AS IS, WITHOUT WARRANTY OF ANY KIND.</p>
<h2>Liability</h2>
<p>To the maximum extent permitted by law, the maintainers are not liable
for direct or indirect damages including lost opportunities, missed
deadlines, or data loss caused by the service.</p>
<h2>Termination and changes</h2>
<p>Remove the bot from a server (or ask the maintainers) to stop all data
processing for that server. These terms and the privacy policy may change;
significant changes are announced on the project repository.</p>`,
  );
}

/** Registers the public HTML pages. */
export function registerStaticPages(router: Router): void {
  router.get("/", (_req: Request, res: Response) => res.type("html").send(homeHtml()));
  router.get("/privacy", (_req: Request, res: Response) => res.type("html").send(privacyHtml()));
  router.get("/terms", (_req: Request, res: Response) => res.type("html").send(termsHtml()));
}
