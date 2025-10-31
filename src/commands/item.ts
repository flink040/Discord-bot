import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  escapeMarkdown,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type MessageComponentInteraction,
} from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getSupabaseClient } from '../supabase';

const COMMAND_ID = 'item';
const ITEM_URL_BASE = 'https://op-item-db.com/items';
const DISABLE_AFTER_MS = 120_000;

const rarityColorMap = new Map<string, number>([
  ['jackpot', 0xff006e],
  ['legendär', 0xffc300],
  ['legendary', 0xffc300],
  ['episch', 0x8e44ad],
  ['epic', 0x8e44ad],
  ['selten', 0x1abc9c],
  ['rare', 0x1abc9c],
  ['gewöhnlich', 0x95a5a6],
  ['common', 0x95a5a6],
]);
const DEFAULT_RARITY_COLOR = 0x00e6cc;
const DEFAULT_IMAGE_BUCKET = 'item-assets';

const numberFormatter = new Intl.NumberFormat('de-DE', {
  maximumFractionDigits: 0,
});
const dateFormatter = new Intl.DateTimeFormat('de-DE');

function createItemSupabaseClient() {
  return getSupabaseClient();
}

function resolveRarityColor(label: string | null, slug: string | null): number {
  const candidates = [label, slug]
    .map(value => value?.toLowerCase().trim())
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const color = rarityColorMap.get(candidate);
    if (typeof color === 'number') {
      return color;
    }
  }

  return DEFAULT_RARITY_COLOR;
}

type ItemRelation<T> = T | T[] | null;

type ItemImageRow = {
  type: string | null;
  path: string | null;
};

type ItemRow = {
  id: string;
  slug: string | null;
  name: string;
  origin: string | null;
  view_count: number | null;
  created_at: string | null;
  rarity: ItemRelation<{ label: string | null; slug: string | null }>;
  item_type: ItemRelation<{ label: string | null; slug: string | null }>;
  chest: ItemRelation<{ label: string | null }>;
  signatures: ItemRelation<{ signer_name: string | null }>;
  enchantments: ItemRelation<{
    level: number | null;
    enchantment: ItemRelation<{ label: string | null }>;
  }>;
  effects: ItemRelation<{
    effect: ItemRelation<{ label: string | null }>;
  }>;
  images: ItemRelation<ItemImageRow>;
  uploader: ItemRelation<{
    discord_username: string | null;
    minecraft_username: string | null;
  }>;
};

type ImageType = 'lore' | 'ingame';

type NormalizedItem = {
  id: string;
  name: string;
  rarityLabel: string | null;
  raritySlug: string | null;
  typeLabel: string | null;
  origin: string | null;
  chestLabel: string | null;
  signatures: string[];
  enchantments: { name: string; level: number }[];
  effects: string[];
  images: Partial<Record<ImageType, string | null>>;
  preferredImage: string | null;
  defaultImageType: ImageType | null;
  uploaderName: string | null;
  createdAt: Date | null;
  viewCount: number | null;
};

type TabId = 'details' | 'enchantments' | 'effects' | 'images';

type ItemState = {
  item: NormalizedItem;
  activeTab: TabId;
  activeImage: ImageType | null;
  channelId: string | null;
  messageId: string;
};

const itemStates = new Map<string, ItemState>();
const disableTimers = new Map<string, NodeJS.Timeout>();

function unwrapSingle<T>(relation: ItemRelation<T>): T | null {
  if (!relation) return null;
  if (Array.isArray(relation)) {
    return relation[0] ?? null;
  }
  return relation;
}

