
import fs from 'node:fs';
import path from 'node:path';
import type { CommandDef } from '../types/Command';

/**
 * Loads all command modules from the commands directory.
 */
export function loadCommands(): Map<string, CommandDef> {
  const commandsDir = __dirname;
  const files = fs.readdirSync(commandsDir)
    .filter(f => f.endsWith('.js') || f.endsWith('.ts'))
    .filter(f => !f.startsWith('_')); // ignore this loader

  const map = new Map<string, CommandDef>();
  for (const file of files) {
    const full = path.join(commandsDir, file);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(full);
    const def: CommandDef = (mod.default ?? mod) as CommandDef;
    if (!def?.data?.name || typeof def.execute !== 'function') {
      console.warn(`[commands] Skipped ${file}: invalid command def`);
      continue;
    }
    map.set(def.data.name, def);
  }
  return map;
}

/** Returns array of JSON bodies for registration */
export function commandsJson(commands: Map<string, CommandDef>) {
  return Array.from(commands.values()).map(c => c.data);
}
