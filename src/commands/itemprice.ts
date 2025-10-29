import {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type MessageEditAttachmentData,
} from 'discord.js';
import { Chart, registerables, type ChartConfiguration } from 'chart.js';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import type { CommandDef } from '../types/Command';
import { getSupabaseClient } from '../supabase';

Chart.register(...registerables);

const currencyFormatter = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

function displayCurrency(currency: string | null): string | null {
  if (!currency) return null;
  return currency.toLowerCase() === 'emerald' ? '$' : currency;
}

const COMMAND_ID = 'itemprice';

type ViewMode = '7d' | '30d' | 'all';

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

async function fetchItemById(id: string): Promise<ItemRow | null> {
  const supabase = getSupabaseClient();
  const { data: row, error } = await supabase
    .from('items')
    .select('id, name')
    .eq('status', 'approved')
    .eq('id', id)
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

function formatDateRange(samples: BidSample[]): string | null {
  if (samples.length === 0) return null;
  const formatter = new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'short',
  });

  const first = formatter.format(samples[0].collectedAt);
  const last = formatter.format(samples[samples.length - 1].collectedAt);

  if (first === last) return first;
  return `${first} – ${last}`;
}

function formatPriceValue(value: number | null, currency: string | null): string {
  if (value === null) return 'keine Daten';
  const formatted = currencyFormatter.format(value);
  const suffix = displayCurrency(currency);
  return `${formatted}${suffix ? ` ${suffix}` : ''}`;
}

const viewLabels: Record<ViewMode, string> = {
  '7d': '7 Tage',
  '30d': '30 Tage',
  all: 'Gesamt',
};

function filterSamplesByView(samples: BidSample[], view: ViewMode): BidSample[] {
  if (view === 'all') return samples;
  const days = view === '7d' ? 7 : 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return samples.filter(sample => sample.collectedAt.getTime() >= cutoff);
}

const chartWidth = 800;
const chartHeight = 400;
const chartBackground = '#ffffff';
const chartBorderColor = '#3498db';
const chartLabelFormatter = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
});

const chartJSNodeCanvas = new ChartJSNodeCanvas({
  width: chartWidth,
  height: chartHeight,
  backgroundColour: chartBackground,
});

async function renderPriceChart(samples: BidSample[], currency: string | null): Promise<Buffer | null> {
  if (samples.length < 2) return null;

  const labels = samples.map(sample => chartLabelFormatter.format(sample.collectedAt));
  const data = samples.map(sample => sample.amount);
  const suffix = displayCurrency(currency);
  const datasetLabel = `Preis${suffix ? ` (${suffix})` : ''}`;

  const config: ChartConfiguration<'line'> = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: datasetLabel,
          data,
          borderColor: chartBorderColor,
          backgroundColor: chartBorderColor,
          borderWidth: 3,
          tension: 0.2,
          pointRadius: 3,
          pointHoverRadius: 5,
          fill: false,
        },
      ],
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          ticks: {
            color: '#4b5563',
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 10,
          },
          grid: {
            color: 'rgba(0,0,0,0.1)',
          },
        },
        y: {
          ticks: {
            color: '#4b5563',
            callback: value => currencyFormatter.format(Number(value)),
          },
          grid: {
            color: 'rgba(0,0,0,0.1)',
          },
        },
      },
      elements: {
        point: {
          backgroundColor: chartBorderColor,
        },
        line: {
          borderJoinStyle: 'round',
          borderCapStyle: 'round',
        },
      },
    },
  } satisfies ChartConfiguration<'line'>;

  return chartJSNodeCanvas.renderToBuffer(config, 'image/png');
}

type PriceSummary = {
  lastBid: number | null;
  avg7: number | null;
  avg30: number | null;
  avgAll: number | null;
  count: number;
};

function summarizeBids(samples: BidSample[]): PriceSummary {
  return {
    lastBid: samples[samples.length - 1]?.amount ?? null,
    avg7: averageAmount(samples, 7),
    avg30: averageAmount(samples, 30),
    avgAll: averageAmount(samples),
    count: samples.length,
  } satisfies PriceSummary;
}

function buildPriceEmbed(options: {
  itemName: string;
  currency: string | null;
  summary: PriceSummary;
  view: ViewMode;
  viewSamples: BidSample[];
  allSamples: BidSample[];
  hasChart: boolean;
}): EmbedBuilder {
  const { itemName, currency, summary, view, viewSamples, allSamples, hasChart } = options;
  const viewLabel = viewLabels[view];
  const viewRange = formatDateRange(viewSamples);
  const overallRange = formatDateRange(allSamples);

  const descriptionLines = [`Zeitraum (${viewLabel}): ${viewRange ?? '–'}`];
  if (!hasChart) {
    if (viewSamples.length >= 2) {
      descriptionLines.push('Diagramm konnte nicht erzeugt werden.');
    } else if (viewSamples.length === 1) {
      descriptionLines.push('Nur ein Datenpunkt verfügbar.');
    } else {
      descriptionLines.push('Keine Daten verfügbar.');
    }
  }

  const footerText = overallRange ? `Gesamtzeitraum: ${overallRange}` : undefined;

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`Preisdaten für ${itemName}`)
    .setDescription(descriptionLines.join('\n'))
    .addFields(
      { name: 'Letztes Gebot', value: formatPriceValue(summary.lastBid, currency), inline: true },
      { name: 'Durchschnitt 7 Tage', value: formatPriceValue(summary.avg7, currency), inline: true },
      { name: 'Durchschnitt 30 Tage', value: formatPriceValue(summary.avg30, currency), inline: true },
      { name: 'Durchschnitt gesamt', value: formatPriceValue(summary.avgAll, currency), inline: true },
      { name: 'Anzahl Datensätze', value: currencyFormatter.format(summary.count), inline: true },
    );

  if (footerText) {
    embed.setFooter({ text: footerText });
  }

  return embed;
}

