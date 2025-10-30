import { readFile } from 'fs/promises';
import path from 'path';

export type BlocklistRule = {
  minutes: number;
  reason: string;
  flags: string;
  pattern: string;
  regex: RegExp;
};

let cachedRules: BlocklistRule[] | null = null;
let loadingPromise: Promise<BlocklistRule[]> | null = null;

function parseBlocklist(content: string): BlocklistRule[] {
  const rules: BlocklistRule[] = [];
  const lines = content.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const parts = line.split('|');
    if (parts.length < 4) {
      console.warn(`[blocklist] Ignoring invalid line ${index + 1}: not enough fields.`);
      continue;
    }

    const [minutesStr, reasonRaw, flagsRaw, ...patternParts] = parts;
    const minutes = Number.parseInt(minutesStr, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      console.warn(`[blocklist] Ignoring invalid line ${index + 1}: invalid minutes value.`);
      continue;
    }

    const reason = reasonRaw.trim();
    const flags = flagsRaw.trim();
    const pattern = patternParts.join('|').trim();

    if (!pattern) {
      console.warn(`[blocklist] Ignoring invalid line ${index + 1}: empty pattern.`);
      continue;
    }

    try {
      const regex = new RegExp(pattern, flags);
      rules.push({ minutes, reason, flags, pattern, regex });
    } catch (err) {
      console.warn(`[blocklist] Failed to compile pattern on line ${index + 1}:`, err);
    }
  }

  return rules;
}

async function loadBlocklistFile(): Promise<BlocklistRule[]> {
  const filePath = path.resolve(__dirname, '..', '..', 'assets', 'blocklist.txt');

  try {
    const content = await readFile(filePath, 'utf8');
    const rules = parseBlocklist(content);
    console.log(`[blocklist] Loaded ${rules.length} rules from blocklist.`);
    return rules;
  } catch (err) {
    console.error('[blocklist] Failed to load blocklist file:', err);
    return [];
  }
}

export async function getBlocklistRules(): Promise<BlocklistRule[]> {
  if (cachedRules) {
    return cachedRules;
  }
  if (!loadingPromise) {
    loadingPromise = loadBlocklistFile().then((rules) => {
      cachedRules = rules;
      loadingPromise = null;
      return rules;
    });
  }
  return loadingPromise;
}

export function clearBlocklistCache() {
  cachedRules = null;
  loadingPromise = null;
}
