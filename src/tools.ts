import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./index.js";

const API_BASE = "https://api.brewfather.app/v2";
// Brewfather returns 10 items when no limit is passed.
const API_DEFAULT_LIMIT = 10;

type Query = Record<string, string | number | boolean | undefined>;

class BrewfatherError extends Error {}

async function bfRequest(env: Env, method: string, path: string, query?: Query, body?: unknown): Promise<unknown> {
  if (!env.BREWFATHER_USER_ID || !env.BREWFATHER_API_KEY) {
    throw new BrewfatherError("BREWFATHER_USER_ID and BREWFATHER_API_KEY secrets must be set on the Worker.");
  }
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    authorization: "Basic " + btoa(`${env.BREWFATHER_USER_ID}:${env.BREWFATHER_API_KEY}`),
  };
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  if (res.status === 401) throw new BrewfatherError("Authentication failed (401). Check the BREWFATHER_USER_ID and BREWFATHER_API_KEY secrets.");
  if (res.status === 403) throw new BrewfatherError(`Forbidden (403) for ${method} ${path}. The API key may lack the needed scope (e.g. batches.read, inventory.write) — enable it in Brewfather Settings → API.`);
  if (res.status === 404) throw new BrewfatherError(`Not found (404) for ${path}. Verify the ID is correct.`);
  if (res.status === 429) throw new BrewfatherError(`Rate limited by Brewfather (429). Retry after ${res.headers.get("retry-after") ?? "unknown"} seconds. Limit is 500 requests/hour per key.`);
  if (!res.ok) throw new BrewfatherError(`Brewfather API error ${res.status} for ${method} ${path}: ${(await res.text()).slice(0, 500)}`);

  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : res.text();
}

function paginated(result: unknown, limit: number | undefined) {
  if (!Array.isArray(result)) return result;
  const last = result[result.length - 1] as { _id?: string } | undefined;
  return {
    count: result.length,
    has_more: result.length >= (limit ?? API_DEFAULT_LIMIT),
    last_id: last?._id ?? null,
    items: result,
  };
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
});

