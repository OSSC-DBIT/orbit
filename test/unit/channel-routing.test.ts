import { describe, expect, it } from "vitest";
import { CHANNEL_KINDS, channelKindForCategory } from "../../src/core/types/common.js";

/** Category to channel kind routing for the per category feed splits. */
describe("channelKindForCategory", () => {
  it("routes hackathon family to the hackathons kind", () => {
    expect(channelKindForCategory("hackathon")).toBe("hackathons");
    expect(channelKindForCategory("buildathon")).toBe("hackathons");
  });

  it("routes job family to the jobs kind", () => {
    expect(channelKindForCategory("job")).toBe("jobs");
    expect(channelKindForCategory("remote_job")).toBe("jobs");
  });

  it("routes internships", () => {
    expect(channelKindForCategory("internship")).toBe("internships");
  });

  it("niche categories fall back to the opportunities catch-all", () => {
    for (const c of ["opensource_program", "student_program", "research", "innovation_challenge", "grant_fellowship"]) {
      expect(channelKindForCategory(c)).toBeNull();
    }
    expect(channelKindForCategory("")).toBeNull();
  });

  it("the split kinds are registered channel kinds", () => {
    for (const kind of ["hackathons", "jobs", "internships"] as const) {
      expect(CHANNEL_KINDS).toContain(kind);
    }
  });
});
