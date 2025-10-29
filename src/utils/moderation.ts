import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'config', 'moderation-channels.json');

type ModerationChannelMap = Record<string, string>;

let cachedChannels: ModerationChannelMap | null = null;

function normalizeConfig(value: unknown): ModerationChannelMap {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: ModerationChannelMap = {};
  for (const [guildId, channelId] of Object.entries(value as Record<string, unknown>)) {
    if (typeof channelId === 'string' && channelId.trim().length > 0) {
      result[guildId] = channelId;
    }
  }

  return result;
}

async function loadConfig(): Promise<ModerationChannelMap> {
  if (cachedChannels) {
    return cachedChannels;
  }

  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    cachedChannels = normalizeConfig(JSON.parse(raw));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      console.error('[moderation] Failed to read moderation channel config:', error);
    }
    cachedChannels = {};
  }

  return cachedChannels;
}

async function persistConfig(map: ModerationChannelMap): Promise<void> {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const payload = `${JSON.stringify(map, null, 2)}\n`;
  await writeFile(CONFIG_PATH, payload, 'utf8');
}

export async function getModerationChannelId(guildId: string): Promise<string | null> {
  const map = await loadConfig();
  return map[guildId] ?? null;
}

export async function setModerationChannelId(
  guildId: string,
  channelId: string | null,
): Promise<boolean> {
  const map = await loadConfig();

  const normalized = channelId?.trim() ?? null;
  const previous = map[guildId];
  const hadPrevious = Object.prototype.hasOwnProperty.call(map, guildId);

  if (normalized && normalized === previous) {
    return true;
  }

  if (!normalized && !hadPrevious) {
    return true;
  }

  if (normalized) {
    map[guildId] = normalized;
  } else {
    delete map[guildId];
  }

  try {
    await persistConfig(map);
    return true;
  } catch (error) {
    if (hadPrevious) {
      map[guildId] = previous;
    } else {
      delete map[guildId];
    }
    console.error('[moderation] Failed to write moderation channel config:', error);
    return false;
  }
}
