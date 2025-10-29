
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

> **Note:** In `guild` mode, the bot auto-registers commands for **every guild** it's in and on every new **guild join**. In `global` mode, it registers globally.

---

## Local Development
```bash
npm i
npm run dev
```
Health endpoint: `http://localhost:3000/health`

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