function relationToArray<T>(relation: ItemRelation<T>): T[] {
  if (!relation) return [];
  return Array.isArray(relation) ? relation : [relation];
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

type StorageLocation = {
  bucket: string;
  path: string;
};

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

function sanitizeBucket(value: string): string {
  return value.replace(/^\/+|\/+$/g, '').trim();
}

function resolveConfiguredBucket(): string | null {
  const configured = (process.env.SUPABASE_ITEM_IMAGE_BUCKET ?? process.env.PUBLIC_SUPABASE_ITEM_IMAGE_BUCKET ?? '').trim();
  const bucket = sanitizeBucket(configured || DEFAULT_IMAGE_BUCKET);
  return bucket || null;
}

function normalizeStoragePath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\?.*$/, '')
    .replace(/^https?:\/\/[^/]+\/storage\/v1\/object\/(?:public|sign)\//i, '')
    .replace(/^storage\/v1\/object\/(?:public|sign)\//i, '')
    .replace(/^public\//i, '')
    .replace(/^\/+/, '');
}

function buildStorageLocationCandidates(rawPath: string, fallbackBucket: string): StorageLocation[] {
  const normalizedPath = normalizeStoragePath(rawPath);
  if (!normalizedPath) {
    return [];
  }

  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) {
    return [];
  }

  const fallback = sanitizeBucket(fallbackBucket);
  const candidates: StorageLocation[] = [];
  const seen = new Set<string>();

  const pushCandidate = (bucket: string, pathSegments: string[]) => {
    const sanitizedBucket = sanitizeBucket(bucket);
    const path = pathSegments.filter(Boolean).join('/');
    if (!sanitizedBucket || !path) {
      return;
    }
    const key = `${sanitizedBucket.toLowerCase()}/${path.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ bucket: sanitizedBucket, path });
  };

  if (fallback) {
    if (segments[0].toLowerCase() === fallback.toLowerCase()) {
      pushCandidate(segments[0], segments.slice(1));
    }
    pushCandidate(fallback, segments);
  }

  if (segments.length > 1) {
    pushCandidate(segments[0], segments.slice(1));
  } else if (fallback) {
    pushCandidate(fallback, segments);
  }

  return candidates;
}

function encodeStoragePath(path: string): string {
  return path
    .split('/')
    .map(segment => {
      const trimmed = segment.trim();
      if (!trimmed) return '';
      try {
        return encodeURIComponent(decodeURIComponent(trimmed));
      } catch {
        return encodeURIComponent(trimmed);
      }
    })
    .join('/');
}

function buildPublicStorageUrl(rawPath: string, fallbackBucket: string): string | null {
  const baseUrl = (process.env.PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '').trim();
  if (!baseUrl) {
    return null;
  }

  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const sanitizedBucket = sanitizeBucket(fallbackBucket);
  if (!sanitizedBucket) {
    return null;
  }

  const normalizedPath = normalizeStoragePath(rawPath);
  if (!normalizedPath) {
    return null;
  }

  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  let pathSegments = segments;
  if (segments[0].toLowerCase() === sanitizedBucket.toLowerCase()) {
    pathSegments = segments.slice(1);
  }

  const encodedPath = encodeStoragePath([sanitizedBucket, ...pathSegments].join('/'));
  if (!encodedPath) {
    return null;
  }

  return `${normalizedBase}/storage/v1/object/public/${encodedPath}`;
}

async function resolveImageUrl(image: ItemImageRow | null): Promise<string | null> {
  if (!image) return null;
  const candidate = image.path?.trim();
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate)) {
    return candidate;
  }

  const configuredBucket = resolveConfiguredBucket();
  if (!configuredBucket) {
    return null;
  }

  const candidates = buildStorageLocationCandidates(candidate, configuredBucket);
  if (candidates.length === 0) {
    return null;
  }

  const client = createItemSupabaseClient();

  for (const location of candidates) {
    try {
      const { data, error } = await client.storage
        .from(location.bucket)
        .createSignedUrl(location.path, SIGNED_URL_TTL_SECONDS);
      if (error) {
        console.error(
          `[command:${COMMAND_ID}] Failed to sign storage object ${location.bucket}/${location.path}:`,
          error,
        );
        continue;
      }
      if (data?.signedUrl) {
        return data.signedUrl;
      }
    } catch (err) {
      console.error(
        `[command:${COMMAND_ID}] Unexpected error while signing storage object ${location.bucket}/${location.path}:`,
        err,
      );
    }
  }

  const fallbackPublicUrl = buildPublicStorageUrl(candidate, configuredBucket);
  if (fallbackPublicUrl) {
    return fallbackPublicUrl;
  }

  return null;
}

function deriveUploaderName(relation: ItemRelation<{
  discord_username: string | null;
  minecraft_username: string | null;
}>): string | null {
  const uploader = unwrapSingle(relation);
  if (!uploader) return null;
  const candidates = [
    uploader.minecraft_username,
    uploader.discord_username,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

async function normalizeItem(row: ItemRow): Promise<NormalizedItem> {
  const rarity = unwrapSingle(row.rarity);
  const itemType = unwrapSingle(row.item_type);
  const chest = unwrapSingle(row.chest);
  const images = relationToArray(row.images);
  const loreImage = images.find(image => image?.type === 'lore') ?? null;
  const ingameImage = images.find(image => image?.type === 'ingame') ?? null;
  const [loreUrl, ingameUrl] = await Promise.all([
    resolveImageUrl(loreImage),
    resolveImageUrl(ingameImage),
  ]);

  let preferredImage: string | null = null;
  let defaultImageType: ImageType | null = null;
  if (ingameUrl) {
    preferredImage = ingameUrl;
    defaultImageType = 'ingame';
  } else if (loreUrl) {
    preferredImage = loreUrl;
    defaultImageType = 'lore';
  }

  const enchantments = relationToArray(row.enchantments)
    .map(entry => {
      const info = unwrapSingle(entry.enchantment);
      if (!info?.label) return null;
      const level = typeof entry.level === 'number' ? entry.level : null;
      if (level === null || level <= 0) return null;
      return { name: info.label.trim(), level };
    })
    .filter((value): value is { name: string; level: number } => Boolean(value))
    .sort((a, b) => a.name.localeCompare(b.name, 'de-DE'));

  const signatures = relationToArray(row.signatures)
    .map(signature => signature?.signer_name?.trim())
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => a.localeCompare(b, 'de-DE'));

  const effects = relationToArray(row.effects)
    .map(effectRelation => {
      const info = unwrapSingle(effectRelation.effect);
      return info?.label?.trim() ?? null;
    })
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => a.localeCompare(b, 'de-DE'));

  const createdAt = row.created_at ? new Date(row.created_at) : null;
  const validCreatedAt = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null;

  const viewCount = parseNumber(row.view_count);

  return {
    id: row.id,
    name: row.name,
    rarityLabel: rarity?.label ?? null,
    raritySlug: rarity?.slug ?? null,
    typeLabel: itemType?.label ?? null,
    origin: row.origin ?? null,
    chestLabel: chest?.label ?? null,
    signatures,
    enchantments,
    effects,
    images: {
      lore: loreUrl,
      ingame: ingameUrl,
    },
    preferredImage,
    defaultImageType,
    uploaderName: deriveUploaderName(row.uploader),
    createdAt: validCreatedAt,
    viewCount,
  };
}

function buildItemUrl(item: NormalizedItem): string {
  return `${ITEM_URL_BASE}/${encodeURIComponent(item.id.trim())}`;
}

function formatDetailsField(item: NormalizedItem): string {
  const type = item.typeLabel?.trim() || '—';
  const rarity = item.rarityLabel?.trim() || 'Unbekannt';
  const origin = item.origin?.trim() || '—';
  const chest = item.chestLabel?.trim() || 'Keine Zuordnung';
  return [
    `• **Item-Typ:** ${type}`,
    `• **Seltenheit:** \`${rarity}\``,
    `• **Herkunft:** ${origin}`,
    `• **Truhe:** ${chest}`,
  ].join('\n');
}

function toRomanNumeral(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return String(value);
  }
  const numerals: Array<[number, string]> = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let remaining = Math.floor(value);
  let result = '';
  for (const [arabic, roman] of numerals) {
    while (remaining >= arabic) {
      result += roman;
      remaining -= arabic;
    }
  }
  return result || String(value);
}

