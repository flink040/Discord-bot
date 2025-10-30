import { createGuildChannelSetting } from './channel-setting';
import { createGuildNumberSetting } from './number-setting';

export const DEFAULT_MARKETPLACE_POST_INTERVAL_HOURS = 24;

const storageEnvVar = 'MARKETPLACE_CHANNEL_STORAGE';

const channelAdapter = createGuildChannelSetting({
  configFileName: 'marketplace-channels.json',
  supabaseColumn: 'marketplace_channel_id',
  envVarName: storageEnvVar,
  logTag: 'marketplace',
});

const intervalAdapter = createGuildNumberSetting({
  configFileName: 'marketplace-post-intervals.json',
  supabaseColumn: 'marketplace_post_interval_hours',
  envVarName: storageEnvVar,
  logTag: 'marketplace-interval',
  minValue: 1,
});

export const getMarketplaceChannelId = channelAdapter.getChannelId;
export const setMarketplaceChannelId = channelAdapter.setChannelId;

export const getMarketplacePostIntervalHours = intervalAdapter.getValue;
export const setMarketplacePostIntervalHours = intervalAdapter.setValue;
