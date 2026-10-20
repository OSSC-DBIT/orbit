import { describe, expect, it } from "vitest";
import { canonicalizeUrl, urlSimilarityKey } from "../../src/opportunities/normalization/url.js";

describe("URL canonicalization", () => {
  it("returns null for unusable input", () => {
    expect(canonicalizeUrl(null)).toBeNull();
    expect(canonicalizeUrl("")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
  });

  it("strips tracking parameters (utm, fbclid, gclid)", () => {
    expect(canonicalizeUrl("https://example.com/hack?utm_source=x&fbclid=1&id=7")).toBe(
      "https://example.com/hack?id=7",
    );
  });

  it("lowercases the host and strips www, default ports, fragments and credentials", () => {
    expect(canonicalizeUrl("https://WWW.Example.com:443/a/?x=1#top")).toBe("https://example.com/a?x=1");
    expect(canonicalizeUrl("https://user:pass@example.com/a")).toBe("https://example.com/a");
  });

  it("keeps non-default ports and non-tracking query params", () => {
    expect(canonicalizeUrl("http://example.com:8080/p?a=2")).toBe("http://example.com:8080/p?a=2");
  });

  it("sorts remaining query params for stable comparison", () => {
    expect(canonicalizeUrl("https://example.com/p?b=2&a=1")).toBe(canonicalizeUrl("https://example.com/p?a=1&b=2"));
  });

  it("normalizes protocol-relative refs", () => {
    expect(canonicalizeUrl("//unstop.com/hackathon/x")).toBe("https://unstop.com/hackathon/x");
  });

  it("keeps the root slash but collapses deeper trailing slashes", () => {
    expect(canonicalizeUrl("https://qloo.devpost.com/")).toBe("https://qloo.devpost.com/");
    expect(canonicalizeUrl("https://example.com/root/")).toBe("https://example.com/root");
  });

  it("similarity ignores query strings", () => {
    expect(urlSimilarityKey("https://a.example.com/p?x=1", "https://a.example.com/p?y=9")).toBe(true);
    expect(urlSimilarityKey("https://a.example.com/p", "https://b.example.com/p")).toBe(false);
  });
});
