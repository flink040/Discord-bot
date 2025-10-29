import { SlashCommandBuilder, time, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getSupabaseClient } from '../supabase';

const DEFAULT_LIMIT = 3;

export const data = new SlashCommandBuilder()
  .setName('item')
  .setDescription('Zeigt Items aus der Supabase-Datenbank an.')
  .addStringOption(option =>
    option
      .setName('name')
      .setDescription('Filtert nach Itemnamen (Teilzeichenfolge)')
      .setRequired(false)
  );

type ItemRow = {
  name: string;
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
}: {
  name?: string | null;
}): Promise<ItemRow[]> {
  const supabase = getSupabaseClient();

  let query = supabase
    .from('items')
    .select('name, stars, material, origin, created_at, rarities(label)')
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(DEFAULT_LIMIT);

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

  try {
    const items = await fetchItems({ name });
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
