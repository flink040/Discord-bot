import {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type MessageEditAttachmentData,
} from 'discord.js';
import {
  Chart,
  registerables,
  type ChartConfiguration,
  type ChartType,
  type Plugin,
} from 'chart.js';
import { ChartJSNodeCanvas } from '../utils/chart';
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
type DisplayMode = 'raw' | 'avg' | 'both';

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

const displayModeLabels: Record<DisplayMode, string> = {
  raw: 'Rohdaten',
  avg: 'Durchschnitt',
  both: 'Rohdaten + Durchschnitt',
};

function filterSamplesByView(samples: BidSample[], view: ViewMode): BidSample[] {
  if (view === 'all') return samples;
  const days = view === '7d' ? 7 : 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return samples.filter(sample => sample.collectedAt.getTime() >= cutoff);
}

const chartWidth = 960;
const chartHeight = 480;
const chartBackground = '#0b1120';
const chartAccent = '#38bdf8';
const chartAverageAccent = '#f97316';
const chartGridColor = 'rgba(148, 163, 184, 0.18)';
const chartAxisColor = '#e2e8f0';
const chartTitleColor = '#f8fafc';
const chartAxisFontFamily = '"DejaVu Sans", sans-serif';
const chartLabelFormatter = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
});

const chartJSNodeCanvas = new ChartJSNodeCanvas({
  width: chartWidth,
  height: chartHeight,
  backgroundColour: chartBackground,
});

const chartBackgroundPlugin: Plugin<'line'> = {
  id: 'gradient-background',
  beforeDraw: (chart: Chart) => {
    const { ctx, chartArea } = chart;
    if (!chartArea) return;
    const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
    gradient.addColorStop(0, '#0b1120');
    gradient.addColorStop(1, '#172554');
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
    ctx.restore();
  },
};

type AxisLabelFont = {
  family: string;
  size: number;
  weight?: string | number;
};

type AxisLabelOptions = {
  text: string;
  color: string;
  font: AxisLabelFont;
  padding?: number;
};

type AxisLabelsPluginOptions = {
  x?: AxisLabelOptions;
  y?: AxisLabelOptions;
};

function toFontString(font: AxisLabelFont): string {
  const weight = font.weight ?? 400;
  return `${weight} ${font.size}px ${font.family}`;
}

const chartAxisLabelsPlugin: Plugin<'line', AxisLabelsPluginOptions> = {
  id: 'customAxisLabels',
  afterDraw(chart, _args, opts) {
    const options = opts ?? {};
    const { ctx, chartArea } = chart;
    if (!chartArea) return;

    ctx.save();

    if (options.x) {
      const { text, color, font, padding = 12 } = options.x;
      ctx.font = toFontString(font);
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(text, (chartArea.left + chartArea.right) / 2, chartArea.bottom + padding);
    }

    if (options.y) {
      const { text, color, font, padding = 12 } = options.y;
      ctx.font = toFontString(font);
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.translate(chartArea.left - padding, (chartArea.top + chartArea.bottom) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(text, 0, 0);
    }

    ctx.restore();
  },
};

declare module 'chart.js' {
  interface PluginOptionsByType<TType extends ChartType> {
    customAxisLabels?: AxisLabelsPluginOptions;
  }
}

const viewAverageWindowDays: Record<ViewMode, number> = {
  '7d': 7,
  '30d': 30,
  all: 30,
};

function computeMovingAverage(samples: BidSample[], windowDays: number): number[] {
  if (samples.length === 0) return [];
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const result: number[] = [];
  let windowStart = 0;
  let windowSum = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index];
    windowSum += current.amount;

    while (
      windowStart < index &&
      current.collectedAt.getTime() - samples[windowStart].collectedAt.getTime() > windowMs
    ) {
      windowSum -= samples[windowStart].amount;
      windowStart += 1;
    }

    const divisor = index - windowStart + 1;
    result.push(divisor > 0 ? windowSum / divisor : current.amount);
  }

  return result;
}

