import { describe, expect, it } from "vitest";
import {
  decodeHtmlEntities,
  stripHtml,
  truncate,
  normalizeTitle,
  similarityKey,
  extractTags,
  extractSkills,
  inferRemoteStatus,
} from "../../src/opportunities/normalization/text.js";

describe("text normalization", () => {
  it("decodes common HTML entities", () => {
    expect(decodeHtmlEntities("a &amp; b &lt;3 &quot;x&quot; &nbsp;&hellip;")).toBe('a & b <3 "x"  …');
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeHtmlEntities("5 &curarr; 6")).toBe("5 &curarr; 6");
  });

  it("strips scripts, styles and tags into plain text", () => {
    const { text } = stripHtml('<p>Hello <b>world</b></p><script>alert(1)</script><style>.c{}</style>');
    expect(text).toBe("Hello world");
    expect(text).not.toContain("alert");
  });

  it("never executes embedded HTML as data (script contents removed entirely)", () => {
    const { text } = stripHtml('<div><script>fetch("//evil.example")</script>hello</div>');
    expect(text).not.toContain("evil.example");
  });

  it("truncates with an ellipsis marker", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("short", 10)).toBe("short");
  });

  it("plain text keeps apostrophes but drops non-content punctuation", () => {
    expect(normalizeTitle("QLOO: Agentic\u2019s AI Hack!")).toBe("qloo agentic's ai hack");
  });

  it("strips year parentheses and round suffixes (including round numbers) from similarity keys", () => {
    expect(similarityKey("Hackathon (2026)", "Qloo")).toBe(similarityKey("Hackathon", "qloo"));
    expect(similarityKey("Hackathon Round 1", "Qloo")).toBe(similarityKey("Hackathon", "Qloo"));
    expect(similarityKey("Hackathon Round 1", "Qloo")).toBe("hackathon::qloo");
  });

  it("extracts up to 12 lowercase tags without stopwords (2 letter tokens excluded)", () => {
    const tags = extractTags("Big AI Hackathon", "Join the best AI and ML hackathon for students");
    expect(tags).toContain("hackathon");
    expect(tags).toContain("students");
    expect(tags).not.toContain("ai"); // 2 letter tokens below the 3 char minimum
    expect(tags).not.toContain("ml");
    expect(tags).not.toContain("the");
  });

  it("detects known skills only", () => {
    const skills = extractSkills("Built with TypeScript and PostgreSQL, some dancing involved");
    expect(skills).toContain("typescript");
    expect(skills).toContain("postgresql");
    expect(skills).not.toContain("dancing");
  });

  it("infers remote status from text or location", () => {
    expect(inferRemoteStatus("It is fully remote", null)).toBe("remote");
    expect(inferRemoteStatus("held online", null)).toBe("remote");
    expect(inferRemoteStatus("hybrid format", null)).toBe("hybrid");
    expect(inferRemoteStatus("Come build", "Bengaluru")).toBe("onsite");
    expect(inferRemoteStatus("Come build", null)).toBeNull();
  });
});
