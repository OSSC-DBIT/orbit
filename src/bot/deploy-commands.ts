#!/usr/bin/env node
/**
 * Registers (or clears with --clear) Orbit's global slash commands.
 * Run once per deployment or whenever commands change:
 *   npm run bot:register-commands
 */
import "dotenv/config";
import { loadConfig } from "../core/config/env.js";
import { registerCommands } from "./client.js";
import { allCommands } from "./commands/index.js";

async function main(): Promise<void> {
  const clear = process.argv.includes("--clear");
  const config = loadConfig();
  const { REST, Routes } = await import("discord.js");
  const rest = new REST().setToken(config.DISCORD_BOT_TOKEN);

  if (clear) {
    await rest.put(Routes.applicationCommands(config.DISCORD_APPLICATION_ID), { body: [] });
    console.log("cleared global application commands");
    return;
  }

  const names = allCommands().map((c) => `/${c.name}`);
  console.log(`registering ${names.length} commands: ${names.join(" ")}`);
  await registerCommands(config.DISCORD_APPLICATION_ID, config.DISCORD_BOT_TOKEN);
  console.log("done");
}

main().catch((err) => {
  console.error("failed to register commands:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
