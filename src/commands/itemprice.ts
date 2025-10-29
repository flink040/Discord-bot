import { SlashCommandBuilder, time, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getSupabaseClient } from '../supabase';

const MAX_RESULTS = 5;

const currencyFormatter = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

type ItemRow = {
  id: string;
  name: string;
};

type ListingRow = {
  title: string;
  status: string;
  currency: string | null;
  starting_bid: number | null;
  current_bid: number | null;
  buyout_price: number | null;
  ends_at: string | null;
};

type MarketLinkRow = {
  status: string;
  confidence: number | null;
  source: string | null;
  auction_listings: ListingRow | ListingRow[] | null;
};

export const data = new SlashCommandBuilder()
  .setName('itemprice')
  .setDescription('Zeigt Preisdaten für ein Item anhand verknüpfter Auktionen an.')
  .addStringOption(option =>
    option
      .setName('name')
      .setDescription('Name des Items (Teilzeichenfolge)')
      .setRequired(true)
  );

async function findItemByName(name: string): Promise<ItemRow | null> {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase
    .from('items')
    .select('id, name')
    .eq('status', 'approved')
    .ilike('name', `%${name}%`)
    .order('name', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return row ?? null;
}

async function fetchMarketLinks(itemId: string): Promise<MarketLinkRow[]> {
  const supabase = getSupabaseClient();
  const { data: rows, error } = await supabase
    .from('item_market_links')
    .select(
      `status, confidence, source, auction_listings(title, status, currency, starting_bid, current_bid, buyout_price, ends_at)`
    )
    .eq('item_id', itemId)
    .eq('status', 'confirmed')
    .order('updated_at', { ascending: false })
    .limit(MAX_RESULTS);

  if (error) {
    throw new Error(error.message);
  }

  return rows ?? [];
}

function formatPrice(value: number | null, currency: string | null, label: string): string | null {
  if (value === null) return null;
  const formatted = currencyFormatter.format(Number(value));
  return `${label}: ${formatted}${currency ? ` ${currency}` : ''}`;
}

function resolveListing(link: MarketLinkRow): ListingRow | null {
  const listing = link.auction_listings;
  if (!listing) return null;
  if (Array.isArray(listing)) {
    return listing[0] ?? null;
  }
  return listing;
}

export const execute = async (interaction: ChatInputCommandInteraction) => {
  await interaction.deferReply();

  const name = interaction.options.getString('name', true);

  try {
    const item = await findItemByName(name);
    if (!item) {
      await interaction.editReply('Kein freigegebenes Item mit diesem Namen gefunden.');
      return;
    }

    const links = await fetchMarketLinks(item.id);
    if (links.length === 0) {
      await interaction.editReply(`Keine Preisdaten für **${item.name}** gefunden.`);
      return;
    }

    const lines = links.map((link, idx) => {
      const listing = resolveListing(link);
      if (!listing) {
        return `**${idx + 1}.** Verknüpfte Auktion konnte nicht geladen werden.`;
      }

      const parts = [`**${idx + 1}. ${listing.title}**`];
      parts.push(`Auktionsstatus: ${listing.status}`);

      const prices = [
        formatPrice(listing.starting_bid, listing.currency, 'Startgebot'),
        formatPrice(listing.current_bid, listing.currency, 'Aktuelles Gebot'),
        formatPrice(listing.buyout_price, listing.currency, 'Sofortkauf'),
      ].filter((value): value is string => value !== null);

      if (prices.length > 0) {
        parts.push(prices.join(' • '));
      }

      if (listing.ends_at) {
        const endsAt = new Date(listing.ends_at);
        if (!Number.isNaN(endsAt.getTime())) {
          parts.push(`Läuft ab: ${time(endsAt, 'R')}`);
        }
      }

      if (link.source) {
        parts.push(`Quelle: ${link.source}`);
      }

      if (link.confidence !== null) {
        parts.push(`Confidence: ${(link.confidence * 100).toFixed(0)}%`);
      }

      return parts.join('\n');
    });

    await interaction.editReply(lines.join('\n\n'));
  } catch (err) {
    console.error('[command:itemprice]', err);
    if (err instanceof Error) {
      await interaction.editReply(`Fehler beim Laden der Preisdaten: ${err.message}`);
    } else {
      await interaction.editReply('Unbekannter Fehler beim Laden der Preisdaten.');
    }
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;

