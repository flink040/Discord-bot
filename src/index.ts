
import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  MessageFlags,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
} from 'discord.js';
import { startHttpServer } from './http';
import { loadCommands } from './commands/_loader';
import { registerCommands, registerOnGuildJoin, type RegisterMode } from './registry';
import { syncGuildSettingsForClient, syncGuildSettingsForGuild } from './utils/guild-settings';
import { isUserVerified } from './utils/verification';
import { getBlocklistRules } from './utils/blocklist';
import { getCachedAutomodState } from './utils/guild-feature-settings';
import { sendModerationMessage } from './utils/moderation';
import { formatDuration } from './utils/time';

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APP_ID;
if (!token || !appId) {
  console.error('[startup] Missing DISCORD_TOKEN or DISCORD_APP_ID');
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const isDev = (process.env.NODE_ENV ?? 'production') !== 'production';
const registerMode: RegisterMode = (process.env.REGISTER_MODE === 'global') ? 'global' : 'guild';

function normalizeIntentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function resolveGatewayIntents(envValue: string | undefined) {
  const defaultIntents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ];
  const resolved = new Set<number>(defaultIntents);
  const unknown: string[] = [];

  if (envValue) {
    const lookup = new Map<string, number>(
      Object.entries(GatewayIntentBits)
        .filter(([, value]) => typeof value === 'number')
        .map(([key, value]) => [normalizeIntentName(key), value as number]),
    );

    for (const raw of envValue.split(',').map(part => part.trim()).filter(Boolean)) {
      const match = lookup.get(normalizeIntentName(raw));
      if (match !== undefined) {
        resolved.add(match);
      } else {
        unknown.push(raw);
      }
    }
  }

  const intentEntries = Object.entries(GatewayIntentBits)
    .filter(([, value]) => typeof value === 'number')
    .map(([key, value]) => [key, value as number] as const);

  const nameByBit = new Map<number, string>(
    intentEntries.map(([key, value]) => [value, key]),
  );

  const names = Array.from(resolved).map((bit) => {
    const entry = nameByBit.get(bit);
    return entry ?? `#${bit}`;
  });

  return { intents: Array.from(resolved), names, unknown, nameByBit };
}

const { intents, unknown: unknownIntentNames, nameByBit } = resolveGatewayIntents(
  process.env.DISCORD_INTENTS,
);

if (unknownIntentNames.length > 0) {
  console.warn(
    '[discord] Ignoring unknown gateway intents from DISCORD_INTENTS:',
    unknownIntentNames.join(', '),
  );
}

function formatIntentNames(bits: number[]): string {
  if (bits.length === 0) {
    return '(none)';
  }
  return bits.map((bit) => nameByBit.get(bit) ?? `#${bit}`).join(', ');
}

function isDisallowedIntentsError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'string') {
    return err.includes('Disallowed intents') || err.includes('Used disallowed intents');
  }
  if (err instanceof Error) {
    const message = err.message ?? '';
    return message.includes('Disallowed intents') || message.includes('Used disallowed intents');
  }
  return false;
}

// Start health server first
const server = startHttpServer(port);

// Load commands
const commands = loadCommands();
const commandsWithoutVerification = new Set<string>(['verify', 'init']);
console.log(`[commands] Loaded: ${Array.from(commands.keys()).join(', ') || '(none)'}`);

function sanitizeForLog(input: string): string {
  return input
    .replace(/<@!?([0-9]{17,19})>/g, '@$1')
    .replace(/<@&([0-9]{17,19})>/g, '@&$1')
    .replace(/@everyone/g, '@\u200beveryone')
    .replace(/@here/g, '@\u200bhere');
}

function formatQuoted(text: string): string {
  if (!text) return '';
  const sanitized = sanitizeForLog(text);
  const truncated = sanitized.length > 500 ? `${sanitized.slice(0, 497)}…` : sanitized;
  return truncated.split(/\r?\n/).map((line) => `> ${line || ' '}`).join('\n');
}

type ClientAttachmentOptions = {
  hasMessageContent: boolean;
};

function isTextSendableChannel(channel: GuildBasedChannel): channel is GuildTextBasedChannel {
  return channel.isTextBased() && 'send' in channel;
}

