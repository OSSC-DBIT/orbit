import { expect, describe, it } from "vitest";
import { GLOBAL_SOURCES, SOURCE_SYNC_PRIORITY } from "../../src/opportunities/connectors/registry.js";

/**
 * Sync preference policy: HackCulture runs first every cycle and therefore
 * claims canonical ownership of listings that multiple sources deliver
 * (insert-once fingerprint dedup preserves the first holder).
 */
describe("source sync priority", () => {
  it("gives HackCulture the first preference", () => {
    expect(SOURCE_SYNC_PRIORITY[0]).toBe("hackculture");
  });

  it("covers every known global source exactly once", () => {
    const known = GLOBAL_SOURCES.map((source) => source.id);
    expect(new Set(SOURCE_SYNC_PRIORITY)).toEqual(new Set(known));
    expect(SOURCE_SYNC_PRIORITY.length).toBe(known.length);
  });
});
