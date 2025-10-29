import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { loadCommands, commandsJson } from './commands/_loader';

const mode = (process.argv[2] ?? 'dev') as 'dev' | 'global';
const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APP_ID;
const guildId = process.env.DEV_GUILD_ID;

if (!token || !appId) {
  console.error('[register] Missing DISCORD_TOKEN or DISCORD_APP_ID');
  process.exit(1);
}

if (mode === 'dev' && !guildId) {
  console.error('[register] DEV_GUILD_ID is required for dev (guild) registration');
  process.exit(1);
}

async function main() {
  const rest = new REST({ version: '10' }).setToken(token!);
  const commands = commandsJson(loadCommands());

  if (mode === 'global') {
    console.log(`[register] Registering ${commands.length} global commands...`);
    await rest.put(Routes.applicationCommands(appId!), { body: commands });
    console.log('[register] Global commands registered.');
  } else {
    console.log(`[register] Registering ${commands.length} guild commands to ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(appId!, guildId!), { body: commands });
    console.log('[register] Guild commands registered.');
  }
}

main().catch((err) => {
  console.error('[register] Failed:', err);
  process.exit(1);
});
