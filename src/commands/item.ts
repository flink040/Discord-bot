import { EmbedBuilder, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
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

type ItemRelation<T> = T | T[] | null;

type ItemRow = {
  id: string;
  name: string;
  stars: number;
  material: string | null;
  origin: string | null;
  created_at: string | null;
  rarity: ItemRelation<{ label: string | null; slug: string | null }>;
  type: ItemRelation<{ label: string | null; slug: string | null }>;
  chest: ItemRelation<{ label: string | null }>;
  signatures: ItemRelation<{ signer_name: string | null }>;
  enchantments: ItemRelation<{
    level: number | null;
    enchantment: ItemRelation<{ label: string | null; slug: string | null }>;
  }>;
  effects: ItemRelation<{
    level: number | null;
    effect: ItemRelation<{ label: string | null; slug: string | null }>;
  }>;
};

function getFirstRelation<T>(relation: ItemRelation<T>): T | null {
  if (!relation) return null;
  if (Array.isArray(relation)) {
    return relation[0] ?? null;
  }
  return relation;
}

function toArray<T>(relation: ItemRelation<T>): T[] {
  if (!relation) return [];
  return Array.isArray(relation) ? relation : [relation];
}

function formatStars(stars: number): string {
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
    .select(
      `id,
      name,
      stars,
      material,
      origin,
      created_at,
      rarity:rarities(label, slug),
      type:item_types(label, slug),
      chest:chests(label),
      signatures:item_signatures(signer_name),
      enchantments:item_enchantments(level, enchantment:enchantments(label, slug)),
      effects:item_item_effects(level, effect:item_effects(label, slug))`
    )
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

    const embeds: EmbedBuilder[] = [];
    let embedsRemaining = 10;

    for (const item of items) {
      if (embedsRemaining <= 0) break;

      const rarity = getFirstRelation(item.rarity);
      const type = getFirstRelation(item.type);
      const chest = getFirstRelation(item.chest);

      const details: string[] = [];
      if (type?.label) details.push(`**Item-Typ:** ${type.label}`);
      if (rarity?.label) details.push(`**Seltenheit:** ${rarity.label}`);
      if (item.stars > 0) details.push(`**Sterne:** ${formatStars(item.stars)}`);
      if (item.material) details.push(`**Material:** ${item.material}`);
      if (item.origin) details.push(`**Herkunft:** ${item.origin}`);
      if (chest?.label) details.push(`**Truhe:** ${chest.label}`);

      const signatureText =
        toArray(item.signatures)
          .map(signature => signature?.signer_name?.trim())
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .sort((a, b) => a.localeCompare(b, 'de-DE'))
          .map(value => `• ${value}`)
          .join('\n') || null;

      const enchantmentText =
        toArray(item.enchantments)
          .map(enchantment => {
            const enchantmentInfo = getFirstRelation(enchantment.enchantment);
            if (!enchantmentInfo?.label || !enchantment.level) return null;
            return { label: enchantmentInfo.label, level: enchantment.level };
          })
          .filter((value): value is { label: string; level: number } => value !== null)
          .sort((a, b) => a.label.localeCompare(b.label, 'de-DE'))
          .map(entry => {
            const level = Number(entry.level);
            const suffix = Number.isNaN(level) || level <= 1 ? '' : ` LVL ${level}`;
            return `• ${entry.label}${suffix}`;
          })
          .join('\n') || null;

      const effectText =
        toArray(item.effects)
          .map(effect => {
            const effectInfo = getFirstRelation(effect.effect);
            if (!effectInfo?.label || !effect.level) return null;
            return { label: effectInfo.label, level: effect.level };
          })
          .filter((value): value is { label: string; level: number } => value !== null)
          .sort((a, b) => a.label.localeCompare(b.label, 'de-DE'))
          .map(entry => `• ${entry.label} LVL ${entry.level}`)
          .join('\n') || null;

      const fields: { name: string; value: string }[] = [
        {
          name: 'Item-Details',
          value: details.length > 0 ? details.join('\n') : 'Keine Details verfügbar.',
        },
      ];

      if (signatureText) {
        fields.push({ name: 'Signaturen', value: signatureText });
      }

      if (enchantmentText) {
        fields.push({ name: 'Verzauberungen', value: enchantmentText });
      }

      if (effectText) {
        fields.push({ name: 'Effekte', value: effectText });
      }

      const embed = new EmbedBuilder()
        .setTitle(item.name)
        .setColor(0x2b2d31)
        .addFields(fields)
        .setDescription(`[Mehr Anzeigen](https://op-item-db.com/item/${item.id})`);

      const createdAt = item.created_at ? new Date(item.created_at) : null;
      if (createdAt && !Number.isNaN(createdAt.getTime())) {
        embed.setTimestamp(createdAt);
      }

      embeds.push(embed);
      embedsRemaining -= 1;
    }

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
