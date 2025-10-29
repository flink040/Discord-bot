import type { Guild, GuildMember, Role } from 'discord.js';

export const VERIFIED_ROLE_NAME = 'verifiziert';

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

export function findVerifiedRole(guild: Guild): Role | undefined {
  const normalized = normalize(VERIFIED_ROLE_NAME);
  return guild.roles.cache.find(role => normalize(role.name) === normalized);
}

export async function fetchGuildMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  const fromCache = guild.members.cache.get(userId);
  if (fromCache) {
    return fromCache;
  }

  try {
    const fetched = await guild.members.fetch({ user: userId });
    return fetched ?? null;
  } catch {
    return null;
  }
}

export async function isUserVerified(guild: Guild, userId: string): Promise<boolean> {
  const member = await fetchGuildMember(guild, userId);
  if (!member) {
    return false;
  }

  const normalized = normalize(VERIFIED_ROLE_NAME);
  return member.roles.cache.some(role => normalize(role.name) === normalized);
}
