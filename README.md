# Brewfather MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects AI assistants to the [Brewfather](https://brewfather.app/) brewing platform. Manage batches, recipes, and inventory directly through your AI assistant.

Built with [FastMCP](https://github.com/jlowin/fastmcp) and the [Brewfather API v2](https://docs.brewfather.app/api).

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

## Prerequisites

- Python 3.10+
- A [Brewfather](https://brewfather.app/) account with a Premium subscription
- A Brewfather API key — generate one in **Brewfather → Settings → API Key**

## Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/thomasrdennis1/Brewfather-MCP.git
   cd Brewfather-MCP
   ```

2. **Create a virtual environment and install dependencies**

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

3. **Configure environment variables**

   Create a `.env` file in the project root:

   ```env
   BREWFATHER_USER_ID=your_user_id
   BREWFATHER_API_KEY=your_api_key
   ```

   You can find both values in **Brewfather → Settings → API Key**.

4. **Run the server**

   ```bash
   python server.py
   ```

## MCP Client Configuration

Add this server to your MCP client (e.g. Claude Desktop, VS Code Copilot, etc.):

```json
{
  "mcpServers": {
    "brewfather": {
      "command": "python",
      "args": ["server.py"],
      "cwd": "/path/to/Brewfather-MCP",
      "env": {
        "BREWFATHER_USER_ID": "your_user_id",
        "BREWFATHER_API_KEY": "your_api_key"
      }
    }
  }
}
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

The Brewfather API allows **500 requests per hour** per API key. The server handles rate-limit responses (HTTP 429) with informative error messages.

## License

MIT
