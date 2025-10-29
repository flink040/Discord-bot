
# Discord Bot — Railway Starter (TypeScript)

A minimal, **modular** Discord bot starter designed for **Railway**. 
It exposes a tiny HTTP server for health checks (prevents "no healthy upstream") and supports slash-command auto‑registration.

## Features
- TypeScript, Node 20+
- `discord.js` v14
- Modular command system (`src/commands/*`)
- Health endpoint on `GET /health` so Railway sees the service as healthy
- Graceful shutdown (SIGINT/SIGTERM)
- Dev vs. Prod slash command registration (guild‑scoped vs global)

---

## Required Environment Variables (Railway → Variables)
| Variable | Required | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | Your bot token (Bot → Token). |
| `DISCORD_APP_ID` | ✅ | Your application (client) ID. |
| `DEV_GUILD_ID` | ➖ | Optional: If set, `npm run register:dev` registers commands only to this guild. |
| `PORT` | ➖ | Railway will inject this. Defaults to 3000 for local dev. |
| `NODE_ENV` | ➖ | `development` or `production`. Affects logging & recommended command registration. |

> **Security**: Never commit real tokens. Railway Variables keep them safe.

---

## Local Development
1. **Node 20+** recommended. Install deps:
   ```bash
   npm i
   ```
2. Copy `.env.example` to `.env` and fill values for local testing (do **not** commit `.env`).
3. Register slash commands (dev-guild recommended during development):
   ```bash
   npm run register:dev
   ```
4. Start the bot locally:
   ```bash
   npm run dev
   ```
   The bot will connect and an HTTP health server will run on `http://localhost:3000/health`.

---

## Deploy to Railway
1. Push this repo to GitHub.
2. On Railway, create a **New Project → Deploy from GitHub Repo** and select your repo.
3. Add **Variables** in Railway:
   - `DISCORD_TOKEN`
   - `DISCORD_APP_ID`
   - (optional) `DEV_GUILD_ID`
4. Railway will build with Nixpacks and run `npm start` (which builds then starts).
5. After first deploy, run **"Register commands"** via the Railway shell or a one‑off deploy:
   - For **guild‑only** (safe/instant for testing): `npm run register:dev`
   - For **global** (takes up to ~1 hour to propagate): `npm run register:global`

### Health Check
Railway often shows *"no healthy upstream"* when nothing listens on a port.  
This starter exposes `GET /health` returning `200 OK`. No extra config needed.

---

## Adding Commands
Create a new file in `src/commands/<name>.ts` exporting `{ data, execute }` that matches `CommandDef`.
Example:
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
Then run `npm run register:dev` (or `:global`) to publish the new command.

---

## Scripts
- `npm run dev` — Run with ts-node + nodemon
- `npm run build` — Compile TypeScript to `dist/`
- `npm start` — Build & start (used by Railway)
- `npm run register:dev` — Register slash commands for a single guild (`DEV_GUILD_ID`)
- `npm run register:global` — Register slash commands globally

---

## Notes
- Keep **gateway intents** minimal (we only use `Guilds`) until you need more.
- Store per‑server settings in your DB later (e.g., Supabase). This starter includes clean extension points but no DB coupling.
