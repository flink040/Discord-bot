
# Discord Bot — Railway Starter (TypeScript, Auto-Register)

A minimal, **modular** Discord bot starter for **Railway** with **automatic slash-command registration** on boot.
No extra "register" step needed.

## Features
- TypeScript, Node 20+
- `discord.js` v14
- Modular command system (`src/commands/*`)
- **Auto-registers slash commands**:
  - Registers to **all guilds** the bot is currently in
  - Also registers when the bot is **added to a new guild**
  - If you set `REGISTER_MODE=global`, it registers **globally**
- Health endpoint on `GET /health` (prevents Railway "no healthy upstream")
- Graceful shutdown (SIGINT/SIGTERM)

---

## Environment Variables (Railway → Variables)
| Variable | Required | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token |
| `DISCORD_APP_ID` | ✅ | Application (Client) ID |
| `REGISTER_MODE` | ➖ | `guild` (default) or `global` |
| `PORT` | ➖ | Railway injects this. Defaults to 3000 locally. |
| `NODE_ENV` | ➖ | `development` or `production` |
| `SUPABASE_URL` | ✅ | URL deines Supabase-Projekts (z. B. `https://xyz.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅* | Service-Role-Key für serverseitige Zugriffe. Alternativ `SUPABASE_ANON_KEY` setzen, falls nur öffentliche Tabellen benötigt werden. |
| `SUPABASE_ANON_KEY` | ➖ | Optionaler Alternativ-Key, falls nur öffentliche Tabellen gelesen werden. |

\* Pflicht, sofern kein `SUPABASE_ANON_KEY` gesetzt ist.

> **Note:** In `guild` mode, the bot auto-registers commands for **every guild** it's in and on every new **guild join**. In `global` mode, it registers globally.

---

## Local Development
```bash
npm i
npm run dev
```
Health endpoint: `http://localhost:3000/health`

---

## Supabase-Anbindung

- Lege die Variablen `SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` (oder `SUPABASE_ANON_KEY`) in deiner `.env` an.
- Der Bot verwendet den [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript/start) ohne persistente Sessions.
- Beispiel `.env`-Auszug:

```env
SUPABASE_URL=https://<projekt>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
```

Der Slash-Command `/item` zeigt Einträge aus der Tabelle `items` an. Über die optionale Eingabe `name` lässt sich nach einer Teilzeichenfolge filtern. Es werden ausschließlich freigegebene (`approved`) Items angezeigt.

> Hinweis: Der bestehende `/auctions`-Command bleibt im Code erhalten, ist aktuell aber deaktiviert und wird nicht registriert.

---

## Deploy to Railway
1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub → select repo.
3. Variables setzen: `DISCORD_TOKEN`, `DISCORD_APP_ID` (optional `REGISTER_MODE`).
4. Deploy. Nach dem Start registriert der Bot die Commands automatisch.

---

## Adding Commands
Create `src/commands/<name>.ts` and export `{ data, execute }`:
```ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { CommandDef } from '../types/Command';

export const data = new SlashCommandBuilder()
  .setName('hello')
  .setDescription('Replies with a friendly greeting!');

export const execute = async (interaction: ChatInputCommandInteraction) => {
  await interaction.reply({ content: '👋 Hey there!', ephemeral: true });
};

export default { data: data.toJSON(), execute } satisfies CommandDef;
```
Redeploy (or restart) → commands werden automatisch aktualisiert.

---

## Optional: Prefix-Kommandos (ohne Slash-Registration)
Falls du stattdessen klassische Text-Prefixe wie `!about` willst, musst du im Developer Portal den **Message Content Intent** aktivieren und `GatewayIntentBits.MessageContent` hinzufügen. (Nicht aktiviert in diesem Starter.)
