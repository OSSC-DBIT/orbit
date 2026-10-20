import { Client, Events, GatewayIntentBits, Partials, REST, Routes, type ClientOptions } from "discord.js";
import type { AppConfig } from "../core/config/env.js";
import { getLogger, scopedLogger } from "../core/logging/logger.js";
import { TenantService } from "../tenants/services/tenant-service.js";
import { DiscordTargetResolver } from "./channel-resolver.js";
import { dispatchCommand } from "./commands/index.js";
import { routePaginationButton } from "./commands/context.js";
import type { CommandDeps } from "./commands/context.js";

/**
 * Discord gateway client.
 *
 * Tenancy is derived ONLY from the verified interaction context: every
 * interaction carries guildId + member (with permission bits) signed by
 * Discord. Handlers never accept a guildId chosen by the user.
 */
export function buildClientOptions(): ClientOptions {
  return {
    // Minimal unprivileged set: every command derives guild, member and
    // permission facts from the signed interaction payload, so the SERVER
    // MEMBERS / MESSAGE CONTENT privileged intents stay OFF.
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  };
}

export interface BotServices {
  tenant: TenantService;
  client: Client;
  targetResolver: DiscordTargetResolver;
}

export async function startDiscordClient(
  deps: CommandDeps,
  config: AppConfig,
): Promise<BotServices> {
  const log = scopedLogger(getLogger(), { tenant: "discord" });
  const client = new Client(buildClientOptions());
  const tenant = deps.tenant;
  const targetResolver = new DiscordTargetResolver(client, tenant);

  client.once(Events.ClientReady, async (ready) => {
    log.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, "discord ready");
    for (const guild of ready.guilds.cache.values()) {
      await tenant.ensureGuild(guild.id, guild.name, guild.preferredLocale);
      await tenant.rejoinGuild(guild.id);
    }
  });

  client.on(Events.GuildCreate, async (guild) => {
    await tenant.ensureGuild(guild.id, guild.name, guild.preferredLocale);
    log.info({ guildId: guild.id }, "joined guild");
  });

  client.on(Events.GuildDelete, async (guild) => {
    await tenant.markGuildDeleted(guild.id);
    log.info({ guildId: guild.id }, "left guild");
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      await dispatchCommand(interaction, deps);
      return;
    }
    if (interaction.isButton()) {
      await routePaginationButton(interaction);
    }
  });

  // Non-fatal gateway boot: a bad token or Discord outage must never take
  // down the HTTP plane or the job scheduler. Login retries with backoff and
  // the resolver simply yields no channels until the gateway is ready.
  void loginWithRetry(client, config.DISCORD_BOT_TOKEN, log);
  return { tenant, client, targetResolver };
}

const GATEWAY_RETRY_BASE_MS = 30_000;
const GATEWAY_RETRY_MAX_MS = 5 * 60_000;

async function loginWithRetry(
  client: Client,
  token: string,
  log: ReturnType<typeof scopedLogger>,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await client.login(token);
      return; // gateway connected; reconnects from here on are handled by discord.js
    } catch (err) {
      attempt++;
      const delayMs = Math.min(GATEWAY_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 4), GATEWAY_RETRY_MAX_MS);
      log.warn(
        { attempt, delayMs, error: err instanceof Error ? err.message : String(err) },
        "discord login failed; retrying",
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Registers slash commands globally (idempotent). */
export async function registerCommands(applicationId: string, botToken: string): Promise<number> {
  const rest = new REST().setToken(botToken);
  const { allCommands } = await import("./commands/index.js");
  const body = allCommands().map((c) => c.definition.toJSON());
  const result = (await rest.put(Routes.applicationCommands(applicationId), { body })) as unknown[];
  return result.length;
}
