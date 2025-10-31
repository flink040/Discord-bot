import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getSupabaseClient } from '../supabase';

const data = new SlashCommandBuilder()
  .setName('buy')
  .setDescription('Fügt ein Item zu deinen Marktplatz-Gesuchen hinzu.')
  .addStringOption(option =>
    option
      .setName('item')
      .setDescription('Name oder ID des Items, das du suchst.')
      .setRequired(true)
      .setMaxLength(128),
  )
  .addIntegerOption(option =>
    option
      .setName('quantity')
      .setDescription('Gewünschte Stückzahl (optional).')
      .setMinValue(1),
  )
  .addIntegerOption(option =>
    option
      .setName('price_min')
      .setDescription('Minimaler Preis in Smaragden (optional).')
      .setMinValue(0),
  )
  .addIntegerOption(option =>
    option
      .setName('price_max')
      .setDescription('Maximaler Preis in Smaragden (optional).')
      .setMinValue(0),
  )
  .addStringOption(option =>
    option
      .setName('contact')
      .setDescription('Wie man dich erreichen kann (optional).')
      .setMaxLength(180),
  )
  .addStringOption(option =>
    option
      .setName('notes')
      .setDescription('Weitere Informationen zu deinem Gesuch (optional).')
      .setMaxLength(2000),
  );

type UserRow = {
  id: string;
};

type ItemRow = {
  id: string;
  name: string;
};

async function fetchUserId(discordId: string): Promise<UserRow | null> {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase
    .from('users')
    .select('id')
    .eq('discord_id', discordId)
    .maybeSingle<UserRow>();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return row ?? null;
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function isUuid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value,
  );
}

async function fetchItem(term: string): Promise<ItemRow | null> {
  const supabase = getSupabaseClient();

  if (isUuid(term)) {
    const { data: exactIdRow, error: exactIdError } = await supabase
      .from('items')
      .select('id, name')
      .eq('status', 'approved')
      .eq('id', term)
      .maybeSingle<ItemRow>();

    if (exactIdError && exactIdError.code !== 'PGRST116') {
      throw exactIdError;
    }

    if (exactIdRow) {
      return exactIdRow;
    }
  }

  const escapedLike = escapeLikePattern(term);

  const { data: exactNameRow, error: exactNameError } = await supabase
    .from('items')
    .select('id, name')
    .eq('status', 'approved')
    .ilike('name', escapedLike)
    .maybeSingle<ItemRow>();

  if (exactNameError && exactNameError.code !== 'PGRST116') {
    throw exactNameError;
  }

  if (exactNameRow) {
    return exactNameRow;
  }

  const { data: row, error } = await supabase
    .from('items')
    .select('id, name')
    .eq('status', 'approved')
    .ilike('name', `%${escapedLike}%`)
    .order('name', { ascending: true })
    .limit(1)
    .maybeSingle<ItemRow>();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return row ?? null;
}

async function findExistingIntent(userId: string, itemId: string) {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase
    .from('item_trade_intents')
    .select('id')
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .eq('intent_type', 'buy')
    .maybeSingle<{ id: string }>();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return row ?? null;
}

function normalizeString(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const execute = async (interaction: ChatInputCommandInteraction) => {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: '❌ Dieser Befehl kann nur innerhalb eines Servers verwendet werden.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const itemTermRaw = interaction.options.getString('item', true);
  const itemTerm = itemTermRaw.trim();

  if (!itemTerm) {
    await interaction.reply({
      content: '❌ Bitte gib ein gültiges Item an.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const quantity = interaction.options.getInteger('quantity');
  const priceMin = interaction.options.getInteger('price_min');
  const priceMax = interaction.options.getInteger('price_max');
  const contact = normalizeString(interaction.options.getString('contact'));
  const notes = normalizeString(interaction.options.getString('notes'));

  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    await interaction.reply({
      content: '❌ Der minimale Preis darf nicht höher als der maximale Preis sein.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const userRow = await fetchUserId(interaction.user.id);
    if (!userRow) {
      await interaction.editReply(
        '❌ Dein Discord-Account ist nicht mit einem Minecraft-Account verknüpft. Bitte verwende zuerst `/verify`.',
      );
      return;
    }

    const itemRow = await fetchItem(itemTerm);
    if (!itemRow) {
      await interaction.editReply('❌ Dieses Item konnte nicht gefunden werden oder ist noch nicht freigeschaltet.');
      return;
    }

    const payload = {
      quantity: quantity ?? null,
      price_min: priceMin ?? null,
      price_max: priceMax ?? null,
      contact_method: contact,
      notes,
      is_active: true,
    } as const;

    const existing = await findExistingIntent(userRow.id, itemRow.id);
    const supabase = getSupabaseClient();

    if (existing) {
      const { error: updateError } = await supabase
        .from('item_trade_intents')
        .update(payload)
        .eq('id', existing.id);

      if (updateError) {
        throw updateError;
      }

      await interaction.editReply(
        `✅ Dein Gesuch für **${itemRow.name}** wurde aktualisiert und ist nun aktiv.`,
      );
      return;
    }

    const { error: insertError } = await supabase.from('item_trade_intents').insert({
      item_id: itemRow.id,
      user_id: userRow.id,
      intent_type: 'buy',
      ...payload,
    });

    if (insertError) {
      throw insertError;
    }

    await interaction.editReply(`✅ **${itemRow.name}** wurde zu deinen Gesuchen hinzugefügt.`);
  } catch (error) {
    console.error('[buy] Failed to process request', error);
    await interaction.editReply('❌ Beim Speichern deines Gesuchs ist ein Fehler aufgetreten. Bitte versuche es später erneut.');
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
