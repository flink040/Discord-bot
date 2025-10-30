import { createGuildChannelSetting } from './channel-setting';

const adapter = createGuildChannelSetting({
  configFileName: 'marketplace-channels.json',
  supabaseColumn: 'marketplace_channel_id',
  envVarName: 'MARKETPLACE_CHANNEL_STORAGE',
  logTag: 'marketplace',
});

export const getMarketplaceChannelId = adapter.getChannelId;
export const setMarketplaceChannelId = adapter.setChannelId;
