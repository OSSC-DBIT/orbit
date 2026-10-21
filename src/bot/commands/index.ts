import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { coreCommands } from "./core.js";
import { configCommands } from "./config.js";
import { opportunityCommands } from "./opportunities.js";
import { projectCommands } from "./projects.js";
import {
  resolveTenantTimezone,
  isAdmin,
  replyEphemeral,
  infoEmbed,
  type OrbitCommand,
  type OrbitCommandContext,
  type CommandDeps,
} from "./context.js";
import { formatInTz } from "../../core/time/tz.js";
import { getLogger } from "../../core/logging/logger.js";

/** Full command registry deployed to Discord's global application commands. */
export function allCommands(): OrbitCommand[] {
  return [...coreCommands(), ...configCommands(), ...opportunityCommands(), ...projectCommands()];
}

/**
 * Single interaction entry point: builds the tenant context (guild-bound
 * timezone, correlation id) and dispatches. Admin gates live INSIDE handlers
 * via requireAdmin so mixed subcommands stay precise.
 */
export async function dispatchCommand(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
  const command = allCommands().find((c) => c.name === interaction.commandName);
  if (!command) return;

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "Orbit commands only run inside a Discord server.", flags: MessageFlags.Ephemeral });
    return;
  }

  const tz = await resolveTenantTimezone(deps.tenant, guildId);
  const ctx: OrbitCommandContext = {
    interaction,
    deps,
    guildId,
    userId: interaction.user.id,
    tz,
    fmt: (d) => (d ? formatInTz(d, tz) : "-"),
  };

  // Dispatch level gate: the adminOnly flag is enforced here in addition to the
  // in-handler requireAdmin calls, so a missed handler gate can never leak a
  // configuration action to a non-admin.
  if (command.adminOnly && !(await isAdmin(ctx))) {
    await replyEphemeral(
      ctx,
      infoEmbed(
        "Administrators only",
        "Only server administrators (or principals authorized via /authorized-roles) can use this command.",
        0xed4245,
      ),
    );
    return;
  }

  try {
    await command.handler(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    getLogger().error({ command: command.name, guildId, error: message }, "command failed");
    const content = "That command failed; the error was logged.";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
}
