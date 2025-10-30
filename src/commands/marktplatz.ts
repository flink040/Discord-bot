import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  type NewsChannel,
  type TextChannel,
} from 'discord.js';

import type { CommandDef } from '../types/Command';
import { getSupabaseClient } from '../supabase';
import {
  DEFAULT_MARKETPLACE_POST_INTERVAL_HOURS,
  getMarketplaceChannelId,
  getMarketplacePostIntervalHours,
} from '../utils/marketplace';
import {
  getLastMarketplacePostTimestamp,
  setLastMarketplacePostTimestamp,
} from '../utils/marketplace-posts';

type SupportedChannel = TextChannel | NewsChannel;

type MarketplaceInteraction = ChatInputCommandInteraction<'cached'>;

type IntentType = 'buy' | 'sell';

type ItemRelation<T> = T | T[] | null;

type TradeIntentRow = {
  id: string;
  intent_type: IntentType;
  quantity: number | string | null;
  price_min: number | string | null;
  price_max: number | string | null;
  contact_method: string | null;
  notes: string | null;
  updated_at: string | null;
  created_at: string | null;
  items: ItemRelation<{ name: string | null }>;
};

type UserRow = {
  id: string;
  minecraft_username: string | null;
};

function getFirstRelation<T>(relation: ItemRelation<T>): T | null {
  if (!relation) {
    return null;
  }
  return Array.isArray(relation) ? relation[0] ?? null : relation;
}

function isSupportedChannel(channel: GuildBasedChannel | null): channel is SupportedChannel {
  return Boolean(
    channel &&
      (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement),
  );
}

