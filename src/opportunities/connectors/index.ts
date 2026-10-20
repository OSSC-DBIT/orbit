import type { SourceConnector } from "./base.js";
import { DevpostConnector } from "./devpost.js";
import { RemotiveConnector } from "./remotive.js";
import { HnHiringConnector } from "./hn-hiring.js";
import { HackathonApiConnector } from "./hackathon-api.js";
import { HackCultureConnector } from "./hackculture.js";
import { JobSpyConnector } from "./jobspy.js";
import { RssConnector } from "./rss.js";

/**
 * Connector registry: instantiates a connector for a `sourceId` using the DB
 * source `config`. Guild-private RSS feeds pass their feed url + category.
 */
export function createConnector(
  sourceId: string,
  kind: string,
  config: Record<string, unknown>,
): SourceConnector | null {
  switch (sourceId) {
    case "devpost":
      return new DevpostConnector();
    case "jobspy":
      return new JobSpyConnector();
    case "remotive":
      return new RemotiveConnector();
    case "hn-hiring":
      return new HnHiringConnector();
    case "hackathon-api":
      return new HackathonApiConnector({
        baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
      });
    case "hackculture":
      return new HackCultureConnector({
        baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
      });
    default:
      if (kind === "rss" || sourceId.startsWith("rss:")) {
        const feedUrl = config.feedUrl ?? config.url ?? config.feed;
        if (typeof feedUrl !== "string" || !feedUrl) return null;
        const category = typeof config.category === "string" ? config.category : undefined;
        return new RssConnector(sourceId, feedUrl, category);
      }
      return null;
  }
}

export { DevpostConnector, RemotiveConnector, HnHiringConnector, HackathonApiConnector, HackCultureConnector, JobSpyConnector, RssConnector };
export type { SourceConnector };
