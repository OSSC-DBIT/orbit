import { describe, expect, it } from "vitest";
import { allCommands } from "../../src/bot/commands/index.js";
import { CHANNEL_KINDS, FEATURE_KEYS } from "../../src/core/types/common.js";

/**
 * The /channels kind dropdown and /features kind dropdown must be derived
 * from the canonical constants: a new channel kind or feature that is not
 * selectable in Discord is invisible forever. Guards the drift that once
 * hid hackathons/jobs/internships.
 */

function findCommand(name: string) {
  const command = allCommands().find((c) => c.name === name);
  if (!command) throw new Error(`missing /${name} command`);
  return command;
}

function suboptionValueChoices(commandName: string, sub: string, option: string): string[] {
  // cast through unknown: the builders are structural at runtime, we only
  // need the serialised option tree here
  const def = findCommand(commandName).definition as unknown as {
    options: Array<{ name: string; options?: Array<{ name: string; choices?: Array<{ value: string }> }> }>;
  };
  const subcommands = def.options ?? [];
  const subcommand = subcommands.find((s) => s.name === sub);
  const chosen = subcommand?.options?.find((o) => o.name === option);
  return (chosen?.choices ?? []).map((choice) => choice.value);
}

describe("discord dropdown choices mirror the canonical constants", () => {
  it("/channels set and clear list every channel kind", () => {
    for (const sub of ["set", "clear"]) {
      const values = suboptionValueChoices("channels", sub, "kind");
      expect(values).toEqual([...CHANNEL_KINDS]);
    }
  });

  it("/features enable and disable list every feature", () => {
    for (const sub of ["enable", "disable"]) {
      const values = suboptionValueChoices("features", sub, "kind");
      expect(values).toEqual([...FEATURE_KEYS]);
    }
  });
});
