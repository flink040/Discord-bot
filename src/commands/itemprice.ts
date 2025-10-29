import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getSupabaseClient } from '../supabase';

const currencyFormatter = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

function displayCurrency(currency: string | null): string | null {
  if (!currency) return null;
  return currency.toLowerCase() === 'emerald' ? '$' : currency;
}

type ItemRow = {
  id: string;
  name: string;
};

type MarketLinkRow = {
  listing_id: string;
  auction_listings:
    | {
        currency: string | null;
      }
    | {
        currency: string | null;
      }[]
    | null;
};

type SnapshotRow = {
  listing_id: string;
  collected_at: string;
  current_bid: number | string | null;
};

export const data = new SlashCommandBuilder()
  .setName('itemprice')
  .setDescription('Zeigt aggregierte Preisdaten für ein Item an.')
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
    .select(`listing_id, auction_listings(currency)`)
    .eq('item_id', itemId)
    .eq('status', 'confirmed')
    .order('updated_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return rows ?? [];
}

async function fetchSnapshots(listingIds: string[]): Promise<SnapshotRow[]> {
  if (listingIds.length === 0) return [];

  const supabase = getSupabaseClient();
  const pageSize = 1000;
  const collected: SnapshotRow[] = [];

  for (let page = 0; ; page += 1) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data: rows, error } = await supabase
      .from('auction_snapshots')
      .select('listing_id, collected_at, current_bid')
      .in('listing_id', listingIds)
      .order('collected_at', { ascending: true })
      .range(from, to);

    if (error) {
      throw new Error(error.message);
    }

    if (!rows || rows.length === 0) {
      break;
    }

    collected.push(...rows);

    if (rows.length < pageSize) {
      break;
    }
  }

  return collected;
}

function normalizeNumber(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type BidSample = {
  amount: number;
  collectedAt: Date;
};

function extractBids(rows: SnapshotRow[]): BidSample[] {
  return rows
    .map(row => {
      const amount = normalizeNumber(row.current_bid);
      const collectedAt = new Date(row.collected_at);
      if (amount === null || Number.isNaN(collectedAt.getTime())) return null;
      return { amount, collectedAt } satisfies BidSample;
    })
    .filter((value): value is BidSample => value !== null)
    .sort((a, b) => a.collectedAt.getTime() - b.collectedAt.getTime());
}

function averageAmount(samples: BidSample[], days?: number): number | null {
  let relevant = samples;
  if (typeof days === 'number') {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    relevant = samples.filter(sample => sample.collectedAt.getTime() >= cutoff);
  }

  if (relevant.length === 0) return null;
  const sum = relevant.reduce((acc, sample) => acc + sample.amount, 0);
  return sum / relevant.length;
}

function formatPrice(value: number | null, currency: string | null, label: string): string {
  if (value === null) return `${label}: keine Daten`;
  const formatted = currencyFormatter.format(value);
  const suffix = displayCurrency(currency);
  return `${label}: ${formatted}${suffix ? ` ${suffix}` : ''}`;
}

function resolveCurrency(links: MarketLinkRow[]): string | null {
  for (const link of links) {
    const listing = link.auction_listings;
    if (!listing) continue;
    const resolved = Array.isArray(listing) ? listing[0] : listing;
    if (resolved?.currency) return resolved.currency;
  }
  return null;
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

    const listingIds = Array.from(new Set(links.map(link => link.listing_id).filter(Boolean)));

    const snapshots = await fetchSnapshots(listingIds);
    const bids = extractBids(snapshots);

    if (bids.length === 0) {
      await interaction.editReply(`Keine Gebotsdaten für **${item.name}** gefunden.`);
      return;
    }

    const currency = resolveCurrency(links);

    const lastBid = bids[bids.length - 1]?.amount ?? null;
    const avg7 = averageAmount(bids, 7);
    const avg30 = averageAmount(bids, 30);
    const avgAll = averageAmount(bids);

    const lines = [
      `**Preisdaten für ${item.name}**`,
      formatPrice(lastBid, currency, 'Letztes Gebot'),
      formatPrice(avg7, currency, 'Durchschnitt 7 Tage'),
      formatPrice(avg30, currency, 'Durchschnitt 30 Tage'),
      formatPrice(avgAll, currency, 'Durchschnitt gesamt'),
      `Anzahl Datensätze: ${bids.length}`,
    ];

    await interaction.editReply(lines.join('\n'));
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