function buildComponents(itemId: string, samples: BidSample[], activeView: ViewMode) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  (['7d', '30d', 'all'] as ViewMode[]).forEach(view => {
    const viewSamples = filterSamplesByView(samples, view);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${COMMAND_ID}:${itemId}:${view}`)
        .setLabel(viewLabels[view])
        .setStyle(view === activeView ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(viewSamples.length === 0)
    );
  });
  return [row];
}

const chartFileName = 'price-chart.png';

async function buildViewPayload(options: {
  itemId: string;
  itemName: string;
  currency: string | null;
  allSamples: BidSample[];
  summary: PriceSummary;
  view: ViewMode;
}) {
  const { itemId, itemName, currency, allSamples, summary, view } = options;
  const viewSamples = filterSamplesByView(allSamples, view);
  const chartBuffer = await renderPriceChart(viewSamples, currency);
  const hasChart = Boolean(chartBuffer);

  const embed = buildPriceEmbed({
    itemName,
    currency,
    summary,
    view,
    viewSamples,
    allSamples,
    hasChart,
  });

  const attachments = chartBuffer
    ? [new AttachmentBuilder(chartBuffer, { name: chartFileName })]
    : undefined;

  if (attachments) {
    embed.setImage(`attachment://${chartFileName}`);
  }

  const components = buildComponents(itemId, allSamples, view);

  const payload = {
    embeds: [embed],
    components,
    attachments: [] as MessageEditAttachmentData[],
  } as {
    embeds: EmbedBuilder[];
    components: ReturnType<typeof buildComponents>;
    files?: AttachmentBuilder[];
    attachments: MessageEditAttachmentData[];
  };

  if (attachments) {
    payload.files = attachments;
  }

  return payload;
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

type PriceDataset =
  | { status: 'ok'; bids: BidSample[]; currency: string | null }
  | { status: 'no-links' }
  | { status: 'no-bids' };

async function loadPriceDataset(itemId: string): Promise<PriceDataset> {
  const links = await fetchMarketLinks(itemId);
  if (links.length === 0) {
    return { status: 'no-links' };
  }

  const listingIds = Array.from(new Set(links.map(link => link.listing_id).filter(Boolean)));
  const snapshots = await fetchSnapshots(listingIds);
  const bids = extractBids(snapshots);

  if (bids.length === 0) {
    return { status: 'no-bids' };
  }

  return {
    status: 'ok',
    bids,
    currency: resolveCurrency(links),
  };
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
    const dataset = await loadPriceDataset(item.id);
    if (dataset.status === 'no-links') {
      await interaction.editReply({
        content: `Keine Preisdaten für **${item.name}** gefunden.`,
        components: [],
      });
      return;
    }

    if (dataset.status === 'no-bids') {
      await interaction.editReply({
        content: `Keine Gebotsdaten für **${item.name}** gefunden.`,
        components: [],
      });
      return;
    }

    const summary = summarizeBids(dataset.bids);
    const payload = await buildViewPayload({
      itemId: item.id,
      itemName: item.name,
      currency: dataset.currency,
      allSamples: dataset.bids,
      summary,
      view: 'all',
    });

    await interaction.editReply(payload);
  } catch (err) {
    console.error('[command:itemprice]', err);
    if (err instanceof Error) {
      await interaction.editReply(`Fehler beim Laden der Preisdaten: ${err.message}`);
    } else {
      await interaction.editReply('Unbekannter Fehler beim Laden der Preisdaten.');
    }
  }
};

export const handleComponent = async (interaction: MessageComponentInteraction) => {
  if (!interaction.isButton()) {
    if (!interaction.replied) {
      await interaction.reply({ content: 'Dieser Interaktionstyp wird nicht unterstützt.', ephemeral: true });
    }
    return;
  }

  const [, itemId, view] = interaction.customId.split(':');
  if (!itemId || (view !== '7d' && view !== '30d' && view !== 'all')) {
    if (!interaction.replied) {
      await interaction.reply({ content: 'Unbekannte Aktion.', ephemeral: true }).catch(() => {});
    }
    return;
  }

  try {
    const item = await fetchItemById(itemId);
    if (!item) {
      await interaction.update({ content: 'Item nicht gefunden.', components: [], embeds: [] }).catch(() => {});
      return;
    }

    const dataset = await loadPriceDataset(item.id);
    if (dataset.status === 'no-links') {
      await interaction
        .update({ content: `Keine Preisdaten für **${item.name}** gefunden.`, components: [], embeds: [] })
        .catch(() => {});
      return;
    }

    if (dataset.status === 'no-bids') {
      await interaction
        .update({ content: `Keine Gebotsdaten für **${item.name}** gefunden.`, components: [], embeds: [] })
        .catch(() => {});
      return;
    }

    const summary = summarizeBids(dataset.bids);
    const payload = await buildViewPayload({
      itemId: item.id,
      itemName: item.name,
      currency: dataset.currency,
      allSamples: dataset.bids,
      summary,
      view: view as ViewMode,
    });

    await interaction.update(payload).catch(() => {});
  } catch (err) {
    console.error('[component:itemprice]', err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: 'Fehler beim Aktualisieren der Preisdaten.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Fehler beim Aktualisieren der Preisdaten.', ephemeral: true }).catch(() => {});
    }
  }
};

export default { data: data.toJSON(), execute, handleComponent } satisfies CommandDef;

