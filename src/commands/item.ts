import {
  EmbedBuilder,
  SlashCommandBuilder,
  time,
  type APIEmbedField,
  type ChatInputCommandInteraction,
} from 'discord.js';
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

function getEmbedColor(rarityLabel: string | null, stars: number): number {
  const normalizedRarity = rarityLabel?.toLowerCase();
  switch (normalizedRarity) {
    case 'gewöhnlich':
    case 'common':
      return 0x9d9d9d;
    case 'selten':
    case 'rare':
      return 0x0070dd;
    case 'episch':
    case 'epic':
      return 0xa335ee;
    case 'legendär':
    case 'legendary':
      return 0xff8000;
    default: {
      const starColors = [0x2f3136, 0x9d9d9d, 0xffffff, 0x1eff00, 0x0070dd, 0xa335ee, 0xff8000];
      const index = Math.min(Math.max(stars, 0), starColors.length - 1);
      return starColors[index];
    }
  }
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

    const embeds = items.map(item => {
      const rarityLabel = getRarityLabel(item);
      const embed = new EmbedBuilder()
        .setTitle(item.name)
        .setColor(getEmbedColor(rarityLabel, item.stars))
        .setFooter({ text: 'Itemdaten aus Supabase' });

      const descriptionParts: string[] = [];
      if (rarityLabel) {
        descriptionParts.push(`Seltenheit: **${rarityLabel}**`);
      }
      descriptionParts.push(`Sterne: ${formatStars(item.stars)}`);

      const fields: APIEmbedField[] = [];
      if (item.material) {
        fields.push({ name: 'Material', value: item.material, inline: true });
      }
      if (item.origin) {
        fields.push({ name: 'Herkunft', value: item.origin, inline: true });
      }

      if (fields.length > 0) {
        embed.addFields(fields);
      }

      if (item.created_at) {
        const createdAt = new Date(item.created_at);
        if (!Number.isNaN(createdAt.getTime())) {
          descriptionParts.push(`Hinzugefügt: ${time(createdAt, 'R')}`);
          embed.setTimestamp(createdAt);
        }
      }

      if (descriptionParts.length > 0) {
        embed.setDescription(descriptionParts.join('\n'));
      }

      return embed;
    });

    await interaction.editReply({ embeds });
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
