import { SlashCommandBuilder, time, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandDef } from '../types/Command';
import { getSupabaseClient } from '../supabase';

const STATUSES = ['active', 'scheduled', 'completed', 'cancelled'] as const;

export const data = new SlashCommandBuilder()
  .setName('auctions')
  .setDescription('Zeigt Auktionen aus der Supabase-Datenbank an.')
  .addStringOption(option =>
    option
      .setName('status')
      .setDescription('Filtert nach Status (Standard: active)')
      .setRequired(false)
      .addChoices(...STATUSES.map(status => ({ name: status, value: status })))
  )
  .addIntegerOption(option =>
    option
      .setName('limit')
      .setDescription('Anzahl der Auktionen (1-10, Standard: 5)')
      .setMinValue(1)
      .setMaxValue(10)
      .setRequired(false)
  );

type ListingRow = {
  title: string;
  status: string;
  seller_username: string | null;
  current_bid: number | null;
  buyout_price: number | null;
  ends_at: string;
  watchers: number | null;
  bid_count: number | null;
};

const numberFormatter = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

async function fetchListings(status: string, limit: number): Promise<ListingRow[]> {
  const supabase = getSupabaseClient();
  const { data: rows, error } = await supabase
    .from('auction_listings')
    .select('title, status, seller_username, current_bid, buyout_price, ends_at, watchers, bid_count')
    .eq('status', status)
    .order('ends_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  return rows ?? [];
}

export const execute = async (interaction: ChatInputCommandInteraction) => {
  await interaction.deferReply({ ephemeral: true });

  const status = interaction.options.getString('status') ?? 'active';
  const limit = interaction.options.getInteger('limit') ?? 5;

  try {
    const listings = await fetchListings(status, limit);
    if (listings.length === 0) {
      await interaction.editReply('Keine Auktionen mit diesen Kriterien gefunden.');
      return;
    }

    const lines = listings.map((listing, idx) => {
      const parts = [`**${idx + 1}. ${listing.title}**`];
      if (listing.seller_username) {
        parts.push(`Verkäufer: ${listing.seller_username}`);
      }
      if (listing.current_bid !== null) {
        parts.push(`Aktuelles Gebot: ${numberFormatter.format(Number(listing.current_bid))}`);
      }
      if (listing.buyout_price !== null) {
        parts.push(`Sofortkauf: ${numberFormatter.format(Number(listing.buyout_price))}`);
      }
      parts.push(`Gebote: ${listing.bid_count ?? 0} • Beobachter: ${listing.watchers ?? 0}`);
      const endsAt = new Date(listing.ends_at);
      if (!Number.isNaN(endsAt.getTime())) {
        parts.push(`Endet: ${time(endsAt, 'R')}`);
      }
      return parts.join('\n');
    });

    await interaction.editReply(lines.join('\n\n'));
  } catch (err) {
    console.error('[command:auctions]', err);
    if (err instanceof Error) {
      await interaction.editReply(`Fehler beim Laden der Auktionen: ${err.message}`);
    } else {
      await interaction.editReply('Unbekannter Fehler beim Laden der Auktionen.');
    }
  }
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
