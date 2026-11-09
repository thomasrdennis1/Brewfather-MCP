# Brewfather MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects AI assistants to the [Brewfather](https://brewfather.app/) brewing platform. Manage batches, recipes, and inventory directly through your AI assistant.

Built with the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) on Cloudflare Workers and the [Brewfather API v2](https://docs.brewfather.app/api).

## Features

### Batches
- **List batches** — filter by status (Planning, Brewing, Fermenting, Conditioning, Completed, Archived)
- **Get batch details** — full recipe, measured values, notes, and events
- **Update batches** — set status, measured gravity/ABV/efficiency, brew dates
- **Readings** — get latest or all device readings (iSpindel, Tilt, etc.)
- **Brew tracker** — get current brew tracker status and steps

### Recipes
- **List recipes** — browse your recipe library with summary or full details
- **Get recipe details** — ingredients, style, profiles, and calculated values

### Inventory
Manage stock levels for all ingredient types:
- **Fermentables** — grains, extracts, sugars
- **Hops** — pellet, leaf, extract
- **Yeasts** — dry, liquid, slurry
- **Miscellaneous** — salts, finings, acids, spices

Each inventory category supports listing, detail lookup, and inventory adjustment (set absolute or add/subtract).

## Architecture

A stateless [Cloudflare Worker](https://developers.cloudflare.com/workers/) speaking MCP over Streamable HTTP (JSON responses, no sessions, no Durable Objects, no storage). Each `POST /mcp/<secret>` builds a fresh MCP server, handles one JSON-RPC message, and returns. Runs on the Workers free plan (100k requests/day).

Auth: requests must include the shared `MCP_SECRET`, either in the URL path (`/mcp/<MCP_SECRET>`) or as `Authorization: Bearer <MCP_SECRET>`. Brewfather credentials live only in Worker secrets.

## Prerequisites

- A [Brewfather](https://brewfather.app/) Premium account and API key (**Settings → API**), with the scopes you need (batches.read/write, recipes.read, inventory.read/write)
- A free Cloudflare account
- Node.js 20+

## Deploy

```bash
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put BREWFATHER_USER_ID
npx wrangler secret put BREWFATHER_API_KEY
npx wrangler secret put MCP_SECRET   # e.g. output of: openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Your MCP endpoint is `https://brewfather-mcp.<your-subdomain>.workers.dev/mcp/<MCP_SECRET>`.

## Connect Claude (web, desktop and mobile)

claude.ai → **Settings → Connectors → Add custom connector**, paste the endpoint URL above, leave OAuth fields empty. Connectors added on claude.ai sync to the Claude mobile apps.

For Claude Code:

```bash
claude mcp add --transport http brewfather https://brewfather-mcp.<subdomain>.workers.dev/mcp/<MCP_SECRET>
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in values
npm run dev                       # http://localhost:8787/mcp/<MCP_SECRET>
```

## Available Tools

| Tool | Description |
|------|-------------|
| `brewfather_get_batches` | List batches, optionally filtered by status |
| `brewfather_get_batch` | Get a specific batch by ID |
| `brewfather_update_batch` | Update batch status and/or measured values |
| `brewfather_get_batch_last_reading` | Get the latest device reading for a batch |
| `brewfather_get_batch_readings` | Get all readings for a batch |
| `brewfather_get_batch_brewtracker` | Get brew tracker status for a batch |
| `brewfather_get_recipes` | List recipes |
| `brewfather_get_recipe` | Get a specific recipe by ID |
| `brewfather_get_fermentables` | List fermentables in inventory |
| `brewfather_get_fermentable` | Get a specific fermentable by ID |
| `brewfather_update_fermentable` | Update fermentable inventory amount |
| `brewfather_get_hops` | List hops in inventory |
| `brewfather_get_hop` | Get a specific hop by ID |
| `brewfather_update_hop` | Update hop inventory amount |
| `brewfather_get_miscs` | List miscellaneous ingredients |
| `brewfather_get_misc` | Get a specific misc ingredient by ID |
| `brewfather_update_misc` | Update misc ingredient inventory amount |
| `brewfather_get_yeasts` | List yeasts in inventory |
| `brewfather_get_yeast` | Get a specific yeast by ID |
| `brewfather_update_yeast` | Update yeast inventory amount |

## API Rate Limits

The Brewfather API allows **500 requests per hour** per API key. Rate-limit responses (HTTP 429) are returned as tool errors with the retry delay.

## License

MIT
