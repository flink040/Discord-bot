
import 'dotenv/config';
import { Client, GatewayIntentBits, Events, Interaction } from 'discord.js';
import { startHttpServer } from './http';
import { loadCommands } from './commands/_loader';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[startup] DISCORD_TOKEN is missing');
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const isDev = (process.env.NODE_ENV ?? 'production') !== 'production';

// Start health server first so Railway sees us as healthy quickly
const server = startHttpServer(port);

// Discord client with minimal intents
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// Load commands
const commands = loadCommands();
console.log(`[commands] Loaded: ${Array.from(commands.keys()).join(', ') || '(none)'}`);

// Ready
client.once(Events.ClientReady, (c) => {
  console.log(`[discord] Logged in as ${c.user.tag}`);
});

// Handle interactions
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;
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
      await interaction.reply({ content: '❌ An error occurred while executing this command.', ephemeral: true }).catch(() => {});
    }
  }
});

// Login
client.login(token).catch((err) => {
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
}