function ensureGuildInteraction(
  interaction: ChatInputCommandInteraction,
): MarketplaceInteraction | null {
  if (!interaction.inCachedGuild()) {
    void interaction.reply({
      content: '❌ Dieser Befehl kann nur innerhalb eines Servers verwendet werden.',
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return interaction;
}

function normalizeNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function formatPrice(minRaw: number | string | null, maxRaw: number | string | null): string | null {
  const min = normalizeNumber(minRaw);
  const max = normalizeNumber(maxRaw);

  if (min === null && max === null) {
    return null;
  }

  const formatter = new Intl.NumberFormat('de-DE');

  if (min !== null && max !== null) {
    if (Math.abs(min - max) < Number.EPSILON) {
      return `${formatter.format(min)} Smaragde`;
    }
    const lower = Math.min(min, max);
    const upper = Math.max(min, max);
    return `${formatter.format(lower)} – ${formatter.format(upper)} Smaragde`;
  }

  if (min !== null) {
    return `ab ${formatter.format(min)} Smaragde`;
  }

  if (max !== null) {
    return `bis ${formatter.format(max)} Smaragde`;
  }

  return null;
}

function formatQuantity(quantityRaw: number | string | null): string | null {
  const quantity = normalizeNumber(quantityRaw);
  if (quantity === null) return null;
  return quantity === 1 ? '1 Stück' : `${quantity} Stück`;
}

function truncate(text: string, limit = 180): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}…`;
}

function formatIntentRow(row: TradeIntentRow): string | null {
  const item = getFirstRelation(row.items);
  const itemName = item?.name?.trim();
  if (!itemName) {
    return null;
  }

  const lines: string[] = [];
  const quantityText = formatQuantity(row.quantity);
  const headerParts = [`**${itemName}**`];
  if (quantityText) {
    headerParts.push(`(${quantityText})`);
  }
  lines.push(`• ${headerParts.join(' ')}`);

  const priceText = formatPrice(row.price_min, row.price_max);
  if (priceText) {
    lines.push(`  Preis: ${priceText}`);
  }

  const contact = row.contact_method?.trim();
  if (contact) {
    lines.push(`  Kontakt: ${truncate(contact, 120)}`);
  }

  const notes = row.notes?.trim();
  if (notes) {
    lines.push(`  Notiz: ${truncate(notes, 180)}`);
  }

  return lines.join('\n');
}

function chunkFieldValues(values: string[], chunkSize = 1024): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;

    if (trimmed.length > chunkSize) {
      const truncated = truncate(trimmed, chunkSize);
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(truncated);
      continue;
    }

    if (current.length === 0) {
      current = trimmed;
      continue;
    }

    if (current.length + trimmed.length + 1 <= chunkSize) {
      current = `${current}\n${trimmed}`;
    } else {
      chunks.push(current);
      current = trimmed;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (hours > 0) {
    parts.push(hours === 1 ? '1 Stunde' : `${hours} Stunden`);
  }
  if (minutes > 0) {
    parts.push(minutes === 1 ? '1 Minute' : `${minutes} Minuten`);
  }

  return parts.length > 0 ? parts.join(' und ') : 'wenigen Augenblicken';
}

const data = new SlashCommandBuilder()
  .setName('marktplatz')
  .setDescription('Veröffentlicht deine aktiven Marktplatz-Gesuche und Angebote im Marktplatzchannel.')
  .addSubcommand(subcommand =>
    subcommand.setName('full').setDescription('Poste alle aktiven Angebote und Gesuche.'),
  )
  .addSubcommand(subcommand =>
    subcommand.setName('sell').setDescription('Poste deine aktiven Verkaufsangebote.'),
  )
  .addSubcommand(subcommand =>
    subcommand.setName('buy').setDescription('Poste deine aktiven Gesuche.'),
  );

async function fetchUser(interaction: MarketplaceInteraction): Promise<UserRow | null> {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase
    .from('users')
    .select('id, minecraft_username')
    .eq('discord_id', interaction.user.id)
    .maybeSingle<UserRow>();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  if (!row || !row.minecraft_username) {
    return null;
  }

  return row;
}

async function fetchTradeIntents(
  userId: string,
  filter: IntentType[] | null,
): Promise<TradeIntentRow[]> {
  const supabase = getSupabaseClient();
  let query = supabase
    .from('item_trade_intents')
    .select(
      `id,
       intent_type,
       quantity,
       price_min,
       price_max,
       contact_method,
       notes,
       updated_at,
       created_at,
       items(name)`
    )
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('updated_at', { ascending: false });

  if (filter && filter.length === 1) {
    query = query.eq('intent_type', filter[0]);
  } else if (filter && filter.length > 1) {
    query = query.in('intent_type', filter);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  return (data as TradeIntentRow[]) ?? [];
}

function buildEmbed(
  username: string,
  intents: TradeIntentRow[],
  filter: IntentType[] | null,
): EmbedBuilder | null {
  const sellIntents = intents.filter(intent => intent.intent_type === 'sell');
  const buyIntents = intents.filter(intent => intent.intent_type === 'buy');

  const includeSell = !filter || filter.includes('sell');
  const includeBuy = !filter || filter.includes('buy');

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(`Marktplatz von ${username}`)
    .setTimestamp(new Date());

  let hasContent = false;

  if (includeSell && sellIntents.length > 0) {
    const values = sellIntents
      .map(formatIntentRow)
      .filter((value): value is string => value !== null && value.length > 0);
    const chunks = chunkFieldValues(values);
    chunks.forEach((chunk, index) => {
      hasContent = true;
      const suffix = chunks.length > 1 ? ` (Teil ${index + 1})` : '';
      embed.addFields({ name: `Verkaufe${suffix}`, value: chunk });
    });
  }

  if (includeBuy && buyIntents.length > 0) {
    const values = buyIntents
      .map(formatIntentRow)
      .filter((value): value is string => value !== null && value.length > 0);
    const chunks = chunkFieldValues(values);
    chunks.forEach((chunk, index) => {
      hasContent = true;
      const suffix = chunks.length > 1 ? ` (Teil ${index + 1})` : '';
      embed.addFields({ name: `Suche${suffix}`, value: chunk });
    });
  }

  if (!hasContent) {
    return null;
  }

  return embed;
}

async function ensureMarketplaceChannel(
  interaction: MarketplaceInteraction,
): Promise<SupportedChannel | null> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply('❌ Der Server konnte nicht geladen werden. Bitte versuche es erneut.');
    return null;
  }

  const channelId = await getMarketplaceChannelId(guild.id);
  if (!channelId) {
    await interaction.editReply(
      '❌ Es ist kein Marktplatzchannel konfiguriert. Bitte verwende zuerst `/init`, um einen Channel anzulegen.',
    );
    return null;
  }

  try {
    const channel = await guild.channels.fetch(channelId);
    if (!isSupportedChannel(channel)) {
      await interaction.editReply(
        '❌ Der konfigurierte Marktplatzchannel existiert nicht mehr oder ist kein Textchannel.',
      );
      return null;
    }

    return channel;
  } catch (error) {
    console.error('[marktplatz] Failed to fetch channel', error);
    await interaction.editReply('❌ Der Marktplatzchannel konnte nicht geladen werden.');
    return null;
  }
}

async function ensurePostingInterval(interaction: MarketplaceInteraction): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply('❌ Der Server konnte nicht geladen werden. Bitte versuche es erneut.');
    return false;
  }

  let intervalHours = await getMarketplacePostIntervalHours(guild.id);
  if (intervalHours === null) {
    intervalHours = DEFAULT_MARKETPLACE_POST_INTERVAL_HOURS;
  }

  const lastPost = await getLastMarketplacePostTimestamp(guild.id, interaction.user.id);
  if (lastPost !== null) {
    const intervalMs = intervalHours * 60 * 60 * 1000;
    const now = Date.now();
    const elapsed = now - lastPost;
    if (elapsed < intervalMs) {
      const remaining = intervalMs - elapsed;
      const durationText = formatDuration(remaining);
      await interaction.editReply(
        `⏳ Du kannst erst in ${durationText} erneut im Marktplatz posten. Bitte warte, bevor du erneut postest.`,
      );
      return false;
    }
  }
  return true;
}

export const execute = async (rawInteraction: ChatInputCommandInteraction) => {
  const interaction = ensureGuildInteraction(rawInteraction);
  if (!interaction) {
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let userRow: UserRow | null;
  try {
    userRow = await fetchUser(interaction);
  } catch (error) {
    console.error('[marktplatz] Failed to load user', error);
    await interaction.editReply('❌ Fehler beim Laden deiner Verknüpfung. Bitte versuche es später erneut.');
    return;
  }

  if (!userRow) {
    await interaction.editReply(
      '❌ Für deinen Discord-Account ist kein verknüpfter Minecraft-Nutzer eingetragen. Bitte verifiziere dich zuerst mit `/verify`.',
    );
    return;
  }

  const filter = interaction.options.getSubcommand();
  const filterTypes: IntentType[] | null =
    filter === 'full' ? null : (filter === 'sell' ? ['sell'] : ['buy']);

  let intents: TradeIntentRow[];
  try {
    intents = await fetchTradeIntents(userRow.id, filterTypes);
  } catch (error) {
    console.error('[marktplatz] Failed to load trade intents', error);
    await interaction.editReply('❌ Fehler beim Laden deiner Marktplatz-Einträge. Bitte versuche es später erneut.');
    return;
  }

  if (intents.length === 0) {
    const typeText =
      filter === 'sell'
        ? 'keine aktiven Verkaufsangebote'
        : filter === 'buy'
          ? 'keine aktiven Gesuche'
          : 'keine aktiven Marktplatz-Einträge';
    await interaction.editReply(`ℹ️ Du hast derzeit ${typeText}.`);
    return;
  }

  const channel = await ensureMarketplaceChannel(interaction);
  if (!channel) {
    return;
  }

  if (!(await ensurePostingInterval(interaction))) {
    return;
  }

  const embed = buildEmbed(userRow.minecraft_username ?? 'Unbekannt', intents, filterTypes);
  if (!embed) {
    await interaction.editReply('ℹ️ Deine Marktplatz-Einträge enthalten keine vollständigen Itemdaten.');
    return;
  }

  try {
    await channel.send({
      content: `<@${interaction.user.id}> hat den Marktplatz aktualisiert:`,
      embeds: [embed],
    });
  } catch (error) {
    console.error('[marktplatz] Failed to send message', error);
    await interaction.editReply('❌ Die Nachricht konnte nicht im Marktplatzchannel veröffentlicht werden.');
    return;
  }

  const guild = interaction.guild;
  let reply = `✅ Deine Marktplatz-Einträge wurden in ${channel} veröffentlicht.`;
  if (guild) {
    const stored = await setLastMarketplacePostTimestamp(guild.id, interaction.user.id, Date.now());
    if (!stored) {
      reply +=
        '\n⚠️ Hinweis: Der Zeitpunkt deines letzten Marktplatz-Posts konnte nicht gespeichert werden. Bitte achte selbst auf das Intervall.';
    }
  }

  await interaction.editReply(reply);
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