async function renderPriceChart(options: {
  samples: BidSample[];
  currency: string | null;
  view: ViewMode;
  mode: DisplayMode;
}): Promise<Buffer | null> {
  const { samples, currency, view, mode } = options;
  if (samples.length < 2) return null;

  const labels = samples.map(sample => chartLabelFormatter.format(sample.collectedAt));
  const suffix = displayCurrency(currency);
  const datasetLabel = `Preis${suffix ? ` (${suffix})` : ''}`;

  const datasets: ChartConfiguration<'line'>['data']['datasets'] = [];

  if (mode === 'raw' || mode === 'both') {
    datasets.push({
      label: datasetLabel,
      data: samples.map(sample => sample.amount),
      borderColor: chartAccent,
      backgroundColor: (context) => {
        const ctx = context.chart.ctx;
        const gradient = ctx.createLinearGradient(0, chartHeight, 0, 0);
        gradient.addColorStop(0, 'rgba(56, 189, 248, 0.05)');
        gradient.addColorStop(1, 'rgba(56, 189, 248, 0.35)');
        return gradient;
      },
      borderWidth: 3,
      tension: 0.3,
      pointRadius: 3,
      pointHoverRadius: 6,
      pointBackgroundColor: '#ffffff',
      pointBorderWidth: 1,
      fill: true,
    });
  }

  if (mode === 'avg' || mode === 'both') {
    const averageValues = computeMovingAverage(samples, viewAverageWindowDays[view]);
    if (averageValues.length >= 2) {
      datasets.push({
        label: `Gleitender Durchschnitt (${viewAverageWindowDays[view]} Tage)`,
        data: averageValues,
        borderColor: chartAverageAccent,
        backgroundColor: 'rgba(249, 115, 22, 0.2)',
        borderDash: [6, 6],
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 0,
        fill: false,
      });
    }
  }

  if (datasets.length === 0) {
    return null;
  }

  const axisLabelFont: AxisLabelFont = {
    family: chartAxisFontFamily,
    size: 14,
    weight: 500,
  };

  const config: ChartConfiguration<'line'> = {
    type: 'line',
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      layout: {
        padding: {
          top: 28,
          right: 32,
          bottom: 72,
          left: 72,
        },
      },
      plugins: {
        legend: {
          display: datasets.length > 0,
          labels: {
            color: chartAxisColor,
            font: {
              family: chartAxisFontFamily,
              size: 13,
              weight: 600,
            },
          },
        },
        title: {
          display: true,
          text: 'Preisverlauf',
          color: chartTitleColor,
          font: {
            family: chartAxisFontFamily,
            size: 18,
            weight: 600,
          },
        },
        customAxisLabels: {
          x: {
            text: 'Datum',
            color: chartAxisColor,
            font: axisLabelFont,
            padding: 36,
          },
          y: {
            text: `Preis${suffix ? ` (${suffix})` : ''}`,
            color: chartAxisColor,
            font: axisLabelFont,
            padding: 40,
          },
        },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          ticks: {
            color: chartAxisColor,
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 14,
            font: {
              family: chartAxisFontFamily,
            },
          },
          grid: {
            color: chartGridColor,
          },
        },
        y: {
          ticks: {
            color: chartAxisColor,
            callback: value => `${currencyFormatter.format(Number(value))}${suffix ? ` ${suffix}` : ''}`,
            font: {
              family: chartAxisFontFamily,
            },
          },
          grid: {
            color: chartGridColor,
          },
        },
      },
      elements: {
        point: {
          backgroundColor: chartAccent,
        },
        line: {
          borderJoinStyle: 'round',
          borderCapStyle: 'round',
        },
      },
    },
    plugins: [chartBackgroundPlugin, chartAxisLabelsPlugin],
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
  mode: DisplayMode;
  viewSamples: BidSample[];
  allSamples: BidSample[];
  hasChart: boolean;
}): EmbedBuilder {
  const { itemName, currency, summary, view, mode, viewSamples, allSamples, hasChart } = options;
  const viewLabel = viewLabels[view];
  const viewRange = formatDateRange(viewSamples);
  const overallRange = formatDateRange(allSamples);

  const descriptionLines = [
    `Zeitraum (${viewLabel}): ${viewRange ?? '–'}`,
    `Darstellung: ${displayModeLabels[mode]}`,
  ];
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
    .setColor(0x38bdf8)
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

const displayModes: { mode: DisplayMode; label: string; emoji: string }[] = [
  { mode: 'raw', label: 'Gebote', emoji: '📈' },
  { mode: 'avg', label: 'Durchschnitt', emoji: '📊' },
  { mode: 'both', label: 'Kombiniert', emoji: '🧮' },
];

function buildComponents(itemId: string, samples: BidSample[], state: { view: ViewMode; mode: DisplayMode }) {
  const viewRow = new ActionRowBuilder<StringSelectMenuBuilder>();
  const viewMenu = new StringSelectMenuBuilder()
    .setCustomId(`${COMMAND_ID}:view:${itemId}:${state.mode}`)
    .setPlaceholder('Zeitraum auswählen')
    .addOptions(
      (['7d', '30d', 'all'] as ViewMode[]).map(view => ({
        label: viewLabels[view],
        value: view,
        default: state.view === view,
        description:
          view === 'all'
            ? 'Gesamter verfügbarer Zeitraum'
            : `Preise der letzten ${viewLabels[view]}`,
      }))
    );
  viewRow.addComponents(viewMenu);

  const modeRow = new ActionRowBuilder<ButtonBuilder>();
  const activeViewSamples = filterSamplesByView(samples, state.view);
  const hasAverageData = activeViewSamples.length >= 2;
  displayModes.forEach(({ mode, label, emoji }) => {
    const disable = mode !== 'raw' && !hasAverageData;
    modeRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`${COMMAND_ID}:mode:${itemId}:${state.view}:${mode}`)
        .setLabel(`${emoji} ${label}`)
        .setStyle(mode === state.mode ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disable)
    );
  });

  return [viewRow, modeRow] as Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>>;
}

