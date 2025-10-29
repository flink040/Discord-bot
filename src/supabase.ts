import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function ensureEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = ensureEnv('SUPABASE_URL', process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!key) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');
  }

  client = createClient(url, key, {
    auth: {
      persistSession: false,
    },
    global: {
      headers: {
        'x-application-name': 'discord-bot',
      },
    },
  });

  return client;
}