async function sendInitReminder(guild: Guild) {
  const reminder = [
    '👋 Hallo! Danke, dass du den antiselbstjustiz Bot hinzugefügt hast.',
    'Bitte führe zuerst `/init` aus, damit der Bot korrekt eingerichtet werden kann.',
    'Dieser Schritt muss von der Server-Inhaberin/dem Server-Inhaber oder einer Rolle mit Administrator-Rechten durchgeführt werden.',
  ].join('\n');

  const me = guild.members.me;

  const owner = await guild.fetchOwner().catch(() => null);
  if (owner) {
    const dmSent = await owner.send({ content: reminder }).then(() => true).catch(() => false);
    if (dmSent) {
      return;
    }
  }

  const attemptSend = async (channel: GuildTextBasedChannel) => {
    const permissions = me ? channel.permissionsFor(me) : null;
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages)) {
      return false;
    }
    return channel.send({ content: reminder }).then(() => true).catch(() => false);
  };

  const systemChannel = guild.systemChannel;
  if (systemChannel && isTextSendableChannel(systemChannel)) {
    const sent = await attemptSend(systemChannel);
    if (sent) {
      return;
    }
  }

  for (const channel of guild.channels.cache.values()) {
    if (!isTextSendableChannel(channel)) {
      continue;
    }
    const sent = await attemptSend(channel);
    if (sent) {
      return;
    }
  }
}

