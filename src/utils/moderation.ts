import { createGuildChannelSetting } from './channel-setting';

const adapter = createGuildChannelSetting({
  configFileName: 'moderation-channels.json',
  supabaseColumn: 'moderation_channel_id',
  envVarName: 'MODERATION_CHANNEL_STORAGE',
  logTag: 'moderation',
});

export const getModerationChannelId = adapter.getChannelId;
export const setModerationChannelId = adapter.setChannelId;
