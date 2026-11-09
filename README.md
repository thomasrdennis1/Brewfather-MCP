# Brewfather MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects AI assistants to the [Brewfather](https://brewfather.app/) brewing platform. Manage batches, recipes, and inventory directly through your AI assistant.

Built with the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) on Cloudflare Workers and the [Brewfather API v2](https://docs.brewfather.app/api).

## Features

### Batches
- **List batches** — filter by status (Planning, Brewing, Fermenting, Conditioning, Completed, Archived)
- **Get batch details** — full recipe, measured values, notes, and events
- **Update batches** — set status, measured gravities/volumes, mash pH and carbonation temperature (send `null` to clear). ABV, efficiency and dates are not writable through the Brewfather API.
- **Readings** — get latest or all device readings (iSpindel, Tilt, etc.)
- **Brew tracker** — get current brew tracker status and steps

### Recipes
- **List recipes** — browse your recipe library with summary or full details
- **Get recipe details** — ingredients, style, profiles, and calculated values
- **Create recipes** — post a full recipe object; Brewfather validates it and returns the new `_id`
- **Update recipes** — shallow merge: each top-level field sent replaces the stored one (arrays such as `hops` are replaced whole)

### Inventory
Manage stock, cost and item details for all ingredient types:
- **Fermentables** — grains, extracts, sugars
- **Hops** — pellet, leaf, extract
- **Yeasts** — dry, liquid, slurry
- **Miscellaneous** — salts, finings, acids, spices

Each inventory category supports listing, detail lookup, creating items, and partial updates:

- `inventory` / `inventory_adjust` — set stock absolutely or add/subtract (`inventory` wins if both are sent). A call with only these sends a stock-only PATCH.
- `cost_per_amount` — maps to `costPerAmount`: per kg for fermentables, per g for hops, per one of the item's own `unit` for miscs and yeasts (normally per packet for yeast). `null` clears it.
- `fields` — any other item field (`supplier`, `notes`, `bestBeforeDate`, ...), merged into the request body. Only the fields sent are changed.

Root-level keys starting with `_`, plus `createdAt` and `updatedAt`, are server-managed and stripped before sending. Brewfather's response is passed back to the caller, including the validation error array on a 400. A `200 "Nothing to update"` is reported as an error, since nothing was written.

Deletes are deliberately not exposed, and the Brewfather API has no endpoint for creating batches.

## Architecture

A stateless [Cloudflare Worker](https://developers.cloudflare.com/workers/) speaking MCP over Streamable HTTP (JSON responses, no sessions, no Durable Objects, no storage). Each `POST /mcp` builds a fresh MCP server, handles one JSON-RPC message, and returns. Runs on the Workers free plan (100k requests/day).

Auth: requests must send `Authorization: Bearer <MCP_SECRET>` (32+ characters). The secret is never accepted in the URL, so it stays out of request logs. Preview URLs are disabled. Brewfather credentials live only in Worker secrets.

## Prerequisites

- A [Brewfather](https://brewfather.app/) Premium account and API key (**Settings → API**), with the scopes you need (batches.read/write, recipes.read/write, inventory.read/write)
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

Your MCP endpoint is `https://brewfather-mcp.<your-subdomain>.workers.dev/mcp`.

## Connect Claude (web, desktop and mobile)

claude.ai → **Settings → Connectors → Add custom connector**: paste the endpoint URL above, choose **No sign in**, and add a header `Authorization` with value `Bearer <MCP_SECRET>`. Connectors added on claude.ai sync to the Claude mobile apps.

For Claude Code:

```bash
claude mcp add --transport http brewfather https://brewfather-mcp.<subdomain>.workers.dev/mcp --header "Authorization: Bearer <MCP_SECRET>"
```

## Local development

`npm run typecheck` and `npm test` (offline: stubs the Brewfather API and checks every write tool's request body and error handling).

```bash
cp .dev.vars.example .dev.vars   # fill in values
npm run dev                       # http://localhost:8787/mcp
```

## Available Tools

| Tool | Description |
|------|-------------|
| `brewfather_get_batches` | List batches, optionally filtered by status |
| `brewfather_get_batch` | Get a specific batch by ID |
| `brewfather_update_batch` | Update batch status, measured values, carbonation temperature |
| `brewfather_get_batch_last_reading` | Get the latest device reading for a batch |
| `brewfather_get_batch_readings` | Get all readings for a batch |
| `brewfather_get_batch_brewtracker` | Get brew tracker status for a batch |
| `brewfather_get_recipes` | List recipes |
| `brewfather_get_recipe` | Get a specific recipe by ID |
| `brewfather_create_recipe` | Create a recipe |
| `brewfather_update_recipe` | Update top-level fields of a recipe |
| `brewfather_get_fermentables` | List fermentables in inventory |
| `brewfather_get_fermentable` | Get a specific fermentable by ID |
| `brewfather_create_fermentable` | Create a fermentable |
| `brewfather_update_fermentable` | Update fermentable stock, cost or other fields |
| `brewfather_get_hops` | List hops in inventory |
| `brewfather_get_hop` | Get a specific hop by ID |
| `brewfather_create_hop` | Create a hop |
| `brewfather_update_hop` | Update hop stock, cost or other fields |
| `brewfather_get_miscs` | List miscellaneous ingredients |
| `brewfather_get_misc` | Get a specific misc ingredient by ID |
| `brewfather_create_misc` | Create a misc ingredient |
| `brewfather_update_misc` | Update misc ingredient stock, cost or other fields |
| `brewfather_get_yeasts` | List yeasts in inventory |
| `brewfather_get_yeast` | Get a specific yeast by ID |
| `brewfather_create_yeast` | Create a yeast |
| `brewfather_update_yeast` | Update yeast stock, cost or other fields |

## API Rate Limits

The Brewfather API allows **500 requests per hour** per API key. Rate-limit responses (HTTP 429) are returned as tool errors with the retry delay.

## License

MIT