const chartFileName = 'price-chart.png';

async function buildViewPayload(options: {
  itemId: string;
  itemName: string;
  currency: string | null;
  allSamples: BidSample[];
  summary: PriceSummary;
  state: { view: ViewMode; mode: DisplayMode };
}) {
  const { itemId, itemName, currency, allSamples, summary, state } = options;
  const viewSamples = filterSamplesByView(allSamples, state.view);
  const hasAverageData = viewSamples.length >= 2;
  const resolvedMode: DisplayMode = state.mode === 'raw' || hasAverageData ? state.mode : 'raw';
  const resolvedState = { view: state.view, mode: resolvedMode };

  const chartBuffer = await renderPriceChart({
    samples: viewSamples,
    currency,
    view: resolvedState.view,
    mode: resolvedState.mode,
  });
  const hasChart = Boolean(chartBuffer);

  const embed = buildPriceEmbed({
    itemName,
    currency,
    summary,
    view: resolvedState.view,
    mode: resolvedState.mode,
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

  const components = buildComponents(itemId, allSamples, resolvedState);

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
    const initialMode: DisplayMode = dataset.bids.length >= 2 ? 'both' : 'raw';
    const payload = await buildViewPayload({
      itemId: item.id,
      itemName: item.name,
      currency: dataset.currency,
      allSamples: dataset.bids,
      summary,
      state: { view: 'all', mode: initialMode },
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
  let itemId: string | undefined;
  let state: { view: ViewMode; mode: DisplayMode } | undefined;

  if (interaction.isStringSelectMenu()) {
    const [, action, maybeItemId, maybeMode] = interaction.customId.split(':');
    const selectedView = interaction.values[0];
    if (
      action !== 'view' ||
      !maybeItemId ||
      !maybeMode ||
      (maybeMode !== 'raw' && maybeMode !== 'avg' && maybeMode !== 'both') ||
      (selectedView !== '7d' && selectedView !== '30d' && selectedView !== 'all')
    ) {
      if (!interaction.replied) {
        await interaction
          .reply({ content: 'Unbekannte Aktion.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
      return;
    }
    itemId = maybeItemId;
    state = { view: selectedView, mode: maybeMode };
  } else if (interaction.isButton()) {
    const [, action, maybeItemId, maybeView, maybeMode] = interaction.customId.split(':');
    if (
      action !== 'mode' ||
      !maybeItemId ||
      !maybeView ||
      !maybeMode ||
      (maybeView !== '7d' && maybeView !== '30d' && maybeView !== 'all') ||
      (maybeMode !== 'raw' && maybeMode !== 'avg' && maybeMode !== 'both')
    ) {
      if (!interaction.replied) {
        await interaction
          .reply({ content: 'Unbekannte Aktion.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
      return;
    }
    itemId = maybeItemId;
    state = { view: maybeView, mode: maybeMode };
  } else {
    if (!interaction.replied) {
      await interaction
        .reply({ content: 'Dieser Interaktionstyp wird nicht unterstützt.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
    return;
  }

  if (!itemId || !state) {
    if (!interaction.replied) {
      await interaction
        .reply({ content: 'Unbekannte Aktion.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
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
      state,
    });

    await interaction.update(payload).catch(() => {});
  } catch (err) {
    console.error('[component:itemprice]', err);
    if (interaction.deferred || interaction.replied) {
      await interaction
        .followUp({ content: 'Fehler beim Aktualisieren der Preisdaten.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    } else {
      await interaction
        .reply({ content: 'Fehler beim Aktualisieren der Preisdaten.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
};

export default { data: data.toJSON(), execute, handleComponent } satisfies CommandDef;

