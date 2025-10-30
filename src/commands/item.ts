import { AttachmentBuilder, EmbedBuilder, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
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
  images: ItemRelation<{
    path: string | null;
    type: string | null;
  }>;
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

type StorageBucketApi = ReturnType<SupabaseClient['storage']['from']>;

type ImageAsset = {
  type: string;
  attachment: AttachmentBuilder;
  attachmentName: string;
};

function resolveImageExtension(objectPath: string, mimeType?: string): string {
  const ext = path.extname(objectPath);
  if (ext) {
    return ext.startsWith('.') ? ext : `.${ext}`;
  }

  if (mimeType) {
    if (mimeType.includes('png')) return '.png';
    if (mimeType.includes('jpeg')) return '.jpg';
    if (mimeType.includes('jpg')) return '.jpg';
    if (mimeType.includes('gif')) return '.gif';
    if (mimeType.includes('webp')) return '.webp';
  }

  return '.png';
}

function resolveExpiresInSeconds(): number | null {
  const rawValue = process.env.SUPABASE_ITEM_IMAGE_TTL_SECONDS;
  if (!rawValue) return null;

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

async function loadImageAssets(options: {
  item: ItemRow;
  storageBucket: StorageBucketApi;
  imageBucket: string;
  max: number;
}): Promise<ImageAsset[]> {
  const { item, storageBucket, imageBucket, max } = options;
  if (max <= 0) return [];

  const assets: ImageAsset[] = [];
  const images = toArray(item.images);
  const expiresInOverride = resolveExpiresInSeconds();

  for (let index = 0; index < images.length && assets.length < max; index += 1) {
    const image = images[index];
    const rawPath = image?.path?.trim();
    if (!rawPath) continue;

    let objectPath = rawPath.replace(/^\/+/, '');
    if (objectPath.startsWith(`${imageBucket}/`)) {
      objectPath = objectPath.slice(imageBucket.length + 1);
    }

    try {
      const { data: signedData, error: signedError } = await storageBucket.createSignedUrl(
        objectPath,
        expiresInOverride ?? 60
      );

      if (signedError || !signedData?.signedUrl) {
        console.warn('[command:item] Failed to create signed image URL', {
          path: objectPath,
          error: signedError,
        });
        continue;
      }

      const response = await fetch(signedData.signedUrl);
      if (!response.ok) {
        console.warn('[command:item] Failed to download image', {
          path: objectPath,
          status: response.status,
          statusText: response.statusText,
        });
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const typeLabel = (image?.type ?? 'Bild').trim() || 'Bild';
      const mimeType = response.headers.get('content-type') ?? undefined;
      const extension = resolveImageExtension(objectPath, mimeType);
      const attachmentName = `${item.id}-${assets.length + 1}${extension}`;

      assets.push({
        type: typeLabel,
        attachmentName,
        attachment: new AttachmentBuilder(buffer, { name: attachmentName }),
      });
    } catch (error) {
      console.warn('[command:item] Unexpected error while preparing image', { error, path: objectPath });
    }
  }

  return assets;
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
      images:item_images(path, type),
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
  const supabase = getSupabaseClient();
  const imageBucket = process.env.SUPABASE_ITEM_IMAGE_BUCKET ?? 'item-images';
  const storageBucket = supabase.storage.from(imageBucket);

  try {
    const items = await fetchItems({ name });
    if (items.length === 0) {
      await interaction.editReply('Keine Items mit diesen Kriterien gefunden.');
      return;
    }

    const embedEntries: Array<{ embed: EmbedBuilder; attachment?: AttachmentBuilder }> = [];
    let attachmentsRemaining = 10;
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
          .map(entry => `• ${entry.label} LVL ${entry.level}`)
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
        .addFields(fields);

      const createdAt = item.created_at ? new Date(item.created_at) : null;
      if (createdAt && !Number.isNaN(createdAt.getTime())) {
        embed.setTimestamp(createdAt);
      }

      const entry: { embed: EmbedBuilder; attachment?: AttachmentBuilder } = { embed };
      embedEntries.push(entry);
      embedsRemaining -= 1;

      if (attachmentsRemaining <= 0 || embedsRemaining < 0) {
        continue;
      }

      const maxImagesForItem = Math.min(attachmentsRemaining, 1 + embedsRemaining);
      if (maxImagesForItem <= 0) {
        continue;
      }

      const imageAssets = await loadImageAssets({
        item,
        storageBucket,
        imageBucket,
        max: maxImagesForItem,
      });

      if (imageAssets.length === 0) {
        continue;
      }

      const [firstAsset, ...restAssets] = imageAssets;
      if (firstAsset) {
        entry.attachment = firstAsset.attachment;
        embed.setImage(`attachment://${firstAsset.attachmentName}`);
        attachmentsRemaining -= 1;
      }

      let additionalIndex = 2;
      for (const asset of restAssets) {
        if (attachmentsRemaining <= 0 || embedsRemaining <= 0) break;

        const label = asset.type.charAt(0).toUpperCase() + asset.type.slice(1);
        const imageEmbed = new EmbedBuilder()
          .setTitle(`${item.name} — ${label} ${additionalIndex}`)
          .setColor(0x2b2d31)
          .setImage(`attachment://${asset.attachmentName}`);

        embedEntries.push({ embed: imageEmbed, attachment: asset.attachment });
        attachmentsRemaining -= 1;
        embedsRemaining -= 1;
        additionalIndex += 1;
      }
    }

    const embeds = embedEntries.map(entry => entry.embed);
    const files = embedEntries.flatMap(entry => (entry.attachment ? [entry.attachment] : []));

    await interaction.editReply(files.length > 0 ? { embeds, files } : { embeds });
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
