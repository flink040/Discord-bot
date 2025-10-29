
import type {
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  ChatInputCommandInteraction,
  MessageComponentInteraction,
} from 'discord.js';

export interface CommandDef {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  /**
   * When set to false the command stays in the code base but will not be loaded or registered.
   */
  enabled?: boolean;
  handleComponent?: (interaction: MessageComponentInteraction) => Promise<void>;
}
