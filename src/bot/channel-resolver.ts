import type { Client, TextChannel, GuildBasedChannel } from "discord.js";
import type { TenantService } from "../tenants/services/tenant-service.js";
import type { ChannelKind } from "../core/types/common.js";
import type { SendPayload, DiscordChannel } from "../opportunities/delivery/delivery-service.js";

/**
 * Resolves Discord sendable channels from tenant channel configuration for
 * the delivery engine (instant, digest, deadline and infrastructure feeds).
 */
export class DiscordTargetResolver {
  constructor(
    private client: Client,
    private tenant: TenantService,
  ) {}

  async resolve(kind: ChannelKind, guildId: string): Promise<DiscordChannel | null> {
    const row = await this.tenant.getChannel(guildId, kind);
    if (!row) return null;
    return this.toDiscordChannel(row.channelId, guildId);
  }

  /** Tenant-mention role id for the given kind, when configured. */
  async mentionFor(kind: ChannelKind, guildId: string): Promise<string | null> {
    const row = await this.tenant.getChannel(guildId, kind);
    return row?.mentionRoleId ?? null;
  }

  toDiscordChannel(channelId: string, guildId: string): DiscordChannel | null {
    // The send call defers fetching: failures release the delivery claim so
    // the next pass retries (transient) or records it (permanent).
    return {
      id: channelId,
      guildId,
      send: async (payload: SendPayload): Promise<string> => {
        const channel = await this.fetchTextChannel(channelId);
        const message = await channel.send({
          content: payload.content ?? "",
          embeds: payload.embeds ?? [],
          allowedMentions: normalizeMentions(payload.allowedMentions),
        });
        return message.id;
      },
    };
  }

  private async fetchTextChannel(channelId: string): Promise<TextChannel> {
    const channel = (await this.client.channels.fetch(channelId)) as GuildBasedChannel | null;
    if (!channel || !("send" in channel)) {
      throw new Error(`channel ${channelId} is not a text channel`);
    }
    return channel as TextChannel;
  }
}

/** Maps SendPayload semantics onto discord.js strict mention options. */
function normalizeMentions(mentions: SendPayload["allowedMentions"] | undefined): {
  parse: readonly ("roles" | "users" | "everyone")[];
  roles?: string[];
  users?: string[];
} {
  if (!mentions) return { parse: [] as const };
  return {
    parse: [] as const,
    ...(mentions.roles?.length ? { roles: mentions.roles } : {}),
    ...(mentions.users?.length ? { users: mentions.users } : {}),
  };
}
