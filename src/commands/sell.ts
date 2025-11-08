import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getSupabaseClient } from '../supabase';

const PRICE_TYPES = ['negotiable', 'highest_bid', 'direct_sale'] as const;
type PriceType = (typeof PRICE_TYPES)[number];

function isPriceType(value: string | null): value is PriceType {
  return value !== null && PRICE_TYPES.includes(value as PriceType);
}

const data = new SlashCommandBuilder()
  .setName('sell')
  .setDescription('Fügt ein Item zu deinen Marktplatz-Angeboten hinzu.')
  .addStringOption(option =>
    option
      .setName('item')
      .setDescription('Name oder ID des Items, das du verkaufen möchtest.')
      .setRequired(true)
      .setMaxLength(128)
      .setAutocomplete(true),
  )
  .addIntegerOption(option =>
    option
      .setName('quantity')
      .setDescription('Stückzahl, die du verkaufen möchtest (optional).')
      .setMinValue(1),
  )
  .addIntegerOption(option =>
    option
      .setName('price')
      .setDescription('Verkaufspreis in Smaragden (optional).')
      .setMinValue(0),
  )
  .addStringOption(option =>
    option
      .setName('price_type')
      .setDescription('Preistyp (optional).')
      .addChoices(
        { name: 'VHB', value: 'negotiable' },
        { name: 'Höchstgebot', value: 'highest_bid' },
        { name: 'Direktverkauf', value: 'direct_sale' },
      ),
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

async function searchItems(term: string, limit: number): Promise<Array<{ id: string; name: string }>> {
  const supabase = getSupabaseClient();
  const escapedLike = escapeLikePattern(term);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);

  try {
    const { data, error } = await supabase
      .from('items')
      .select('id, name')
      .eq('status', 'approved')
      .or(
        [
          `name.ilike.%${escapedLike}%`,
          isUuid(term) ? `id.eq.${term}` : null,
        ]
          .filter((value): value is string => Boolean(value))
          .join(','),
      )
      .order('name', { ascending: true })
      .limit(limit)
      .abortSignal(controller.signal);

    if (error) {
      throw error;
    }

    return (data ?? []).map(row => ({ id: row.id, name: row.name }));
  } finally {
    clearTimeout(timeout);
  }
}

async function findExistingIntent(userId: string, itemId: string) {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase
    .from('item_trade_intents')
    .select('id')
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .eq('intent_type', 'sell')
    .maybeSingle<{ id: string }>();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return row ?? null;
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
  const price = interaction.options.getInteger('price');
  const priceTypeRaw = interaction.options.getString('price_type');
  const priceType = isPriceType(priceTypeRaw) ? priceTypeRaw : null;

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
      price: price ?? null,
      price_type: priceType,
      price_min: null,
      price_max: null,
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
        `✅ Dein Angebot für **${itemRow.name}** wurde aktualisiert und ist nun aktiv.`,
      );
      return;
    }

    const { error: insertError } = await supabase.from('item_trade_intents').insert({
      item_id: itemRow.id,
      user_id: userRow.id,
      intent_type: 'sell',
      ...payload,
    });

    if (insertError) {
      throw insertError;
    }

    await interaction.editReply(`✅ **${itemRow.name}** wurde zu deinen Angeboten hinzugefügt.`);
  } catch (error) {
    console.error('[sell] Failed to process request', error);
    await interaction.editReply('❌ Beim Speichern deines Angebots ist ein Fehler aufgetreten. Bitte versuche es später erneut.');
  }
};

export const handleAutocomplete = async (interaction: AutocompleteInteraction) => {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'item') {
    await interaction.respond([]).catch(() => {});
    return;
  }

  const term = String(focused.value ?? '').trim();
  if (!term) {
    await interaction.respond([]).catch(() => {});
    return;
  }

  try {
    const matches = await searchItems(term, 20);
    const unique = new Set<string>();
    const options = matches
      .map(match => {
        if (unique.has(match.id)) {
          return null;
        }
        unique.add(match.id);
        const label = match.name.trim() || match.id;
        return { name: label.slice(0, 100), value: match.id };
      })
      .filter((option): option is { name: string; value: string } => Boolean(option))
      .slice(0, 20);

    await interaction.respond(options);
  } catch (error) {
    console.error('[sell] Failed to provide autocomplete options', error);
    await interaction.respond([]).catch(() => {});
  }
};

export default { data: data.toJSON(), execute, handleAutocomplete } satisfies CommandDef;