async function run(fn: () => Promise<unknown>) {
  try {
    return text(await fn());
  } catch (e) {
    return { ...text(e instanceof Error ? e.message : String(e)), isError: true };
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BATCH_STATUS = ["Planning", "Brewing", "Fermenting", "Conditioning", "Completed", "Archived"] as const;

const listShape = {
  limit: z.number().int().min(1).max(200).optional().describe("Max items to return (API default 10). Use 200 to get everything in one page."),
  start_after: z.string().min(1).optional().describe("Pagination cursor — pass last_id from the previous page."),
  complete: z.boolean().optional().describe("If true, return all fields. Otherwise only default summary fields."),
  include: z.string().optional().describe("Comma-separated extra fields to include (e.g. 'recipe.fermentables')."),
  order_by: z.string().optional().describe("Field name to order results by."),
  order_by_direction: z.enum(["asc", "desc"]).optional().describe("Sort direction."),
};

const inventoryListShape = {
  ...listShape,
  inventory_negative: z.boolean().optional().describe("If true, only return items with negative inventory."),
  inventory_exists: z.boolean().optional().describe("If true, only return items that have stock."),
};

const getShape = {
  complete: z.boolean().optional().describe("If true (default), return all fields."),
  include: z.string().optional().describe("Comma-separated extra fields to include."),
};

const inventoryUpdateShape = {
  inventory: z.number().optional().describe("Set the absolute inventory amount (kg for fermentables, g for hops/miscs, packets for yeast)."),
  inventory_adjust: z.number().optional().describe("Add (positive) or subtract (negative) from current inventory."),
};

type ListArgs = { limit?: number; start_after?: string; complete?: boolean; include?: string; order_by?: string; order_by_direction?: "asc" | "desc" };
type InventoryListArgs = ListArgs & { inventory_negative?: boolean; inventory_exists?: boolean };

function listQuery(a: ListArgs): Query {
  return {
    limit: a.limit,
    start_after: a.start_after,
    complete: a.complete ? "true" : undefined,
    include: a.include || undefined,
    order_by: a.order_by || undefined,
    order_by_direction: a.order_by_direction,
  };
}

function inventoryListQuery(a: InventoryListArgs): Query {
  return {
    ...listQuery(a),
    inventory_negative: a.inventory_negative ? 1 : undefined,
    inventory_exists: a.inventory_exists === undefined ? undefined : String(a.inventory_exists),
  };
}

function getQuery(a: { complete?: boolean; include?: string }): Query {
  return { complete: a.complete === false ? undefined : "true", include: a.include || undefined };
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, env: Env) {
  // Batches -----------------------------------------------------------------

  server.registerTool(
    "brewfather_get_batches",
    {
      description: "List brewing batches. Optionally filter by status. Returns {count, has_more, last_id, items}; paginate with start_after=last_id.",
      inputSchema: { ...listShape, status: z.enum(BATCH_STATUS).optional().describe("Filter by batch status.") },
      annotations: READ,
    },
    (a) => run(async () => paginated(await bfRequest(env, "GET", "/batches", { ...listQuery(a), status: a.status }), a.limit)),
  );

  server.registerTool(
    "brewfather_get_batch",
    {
      description: "Get a batch by _id. Returns full details including recipe, measured values, notes, and events.",
      inputSchema: { batch_id: z.string().min(1).describe("The _id of the batch."), ...getShape },
      annotations: READ,
    },
    (a) => run(() => bfRequest(env, "GET", `/batches/${encodeURIComponent(a.batch_id)}`, getQuery(a))),
  );

  const measured = {
    measured_og: ["measuredOg", "Measured original gravity (SG)."],
    measured_fg: ["measuredFg", "Measured final gravity (SG)."],
    measured_abv: ["measuredAbv", "Measured ABV (%)."],
    measured_efficiency: ["measuredEfficiency", "Measured efficiency (%)."],
    measured_batch_size: ["measuredBatchSize", "Measured batch size (liters)."],
    measured_boil_size: ["measuredBoilSize", "Measured boil size (liters)."],
    measured_pre_boil_gravity: ["measuredPreBoilGravity", "Measured pre-boil gravity (SG)."],
    measured_mash_ph: ["measuredMashPh", "Measured mash pH."],
    measured_first_wort_gravity: ["measuredFirstWortGravity", "Measured first wort gravity (SG)."],
    measured_kettle_size: ["measuredKettleSize", "Measured kettle size (liters)."],
    measured_fermenter_top_up: ["measuredFermenterTopUp", "Measured fermenter top-up (liters)."],
    measured_bottling_size: ["measuredBottlingSize", "Measured bottling size (liters)."],
    measured_conversion_efficiency: ["measuredConversionEfficiency", "Measured conversion efficiency (%)."],
    brew_date: ["brewDate", "Brew date as millisecond UTC timestamp."],
    fermentation_start_date: ["fermentationStartDate", "Fermentation start date as millisecond UTC timestamp."],
    bottling_date: ["bottlingDate", "Bottling date as millisecond UTC timestamp."],
  } as const;

  const updateBatchShape: Record<string, z.ZodTypeAny> = {
    batch_id: z.string().min(1).describe("The _id of the batch to update."),
    status: z.enum(BATCH_STATUS).optional().describe("New batch status."),
  };
  for (const [key, [, desc]] of Object.entries(measured)) {
    updateBatchShape[key] = (key.endsWith("_date") ? z.number().int() : z.number()).optional().describe(desc);
  }

  server.registerTool(
    "brewfather_update_batch",
    {
      description: "Update a batch's status and/or measured values. Only batch_id is required — send only what you want to change. Dates are millisecond UTC timestamps.",
      inputSchema: updateBatchShape,
      annotations: WRITE,
    },
    (a: Record<string, unknown>) =>
      run(async () => {
        const body: Record<string, unknown> = {};
        if (a.status !== undefined) body.status = a.status;
        for (const [key, [apiKey]] of Object.entries(measured)) {
          if (a[key] !== undefined) body[apiKey] = a[key];
        }
        if (Object.keys(body).length === 0) return "Nothing to update — provide at least one field.";
        return bfRequest(env, "PATCH", `/batches/${encodeURIComponent(String(a.batch_id))}`, undefined, body);
      }),
  );

  const batchSub = (name: string, suffix: string, description: string) =>
    server.registerTool(
      name,
      { description, inputSchema: { batch_id: z.string().min(1).describe("The _id of the batch.") }, annotations: READ },
      (a) => run(() => bfRequest(env, "GET", `/batches/${encodeURIComponent(a.batch_id)}${suffix}`)),
    );

  batchSub("brewfather_get_batch_last_reading", "/readings/last", "Get the latest device reading (iSpindel, Tilt, etc.) for a batch: temperature, gravity, battery, angle, timestamp.");
  batchSub("brewfather_get_batch_readings", "/readings", "Get all device readings stored for a batch.");
  batchSub("brewfather_get_batch_brewtracker", "/brewtracker", "Get the brew tracker status for a batch (stages, steps, timing). Empty object when the tracker is not active.");

  // Recipes -----------------------------------------------------------------

  server.registerTool(
    "brewfather_get_recipes",
    {
      description: "List recipes. Default fields: _id, name, author, type, equipment.name, style.name. Set complete=true for all fields. Returns {count, has_more, last_id, items}.",
      inputSchema: listShape,
      annotations: READ,
    },
    (a) => run(async () => paginated(await bfRequest(env, "GET", "/recipes", listQuery(a)), a.limit)),
  );

  server.registerTool(
    "brewfather_get_recipe",
    {
      description: "Get a recipe by _id, including ingredients, style, profiles, and calculated values.",
      inputSchema: { recipe_id: z.string().min(1).describe("The _id of the recipe."), ...getShape },
      annotations: READ,
    },
    (a) => run(() => bfRequest(env, "GET", `/recipes/${encodeURIComponent(a.recipe_id)}`, getQuery(a))),
  );

  // Inventory ---------------------------------------------------------------

  const inventory = [
    { plural: "fermentables", singular: "fermentable", label: "fermentables (grains, extracts, sugars)", unit: "kg" },
    { plural: "hops", singular: "hop", label: "hops", unit: "g" },
    { plural: "miscs", singular: "misc", label: "miscellaneous ingredients (salts, finings, acids, etc.)", unit: "g" },
    { plural: "yeasts", singular: "yeast", label: "yeasts", unit: "packets" },
  ] as const;

  for (const { plural, singular, label, unit } of inventory) {
    const idKey = `${singular}_id`;

    server.registerTool(
      `brewfather_get_${plural}`,
      {
        description: `List ${label} in inventory. Set inventory_exists=true to only show items in stock. Amounts are in ${unit}. Returns {count, has_more, last_id, items}.`,
        inputSchema: inventoryListShape,
        annotations: READ,
      },
      (a) => run(async () => paginated(await bfRequest(env, "GET", `/inventory/${plural}`, inventoryListQuery(a)), a.limit)),
    );

    server.registerTool(
      `brewfather_get_${singular}`,
      {
        description: `Get a single ${singular} from inventory by _id, including its inventory amount (${unit}).`,
        inputSchema: { [idKey]: z.string().min(1).describe(`The _id of the ${singular}.`), ...getShape },
        annotations: READ,
      },
      (a: Record<string, unknown>) =>
        run(() => bfRequest(env, "GET", `/inventory/${plural}/${encodeURIComponent(String(a[idKey]))}`, getQuery(a as { complete?: boolean; include?: string }))),
    );

    server.registerTool(
      `brewfather_update_${singular}`,
      {
        description: `Update a ${singular}'s inventory amount (${unit}). Use inventory for an absolute value, or inventory_adjust to add/subtract. If both are given, inventory wins.`,
        inputSchema: { [idKey]: z.string().min(1).describe(`The _id of the ${singular}.`), ...inventoryUpdateShape },
        annotations: WRITE,
      },
      (a: Record<string, unknown>) =>
        run(async () => {
          const body: Record<string, number> = {};
          if (typeof a.inventory === "number") body.inventory = a.inventory;
          else if (typeof a.inventory_adjust === "number") body.inventory_adjust = a.inventory_adjust;
          if (Object.keys(body).length === 0) return "Nothing to update — provide inventory or inventory_adjust.";
          return bfRequest(env, "PATCH", `/inventory/${plural}/${encodeURIComponent(String(a[idKey]))}`, undefined, body);
        }),
    );
  }
}
