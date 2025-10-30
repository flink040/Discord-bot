import { EmbedBuilder, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CommandDef } from '../types/Command';
import { getSupabaseClient } from '../supabase';

const DEFAULT_LIMIT = 3;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

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
  url: string;
};

function resolveExpiresInSeconds(): number | null {
  const rawValue = process.env.SUPABASE_ITEM_IMAGE_TTL_SECONDS;
  if (!rawValue) return null;

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function resolveObjectPathCandidates(rawPath: string, bucket: string): string[] {
  const candidates = new Set<string>();

  const trimmedBucket = bucket.trim().replace(/^\/+|\/+$/g, '');
  const pushCandidate = (value: string | null | undefined) => {
    if (!value) return;
    const normalized = value.trim().replace(/^\/+/, '');
    if (normalized) {
      candidates.add(normalized);
    }
  };

  const tryPushWithVariants = (value: string) => {
    pushCandidate(value);

    if (trimmedBucket) {
      if (value.startsWith(`${trimmedBucket}/`)) {
        pushCandidate(value.slice(trimmedBucket.length + 1));
      } else {
        pushCandidate(`${trimmedBucket}/${value}`);
      }
    }

    if (value.startsWith('public/')) {
      const withoutPublic = value.slice('public/'.length);
      pushCandidate(withoutPublic);

      if (trimmedBucket) {
        if (withoutPublic.startsWith(`${trimmedBucket}/`)) {
          pushCandidate(withoutPublic.slice(trimmedBucket.length + 1));
        } else {
          pushCandidate(`${trimmedBucket}/${withoutPublic}`);
        }
      }
    } else {
      pushCandidate(`public/${value}`);

      if (trimmedBucket) {
        if (value.startsWith(`${trimmedBucket}/`)) {
          pushCandidate(`public/${value.slice(trimmedBucket.length + 1)}`);
        } else {
          pushCandidate(`public/${trimmedBucket}/${value}`);
        }
      }
    }
  };

  const directPath = rawPath.trim();
  if (!directPath) {
    return [];
  }

  try {
    const parsedUrl = new URL(directPath);
    const pathname = parsedUrl.pathname.replace(/^\/+/, '');
    const storagePrefix = 'storage/v1/object/';

    if (pathname.startsWith(storagePrefix)) {
      tryPushWithVariants(pathname.slice(storagePrefix.length));
    }

    tryPushWithVariants(pathname);
  } catch {
    tryPushWithVariants(directPath.replace(/^\/+/, ''));
  }

  return Array.from(candidates);
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
  const expiresInOverride = resolveExpiresInSeconds() ?? DEFAULT_SIGNED_URL_TTL_SECONDS;

  for (let index = 0; index < images.length && assets.length < max; index += 1) {
    const image = images[index];
    const rawPath = image?.path?.trim();
    if (!rawPath) continue;

    const objectPathCandidates = resolveObjectPathCandidates(rawPath, imageBucket);
    if (objectPathCandidates.length === 0) continue;

    let selectedSignedUrl: { url: string; objectPath: string } | null = null;

    for (const candidate of objectPathCandidates) {
      try {
        const { data: signedData, error: signedError } = await storageBucket.createSignedUrl(
          candidate,
          expiresInOverride
        );

        if (signedError || !signedData?.signedUrl) {
          console.warn('[command:item] Failed to create signed image URL', {
            path: candidate,
            error: signedError,
          });
          continue;
        }

        selectedSignedUrl = {
          url: signedData.signedUrl,
          objectPath: candidate,
        };
        break;
      } catch (error) {
        console.warn('[command:item] Unexpected error while signing image URL', {
          error,
          path: candidate,
        });
      }
    }

    if (!selectedSignedUrl) {
      continue;
    }

    const typeLabel = (image?.type ?? 'Bild').trim() || 'Bild';

    assets.push({
      type: typeLabel,
      url: selectedSignedUrl.url,
    });
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
        .addFields(fields);

      const createdAt = item.created_at ? new Date(item.created_at) : null;
      if (createdAt && !Number.isNaN(createdAt.getTime())) {
        embed.setTimestamp(createdAt);
      }

      embeds.push(embed);
      embedsRemaining -= 1;

      const maxImagesForItem = embedsRemaining + 1;
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
        embed.setImage(firstAsset.url);
      }

      let additionalIndex = 2;
      for (const asset of restAssets) {
        if (embedsRemaining <= 0) break;

        const label = asset.type.charAt(0).toUpperCase() + asset.type.slice(1);
        const imageEmbed = new EmbedBuilder()
          .setTitle(`${item.name} — ${label} ${additionalIndex}`)
          .setColor(0x2b2d31)
          .setImage(asset.url);

        embeds.push(imageEmbed);
        embedsRemaining -= 1;
        additionalIndex += 1;
      }
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
