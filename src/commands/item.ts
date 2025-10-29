import { SlashCommandBuilder, time, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getSupabaseClient } from '../supabase';

const STATUSES = ['pending', 'approved', 'rejected'] as const;

export const data = new SlashCommandBuilder()
  .setName('item')
  .setDescription('Zeigt Items aus der Supabase-Datenbank an.')
  .addStringOption(option =>
    option
      .setName('name')
      .setDescription('Filtert nach Itemnamen (Teilzeichenfolge)')
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('status')
      .setDescription('Filtert nach Status (Standard: approved)')
      .setRequired(false)
      .addChoices(...STATUSES.map(status => ({ name: status, value: status })))
  )
  .addIntegerOption(option =>
    option
      .setName('limit')
      .setDescription('Anzahl der Items (1-5, Standard: 3)')
      .setMinValue(1)
      .setMaxValue(5)
      .setRequired(false)
  );

type ItemRow = {
  name: string;
  status: string;
  stars: number;
  material: string | null;
  origin: string | null;
  created_at: string | null;
  rarities: { label: string | null } | { label: string | null }[] | null;
};

function getRarityLabel(item: ItemRow): string | null {
  const rarity = item.rarities;
  if (!rarity) return null;
  if (Array.isArray(rarity)) {
    return rarity[0]?.label ?? null;
  }
  return rarity.label ?? null;
}

function formatStars(stars: number): string {
  if (stars <= 0) return 'Keine Sterne';
  const starCount = Math.min(stars, 10);
  return `${'★'.repeat(starCount)}${stars > starCount ? ` (+${stars - starCount})` : ''}`;
}

async function fetchItems({
  name,
  status,
  limit,
}: {
  name?: string | null;
  status: string;
  limit: number;
}): Promise<ItemRow[]> {
  const supabase = getSupabaseClient();

  let query = supabase
    .from('items')
    .select('name, status, stars, material, origin, created_at, rarities(label)')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (name) {
    query = query.ilike('name', `%${name}%`);
  }

  const { data: rows, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  return rows ?? [];
}

export const execute = async (interaction: ChatInputCommandInteraction) => {
  await interaction.deferReply();

  const name = interaction.options.getString('name');
  const status = interaction.options.getString('status') ?? 'approved';
  const limit = interaction.options.getInteger('limit') ?? 3;

  try {
    const items = await fetchItems({ name, status, limit });
    if (items.length === 0) {
      await interaction.editReply('Keine Items mit diesen Kriterien gefunden.');
      return;
    }

    const lines = items.map((item, idx) => {
      const parts = [`**${idx + 1}. ${item.name}**`];
      const rarityLabel = getRarityLabel(item);
      if (rarityLabel) {
        parts.push(`Seltenheit: ${rarityLabel}`);
      }
      parts.push(`Status: ${item.status}`);
      parts.push(`Sterne: ${formatStars(item.stars)}`);
      if (item.material) {
        parts.push(`Material: ${item.material}`);
      }
      if (item.origin) {
        parts.push(`Herkunft: ${item.origin}`);
      }
      if (item.created_at) {
        const createdAt = new Date(item.created_at);
        if (!Number.isNaN(createdAt.getTime())) {
          parts.push(`Erstellt: ${time(createdAt, 'R')}`);
        }
      }
      return parts.join('\n');
    });

    await interaction.editReply(lines.join('\n\n'));
  } catch (err) {
    console.error('[command:item]', err);
    if (err instanceof Error) {
      await interaction.editReply(`Fehler beim Laden der Items: ${err.message}`);
    } else {
      await interaction.editReply('Unbekannter Fehler beim Laden der Items.');
    }
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
