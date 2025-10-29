
import type { RESTPostAPIChatInputApplicationCommandsJSONBody, ChatInputCommandInteraction } from 'discord.js';

export interface CommandDef {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
