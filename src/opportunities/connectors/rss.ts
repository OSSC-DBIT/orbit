import { XMLParser } from "fast-xml-parser";
import { httpFetch } from "../../core/http.js";
import type { SourceConnector } from "./base.js";
import type { ConnectorRunResult, NormalizedOpportunity } from "../../core/types/opportunity.js";import { stripHtml } from "../normalization/text.js";
import { parseIsoDate } from "../normalization/dates.js";
import { canonicalizeUrl } from "../normalization/url.js";
import { inferRemoteStatus, extractSkills } from "../normalization/text.js";

/**
 * Generic RSS / Atom feed connector.
 *
 * Each feed is a separate source ("rss:<name>"). Guild admins may add feeds
 * via the API (ownerGuildId set). Feeds are fetched read-only at bounded rate.
 * RSS 2.0 and Atom 1.0 formats are supported.
 */
export class RssConnector implements SourceConnector {
  readonly kind = "rss" as const;
  readonly categories = ["job", "internship", "hackathon"];

  constructor(
    readonly sourceId: string,
    private feedUrl: string,
    private defaultCategory: string = "job",
  ) {}

  async fetch(): Promise<ConnectorRunResult> {
    const response = await httpFetch(this.feedUrl, {
      timeoutMs: 20_000,
      retries: 2,
      // RSS feeds are cheap; but never hammer a single feed
      rateLimit: { requests: 1, windowMs: 5_000 },
    });
    if (!response.ok) {
      throw new Error(`feed ${this.feedUrl} returned HTTP ${response.status}`);
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      trimValues: true,
      cdataPropName: "__cdata",
    });
    const xml = parser.parse(response.text) as Record<string, unknown>;
    const records: NormalizedOpportunity[] = [];

    const rss = xml.rss as { channel?: { item?: unknown } } | undefined;
    const rdf = (xml["rdf:RDF"] ?? xml.RDF) as Record<string, unknown> | undefined;
    const atom = xml.feed as Record<string, unknown> | undefined;

    const rssItems = flattenList(rss?.channel?.item);
    const rdfItems = flattenList((rdf?.item as unknown) ?? flattenList(rdf?.["item"]));
    const atomEntries = flattenList(atom?.entry);
    const items: Array<Record<string, unknown>> = [...rssItems, ...rdfItems, ...atomEntries];

    for (const item of items) {
      const record = this.mapItem(item);
      if (record) records.push(record);
    }

    return { sourceId: this.sourceId, records };
  }

  private mapItem(item: Record<string, unknown>): NormalizedOpportunity | null {
    const title = stringOf(item.title);
    const link = canonicalizeUrl(
      stringOf(item.link) ??
        stringOf(extractAtomLink(item.link)) ??
        stringOf(item.guid) ??
        stringOf((item.guid as Record<string, unknown>)?.["#text"]),
    );
    if (!title || !link) return null;

    const rawDescription =
      stringOf(item.description) ??
      stringOf(item.summary) ??
      stringOf(item.content) ??
      stringOf(item["content:encoded"]) ??
      null;
    const { text: description } = stripHtml(rawDescription ?? "", 1500);
    const publishedAt =
      parseIsoDate(stringOf(item.pubDate)) ??
      parseIsoDate(stringOf(item.published)) ??
      parseIsoDate(stringOf(item.updated));
    const categories = flattenList(item.category).map((c) => stringOf(c) ?? stringOf((c as Record<string, unknown>)?.["@_term"])).filter(
      (c): c is string => !!c,
    );
    const haystack = `${title} ${description}`;
    const category = pickRssCategory(categories, haystack, this.defaultCategory);
    const skills = extractSkills(haystack);

    return {
      sourceId: this.sourceId,
      externalId: link,
      title: title.slice(0, 290),
      organization: stringOf(item["dc:creator"]) ?? stringOf(item.author) ?? null,
      category,
      description,
      descriptionHtml: null,
      applicationUrl: link,
      sourceUrl: link,
      location: stringOf(item["dc:coverage"]) ?? null,
      remoteStatus: inferRemoteStatus(haystack, stringOf(item["dc:coverage"]) ?? null) ?? null,
      requiredSkills: skills,
      eligibility: null,
      compensation: null,
      opensAt: null,
      applicationDeadline: null,
      eventStartsAt: null,
      eventEndsAt: null,
      sourcePublishedAt: publishedAt,
      sourceUpdatedAt: publishedAt,
      metadata: { feed: this.feedUrl },
      tags: [...categories.slice(0, 8).map((c) => c.toLowerCase()), ...skills.slice(0, 4)],
    };
  }
}

function stringOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as Record<string, unknown>)["#text"] === "string") {
    return (v as Record<string, unknown>)["#text"] as string;
  }
  return null;
}

function extractAtomLink(link: unknown): unknown {
  const first = flattenList(link)[0];
  if (first && typeof first === "object") {
    const href = (first as Record<string, unknown>)["@_href"];
    if (typeof href === "string") return href;
  }
  return null;
}

function flattenList(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.filter((v): v is Record<string, unknown> => v !== null && typeof v === "object");
}

function pickRssCategory(categories: string[], haystack: string, fallback: string): NormalizedOpportunity["category"] {
  const lower = `${categories.join(" ")} ${haystack}`.toLowerCase();
  if (/hackathon|buildathon|code sprint/.test(lower)) return "hackathon";
  if (/internship|intern/.test(lower)) return "internship";
  if (/fellowship|grant|stipend|bursary/.test(lower)) return "grant_fellowship";
  if (/open ?source|gsoc|gso[c]?\b|outreachy/.test(lower)) return "opensource_program";
  if (/scholar|student program|student program/.test(lower)) return "student_program";
  if (/research|phd position|ra |research fellow/.test(lower)) return "research";
  type Category = NormalizedOpportunity["category"];
  const known: Category[] = ["hackathon", "internship", "job", "remote_job", "grant_fellowship", "opensource_program", "student_program", "research", "innovation_challenge"];
  return known.includes(fallback as Category) ? (fallback as Category) : "job";
}