function buildEnchantmentsValue(item: NormalizedItem): string {
  if (item.enchantments.length === 0) {
    return 'Keine Verzauberungen eingetragen.';
  }
  return item.enchantments
    .map(entry => `• **${entry.name}** ${toRomanNumeral(entry.level)}`)
    .join('\n');
}

function buildEffectsValue(item: NormalizedItem): string | null {
  if (item.effects.length === 0) {
    return null;
  }
  return item.effects.map(effect => `• ${effect}`).join('\n');
}

function buildImagesDescription(item: NormalizedItem, activeImage: ImageType | null): string {
  const available = [item.images.ingame, item.images.lore].filter(Boolean).length;
  if (available === 0) {
    return 'Keine Bilder vorhanden.';
  }

  const label = activeImage ?? item.defaultImageType;
  if (!label || !item.images[label]) {
    return 'Keine Bilder vorhanden.';
  }

  return label === 'ingame' ? 'Ingame-Ansicht' : 'Lore-Ansicht';
}

function buildFooter(item: NormalizedItem): string | null {
  const parts: string[] = [];
  if (item.uploaderName) {
    parts.push(`Hochgeladen von ${item.uploaderName}`);
  }
  if (item.createdAt) {
    parts.push(dateFormatter.format(item.createdAt));
  }
  if (typeof item.viewCount === 'number') {
    parts.push(`${numberFormatter.format(item.viewCount)} Aufrufe`);
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(' • ');
}

function resolveEmbedImage(item: NormalizedItem, tab: TabId, activeImage: ImageType | null): string | null {
  if (tab !== 'images') {
    return null;
  }

  const label = activeImage ?? item.defaultImageType;
  if (!label) {
    return null;
  }

  return item.images[label] ?? null;
}

function buildEmbed(state: ItemState): EmbedBuilder {
  const { item, activeTab, activeImage } = state;
  const embed = new EmbedBuilder()
    .setTitle(item.name)
    .setColor(resolveRarityColor(item.rarityLabel, item.raritySlug))
    .setURL(buildItemUrl(item))
    .setDescription(null);

  const imageUrl = resolveEmbedImage(item, activeTab, activeImage);
  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  const footer = buildFooter(item);
  if (footer) {
    embed.setFooter({ text: footer });
  }

  switch (activeTab) {
    case 'details': {
      embed.addFields({ name: 'Item-Details', value: formatDetailsField(item) });
      if (item.signatures.length > 0) {
        embed.addFields({ name: 'Signaturen', value: item.signatures.map(name => `\`${name}\``).join(' ') });
      }
      break;
    }
    case 'enchantments': {
      embed.addFields({ name: 'Verzauberungen', value: buildEnchantmentsValue(item) });
      break;
    }
    case 'effects': {
      const value = buildEffectsValue(item);
      if (value) {
        embed.addFields({ name: 'Effekte', value });
      } else {
        embed.setDescription('Keine Effekte eingetragen.');
      }
      break;
    }
    case 'images': {
      embed.setDescription(buildImagesDescription(item, activeImage));
      break;
    }
    default:
      break;
  }

  return embed;
}

function createTabButtons(state: ItemState, disabled: boolean): ActionRowBuilder<ButtonBuilder> {
  const buttons: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId(`${COMMAND_ID}:tab:details`)
      .setLabel('Details')
      .setStyle(state.activeTab === 'details' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${COMMAND_ID}:tab:enchantments`)
      .setLabel('Verzauberungen')
      .setStyle(state.activeTab === 'enchantments' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${COMMAND_ID}:tab:effects`)
      .setLabel('Effekte')
      .setStyle(state.activeTab === 'effects' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${COMMAND_ID}:tab:images`)
      .setLabel('Bilder')
      .setStyle(state.activeTab === 'images' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
  ];

  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

function createImageButtons(state: ItemState, disabled: boolean): ActionRowBuilder<ButtonBuilder> {
  const { item } = state;
  const loreAvailable = Boolean(item.images.lore);
  const ingameAvailable = Boolean(item.images.ingame);
  const viewingImages = state.activeTab === 'images';

  const loreButton = new ButtonBuilder()
    .setCustomId(`${COMMAND_ID}:image:lore`)
    .setLabel('Lore')
    .setStyle(state.activeImage === 'lore' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(disabled || !viewingImages || !loreAvailable);

  const ingameButton = new ButtonBuilder()
    .setCustomId(`${COMMAND_ID}:image:ingame`)
    .setLabel('Ingame')
    .setStyle(state.activeImage === 'ingame' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(disabled || !viewingImages || !ingameAvailable);

  const itemUrl = buildItemUrl(item);

  const linkButton = disabled
    ? new ButtonBuilder()
        .setCustomId(`${COMMAND_ID}:link:disabled`)
        .setLabel('Mehr Anzeigen')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    : new ButtonBuilder().setLabel('Mehr Anzeigen').setStyle(ButtonStyle.Link).setURL(itemUrl);

  return new ActionRowBuilder<ButtonBuilder>().addComponents([loreButton, ingameButton, linkButton]);
}

function buildComponents(state: ItemState, options?: { disabled?: boolean }): ActionRowBuilder<ButtonBuilder>[] {
  const disabled = options?.disabled ?? false;
  return [createTabButtons(state, disabled), createImageButtons(state, disabled)];
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/\)/g, '\\)').replace(/\(/g, '\\(');
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const ITEM_SELECT = `id, name, origin, view_count, created_at,
  rarity:rarities(label, slug),
  item_type:item_types(label, slug),
  chest:chests(label),
  signatures:item_signatures(signer_name),
  enchantments:item_enchantments(level, enchantment:enchantments(label)),
  effects:item_item_effects(effect:item_effects(label)),
  images:item_images(type, path),
  uploader:users!items_created_by_fkey(discord_username, minecraft_username)`;

function buildSearchFilter(term: string): string {
  const parts: string[] = [];
  const escapedLike = escapeLikePattern(term);
  const escapedFilterValue = escapeFilterValue(term);
  parts.push(`name.ilike.%${escapedLike}%`);
  if (looksLikeUuid(term)) {
    parts.push(`id.eq.${escapedFilterValue}`);
  }
  return parts.join(',');
}

async function fetchItem(term: string): Promise<ItemRow | null> {
  const client = createItemSupabaseClient();
  const filter = buildSearchFilter(term);
  const query = client
    .from('items')
    .select(ITEM_SELECT)
    .eq('status', 'approved')
    .or(filter)
    .order('name', { ascending: true })
    .limit(1);

  const { data, error } = await query.maybeSingle<ItemRow>();
  if (error) {
    throw error;
  }
  return data ?? null;
}

async function searchItems(term: string, limit: number): Promise<Array<{ id: string; name: string }>> {
  const client = createItemSupabaseClient();
  const filter = buildSearchFilter(term);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 2_500);

  try {
    const { data, error } = await client
      .from('items')
      .select('id, name')
      .eq('status', 'approved')
      .or(filter)
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

function ensureState(messageId: string): ItemState | null {
  return itemStates.get(messageId) ?? null;
}

function storeState(messageId: string, state: ItemState) {
  itemStates.set(messageId, state);
}

function removeState(messageId: string) {
  const existingTimer = disableTimers.get(messageId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    disableTimers.delete(messageId);
  }
  itemStates.delete(messageId);
}

function scheduleDisable(message: Message, state: ItemState) {
  const existing = disableTimers.get(message.id);
  if (existing) {
    clearTimeout(existing);
  }

  const timeout = setTimeout(async () => {
    disableTimers.delete(message.id);
    removeState(message.id);
    try {
      await message.edit({ components: buildComponents(state, { disabled: true }) });
    } catch {
      // ignore edit errors (message deleted, missing permissions, ...)
    }
  }, DISABLE_AFTER_MS);

  disableTimers.set(message.id, timeout);
}

export const data = new SlashCommandBuilder()
  .setName(COMMAND_ID)
  .setDescription('Durchsucht die Item-Datenbank nach einem Eintrag.')
  .addStringOption(option =>
    option
      .setName('suche')
      .setDescription('Suche nach Name oder ID')
      .setRequired(true)
      .setAutocomplete(true),
  );

export const execute = async (interaction: ChatInputCommandInteraction) => {
  const term = interaction.options.getString('suche', true).trim();
  if (!term) {
    await interaction.reply({ content: 'Bitte gib einen Suchbegriff an.' });
    return;
  }

  await interaction.deferReply();

  try {
    const itemRow = await fetchItem(term);
    if (!itemRow) {
      await interaction.editReply(`Kein Item gefunden für **${escapeMarkdown(term)}**.`);
      return;
    }

    const item = await normalizeItem(itemRow);
    const state: ItemState = {
      item,
      activeTab: 'details',
      activeImage: item.defaultImageType,
      channelId: interaction.channelId ?? null,
      messageId: '',
    };

    const embed = buildEmbed(state);
    const components = buildComponents(state);

    const reply = (await interaction.editReply({ embeds: [embed], components })) as Message;
    state.messageId = reply.id;
    state.channelId = reply.channelId;
    storeState(reply.id, state);
    scheduleDisable(reply, state);
  } catch (err) {
    console.error(`[command:${COMMAND_ID}]`, err);
    await interaction.editReply('Beim Laden ist etwas schiefgelaufen.');
  }
};

function isTabId(value: string): value is TabId {
  return ['details', 'enchantments', 'effects', 'images'].includes(value);
}

function isImageType(value: string): value is ImageType {
  return value === 'lore' || value === 'ingame';
}

export const handleComponent = async (interaction: MessageComponentInteraction) => {
  if (!interaction.isButton()) {
    return;
  }

  const [command, action, value] = interaction.customId.split(':');
  if (command !== COMMAND_ID) {
    return;
  }

  const state = ensureState(interaction.message.id);
  if (!state) {
    await interaction.reply({ content: 'Diese Aktion ist nicht mehr verfügbar.', ephemeral: true });
    return;
  }

  if (action === 'tab' && value && isTabId(value)) {
    state.activeTab = value;
    if (value === 'images') {
      const current = state.activeImage;
      if (current && state.item.images[current]) {
        // keep current selection
      } else {
        const fallback = (['ingame', 'lore'] as const).find(type => state.item.images[type]);
        state.activeImage = fallback ?? null;
      }
    }
  } else if (action === 'image' && value && isImageType(value)) {
    if (state.item.images[value]) {
      state.activeImage = value;
    }
  } else if (action === 'link') {
    await interaction.reply({ content: 'Der Link ist nicht mehr verfügbar.', ephemeral: true });
    return;
  }

  const embed = buildEmbed(state);
  const components = buildComponents(state);
  await interaction.update({ embeds: [embed], components });
};

export const handleAutocomplete = async (interaction: AutocompleteInteraction) => {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'suche') {
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
    const uniqueValues = new Set<string>();
    const options = matches
      .map(match => {
        const optionValue = match.id;
        if (uniqueValues.has(optionValue)) {
          return null;
        }
        uniqueValues.add(optionValue);
        const label = match.name.trim() || match.id;
        return {
          name: label,
          value: optionValue,
        };
      })
      .filter((value): value is { name: string; value: string } => Boolean(value))
      .slice(0, 20);

    await interaction.respond(options);
  } catch (err) {
    console.error(`[autocomplete:${COMMAND_ID}]`, err);
    await interaction.respond([]).catch(() => {});
  }
};

export default {
  data: data.toJSON(),
  execute,
  handleComponent,
  handleAutocomplete,
} satisfies CommandDef;
