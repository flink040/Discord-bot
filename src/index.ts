
import 'dotenv/config';
import { Client, GatewayIntentBits, Events, Interaction } from 'discord.js';
import { startHttpServer } from './http';
import { loadCommands } from './commands/_loader';
import { registerCommands, registerOnGuildJoin, type RegisterMode } from './registry';

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APP_ID;
if (!token || !appId) {
  console.error('[startup] Missing DISCORD_TOKEN or DISCORD_APP_ID');
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const isDev = (process.env.NODE_ENV ?? 'production') !== 'production';
const registerMode: RegisterMode = (process.env.REGISTER_MODE === 'global') ? 'global' : 'guild';

// Start health server first
const server = startHttpServer(port);

// Discord client with minimal intents
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Load commands
const commands = loadCommands();
console.log(`[commands] Loaded: ${Array.from(commands.keys()).join(', ') || '(none)'}`);

// Ready
client.once(Events.ClientReady, async (c) => {
  console.log(`[discord] Logged in as ${c.user.tag}`);
  try {
    await registerCommands({ client, token: token!, appId: appId!, mode: registerMode });
  } catch (err) {
    console.error('[register] Initial registration failed:', err);
  }
});

// Register when bot joins a new guild (only relevant in guild mode)
client.on(Events.GuildCreate, async (guild) => {
  if (registerMode !== 'guild') return;
  try {
    await registerOnGuildJoin({ token: token!, appId: appId!, guildId: guild.id });
  } catch (err) {
    console.error(`[register] Guild join registration failed (${guild.id}):`, err);
  }
});

// Handle interactions
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (interaction.isChatInputCommand()) {
    const cmd = commands.get(interaction.commandName);
    if (!cmd) {
      await interaction.reply({ content: 'Unknown command.', ephemeral: true }).catch(() => {});
      return;
    }
    try {
      await cmd.execute(interaction);
    } catch (err) {
      console.error(`[command:${interaction.commandName}]`, err);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ An error occurred while executing this command.').catch(() => {});
      } else {
        await interaction
          .reply({ content: '❌ An error occurred while executing this command.', ephemeral: true })
          .catch(() => {});
      }
    }
    return;
  }

  if (interaction.isMessageComponent()) {
    const [commandName] = interaction.customId.split(':', 1);
    const cmd = commands.get(commandName);
    if (!cmd || typeof cmd.handleComponent !== 'function') {
      return;
    }

    try {
      await cmd.handleComponent(interaction);
    } catch (err) {
      console.error(`[component:${interaction.customId}]`, err);
      if (interaction.deferred || interaction.replied) {
        await interaction
          .followUp({ content: '❌ Fehler bei der Verarbeitung der Aktion.', ephemeral: true })
          .catch(() => {});
      } else {
        await interaction
          .reply({ content: '❌ Fehler bei der Verarbeitung der Aktion.', ephemeral: true })
          .catch(() => {});
      }
    }
  }
});

// Login
client.login(token!).catch((err) => {
  console.error('[discord] Login failed:', err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('[shutdown] Shutting down...');
  try {
    await client.destroy();
  } catch {}
  try {
    server.close();
  } catch {}
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (isDev) {
  console.log('[env] Development mode enabled');
  console.log(`[env] REGISTER_MODE=${registerMode}`);
}
