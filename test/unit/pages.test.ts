import { expect, describe, it } from "vitest";
import { homeHtml, privacyHtml, termsHtml } from "../../src/api/pages.js";

/**
 * Public legal/landing pages are served as static HTML from src/api/pages.ts
 * (mirrored in docs/privacy.md and docs/terms.md). These tests pin the key
 * content and the ASCII/no dash discipline.
 */
describe("public static pages", () => {
  it("landing page links privacy and terms and identifies staging", () => {
    const html = homeHtml();
    expect(html).toContain("/privacy");
    expect(html).toContain("/terms");
    expect(html).toContain("orbit-staging.webuildnow.in");
  });

  it("privacy page discloses collected data, AI scope and contact", () => {
    const html = privacyHtml();
    expect(html).toContain("Data we collect");
    expect(html).toContain("no message content intent");
    expect(html).toContain("OSSC DBIT, Bangalore");
    expect(html).toContain("stored in the database");
  });

  it("terms page covers information quality and as-is warranty", () => {
    const html = termsHtml();
    expect(html).toContain("verify application deadlines");
    expect(html).toContain("PROVIDED AS IS");
  });

  it("keeps all pages dash-free and self contained", () => {
    for (const html of [homeHtml(), privacyHtml(), termsHtml()]) {
      expect(html).not.toMatch(/[\u2013\u2014]/);
      expect(html).toContain("doctype html");
    }
  });
});
