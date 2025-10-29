
import { REST, Routes, type Client } from 'discord.js';
import { loadCommands, commandsJson } from './commands/_loader';

export type RegisterMode = 'guild' | 'global';

/** Registers slash commands either globally or per guild. */
export async function registerCommands(options: {
  client: Client;
  token: string;
  appId: string;
  mode: RegisterMode;
}) {
  const { client, token, appId, mode } = options;
  const rest = new REST({ version: '10' }).setToken(token);

  const commandsMap = loadCommands();
  const body = commandsJson(commandsMap);
  console.log(`[register] Preparing ${body.length} commands (${mode}).`);

  if (mode === 'global') {
    await rest.put(Routes.applicationCommands(appId), { body });
    console.log('[register] Global commands: upserted.');
  } else {
    const guilds = client.guilds.cache.map(g => g.id);
    if (guilds.length === 0) {
      console.log('[register] No guilds found yet; will register on guild join.');
    }
    for (const gid of guilds) {
      await rest.put(Routes.applicationGuildCommands(appId, gid), { body });
      console.log(`[register] Guild ${gid}: upserted.`);
    }
  }
}

/** Registers commands when the bot is added to a new guild (guild mode only). */
export async function registerOnGuildJoin(options: {
  token: string;
  appId: string;
  guildId: string;
}) {
  const { token, appId, guildId } = options;
  const rest = new REST({ version: '10' }).setToken(token);
  const commandsMap = loadCommands();
  const body = commandsJson(commandsMap);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
  console.log(`[register] Guild ${guildId}: upserted (join).`);
}
