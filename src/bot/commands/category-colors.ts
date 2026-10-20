import type { OpportunityCategory } from "../../core/types/common.js";

/** Shared category color palette (delivery embeds + bot listings agree). */
export const CATEGORY_COLORS: Record<OpportunityCategory, number> = {
  hackathon: 0x7b68ee,
  buildathon: 0x9370db,
  internship: 0x2ea043,
  job: 0x1f8b4c,
  remote_job: 0x26a541,
  opensource_program: 0xe67e22,
  grant_fellowship: 0xf1c40f,
  student_program: 0x3498db,
  research: 0x11806a,
  innovation_challenge: 0xe91e63,
};