function attachClientEventHandlers(client: Client, { hasMessageContent }: ClientAttachmentOptions) {
  client.once(Events.ClientReady, async (c) => {
    console.log(`[discord] Logged in as ${c.user.tag}`);
    if (!hasMessageContent) {
      console.warn('[blocklist] Message Content Intent ist deaktiviert. Automatische Mutes aus der Blockliste sind nicht aktiv.');
      console.warn('[blocklist] Aktiviere die Message Content Intent im Developer Portal oder setze DISCORD_INTENTS=Guilds,GuildMessages,MessageContent.');
    }
    await syncGuildSettingsForClient(c);
    try {
      await registerCommands({ client, token: token!, appId: appId!, mode: registerMode });
    } catch (err) {
      console.error('[register] Initial registration failed:', err);
    }
  });

  client.on(Events.GuildCreate, async (guild) => {
    if (registerMode === 'guild') {
      try {
        await registerOnGuildJoin({ token: token!, appId: appId!, guildId: guild.id });
      } catch (err) {
        console.error(`[register] Guild join registration failed (${guild.id}):`, err);
      }
    }

    await syncGuildSettingsForGuild(guild);
    await sendInitReminder(guild);
  });

  client.on(Events.GuildUpdate, async (_oldGuild, newGuild) => {
    await syncGuildSettingsForGuild(newGuild);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isAutocomplete()) {
      const cmd = commands.get(interaction.commandName);
      if (!cmd || typeof cmd.handleAutocomplete !== 'function') {
        await interaction.respond([]).catch(() => {});
        return;
      }

      try {
        await cmd.handleAutocomplete(interaction);
      } catch (err) {
        console.error(`[autocomplete:${interaction.commandName}]`, err);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      const cmd = commands.get(interaction.commandName);
      if (!cmd) {
        await interaction
          .reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
        return;
      }

      if (!commandsWithoutVerification.has(interaction.commandName)) {
        if (!interaction.inGuild() || !interaction.guild) {
          await interaction
            .reply({
              content: '❌ Du musst verifiziert sein, um diesen Befehl zu verwenden. Führe den Befehl auf dem Server aus und nutze `/verify` zur Verifizierung.',
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
          return;
        }

        const verified = await isUserVerified(interaction.guild, interaction.user.id);
        if (!verified) {
          await interaction
            .reply({
              content: '❌ Du musst verifiziert sein, um diesen Befehl zu verwenden. Nutze `/verify`, um die Verifizierung abzuschließen.',
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
          return;
        }
      }

      try {
        await cmd.execute(interaction);
      } catch (err) {
        console.error(`[command:${interaction.commandName}]`, err);
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('❌ An error occurred while executing this command.').catch(() => {});
        } else {
          await interaction
            .reply({ content: '❌ An error occurred while executing this command.', flags: MessageFlags.Ephemeral })
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
            .followUp({ content: '❌ Fehler bei der Verarbeitung der Aktion.', flags: MessageFlags.Ephemeral })
            .catch(() => {});
        } else {
          await interaction
            .reply({ content: '❌ Fehler bei der Verarbeitung der Aktion.', flags: MessageFlags.Ephemeral })
            .catch(() => {});
        }
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!hasMessageContent) {
      return;
    }

    if (!message.inGuild() || message.author.bot || message.system) {
      return;
    }

    const content = message.content ?? '';
    if (!content.trim()) {
      return;
    }

    const automodState = await getCachedAutomodState(message.guildId);
    if (automodState !== 'enable') {
      return;
    }

    const rules = await getBlocklistRules();
    if (rules.length === 0) {
      return;
    }

    for (const rule of rules) {
      try {
        rule.regex.lastIndex = 0;
        if (!rule.regex.test(content)) {
          continue;
        }
      } catch (err) {
        console.warn('[blocklist] Error evaluating rule:', err);
        continue;
      }

      const guild = message.guild;
      const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
      if (!member) {
        console.warn('[blocklist] Could not resolve guild member for auto-mute.');
        return;
      }

      if (!member.moderatable) {
        console.warn('[blocklist] Skipping auto-mute: member not moderatable.');
        return;
      }

      if (member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
        member.permissions.has(PermissionFlagsBits.Administrator)
      ) {
        return;
      }

      const durationMs = Math.max(1, rule.minutes) * 60 * 1000;
      const now = Date.now();
      const existingUntil = member.communicationDisabledUntilTimestamp ?? 0;
      const existingRemaining = existingUntil > now ? existingUntil - now : 0;
      const finalDuration = Math.max(durationMs, existingRemaining);
      const finalMinutes = Math.ceil(finalDuration / (60 * 1000));

      const auditReason = `Automatischer Mute: ${rule.reason}`.slice(0, 512);

      try {
        await member.timeout(finalDuration, auditReason);
      } catch (err) {
        console.error('[blocklist] Failed to apply auto-mute:', err);
        return;
      }

      const safeReason = sanitizeForLog(rule.reason);
      const matchInfo = `\`${rule.pattern}\`${rule.flags ? ` [${rule.flags}]` : ''}`;
      const baseLine =
        rule.minutes === finalMinutes
          ? `🤖 Automatischer Mute: ${message.author} wurde für ${finalMinutes} Minuten stummgeschaltet.`
          : `🤖 Automatischer Mute: ${message.author} wurde für ${finalMinutes} Minuten stummgeschaltet (Regel: ${rule.minutes} Minuten).`;

      const lines = [
        baseLine,
        `Grund: ${safeReason || 'Kein Grund angegeben'}`,
        `Auslöser: ${matchInfo}`,
        `Nachricht: ${message.url}`,
      ];

      const quoted = formatQuoted(content);
      if (quoted) {
        lines.push('', quoted);
      }

      await sendModerationMessage(guild, lines.join('\n'), { logTag: 'auto-mute' });

      await message
        .delete()
        .catch((err) => {
          console.warn('[blocklist] Failed to delete offending message after auto-mute:', err);
        });

      const muteEndsAtSeconds = Math.floor((Date.now() + finalDuration) / 1000);
      const formattedDuration = formatDuration(finalDuration) || `${finalMinutes} Minute${finalMinutes === 1 ? '' : 'n'}`;
      const dmLines = [
        `Du Frechdachs hast auf **${guild.name}** Mist gemacht und bist jetzt stummgeschaltet.`,
        `In den nächsten ${formattedDuration} kannst du darüber nachdenken wie man sich verhalten sollte.`,
        `Am ${`<t:${muteEndsAtSeconds}:f>`} kannst du wieder am Geschehnis teilnehmen.`,
        `Begründung: ${safeReason || 'Kein Grund angegeben'}`,
      ];

      await message.author
        .send({ content: dmLines.join('\n') })
        .catch(() => {});

      return;
    }
  });
}

type ConnectedClient = {
  client: Client;
  hasMessageContent: boolean;
};

async function connectWithIntents(requestedIntents: number[]): Promise<ConnectedClient> {
  const hasMessageContent = requestedIntents.includes(GatewayIntentBits.MessageContent);
  const instance = new Client({ intents: requestedIntents });
  attachClientEventHandlers(instance, { hasMessageContent });

  try {
    await instance.login(token!);
    return { client: instance, hasMessageContent };
  } catch (err) {
    instance.removeAllListeners();
    try {
      await instance.destroy();
    } catch {}
    throw err;
  }
}

let activeClient: Client | null = null;
let activeIntents = intents;

void (async () => {
  try {
    const { client } = await connectWithIntents(activeIntents);
    activeClient = client;
    console.log(`[discord] Gateway intents: ${formatIntentNames(activeIntents)}`);
  } catch (err) {
    if (isDisallowedIntentsError(err) && activeIntents.includes(GatewayIntentBits.MessageContent)) {
      const fallbackIntents = activeIntents.filter((bit) => bit !== GatewayIntentBits.MessageContent);
      console.warn('[discord] Message Content Intent ist nicht autorisiert. Starte erneut ohne diese Intent.');
      console.warn('[blocklist] Blocklisten-Auto-Mutes sind deaktiviert, bis die Message Content Intent freigeschaltet ist.');
      try {
        const { client } = await connectWithIntents(fallbackIntents);
        activeClient = client;
        activeIntents = fallbackIntents;
        console.log(`[discord] Gateway intents: ${formatIntentNames(activeIntents)}`);
      } catch (fallbackErr) {
        console.error('[discord] Login failed after removing Message Content intent:', fallbackErr);
        process.exit(1);
      }
    } else {
      console.error('[discord] Login failed:', err);
      process.exit(1);
    }
  }
})();

// Graceful shutdown
const shutdown = async () => {
  console.log('[shutdown] Shutting down...');
  const client = activeClient;
  try {
    if (client) {
      await client.destroy();
    }
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
