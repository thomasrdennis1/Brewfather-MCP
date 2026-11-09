import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./index.js";

const API_BASE = "https://api.brewfather.app/v2";
// Brewfather returns 10 items when no limit is passed.
const API_DEFAULT_LIMIT = 10;
// ...and never more than 50 per request, even if a larger limit is asked for.
const API_MAX_LIMIT = 50;

type Query = Record<string, string | number | boolean | undefined>;

class BrewfatherError extends Error {}

/** API-key scope a request needs, e.g. PATCH /inventory/hops/x -> inventory.write. */
function scopeFor(method: string, path: string): string {
  const resource = path.split("/")[1] ?? "unknown";
  return `${resource}.${method === "GET" ? "read" : method === "DELETE" ? "delete" : "write"}`;
}

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

  if (res.ok) {
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  // Brewfather puts the reason in the body ("Invalid status", a JSON array of validation errors, ...). Always pass it on.
  const detail = (await res.text().catch(() => "")).trim().slice(0, 4000);
  const said = detail ? ` Brewfather said: ${detail}` : "";
  const what = `${method} ${path}`;
  switch (res.status) {
    case 400:
      throw new BrewfatherError(`Brewfather rejected ${what} (400 validation error). Nothing was written.${said}`);
    case 401:
      throw new BrewfatherError(`Authentication failed (401). Check the BREWFATHER_USER_ID and BREWFATHER_API_KEY secrets.${said}`);
    case 403:
      throw new BrewfatherError(`Forbidden (403) for ${what}. The API key lacks the ${scopeFor(method, path)} scope — create a key with that scope in Brewfather Settings → API keys and update the Worker secret.${said}`);
    case 404:
      throw new BrewfatherError(`Not found (404) for ${what}. Verify the ID is correct.${said}`);
    case 429:
      throw new BrewfatherError(`Rate limited by Brewfather (429). Retry-After: ${res.headers.get("retry-after") ?? "not given"} seconds. Limit is 500 requests/hour per key.${said}`);
    default:
      throw new BrewfatherError(`Brewfather API error ${res.status} for ${what}.${said}`);
  }
}

type Body = Record<string, unknown>;

/** Root-level keys Brewfather manages itself and ignores on write. */
function isServerManaged(key: string, extra: readonly string[]): boolean {
  return key.startsWith("_") || key === "createdAt" || key === "updatedAt" || extra.includes(key);
}

/** Copy caller-supplied fields, dropping server-managed root keys. Returns the dropped keys so the caller can be told. */
function sanitize(fields: unknown, extra: readonly string[] = []): { clean: Body; dropped: string[] } {
  const clean: Body = {};
  const dropped: string[] = [];
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    for (const [k, v] of Object.entries(fields as Body)) {
      if (v === undefined) continue;
      if (isServerManaged(k, extra)) dropped.push(k);
      else clean[k] = v;
    }
  }
  return { clean, dropped };
}

/** Send a write and report what happened. "Nothing to update" is a 200 from Brewfather but means no field was accepted. */
async function bfWrite(env: Env, method: "POST" | "PATCH", path: string, body: Body, dropped: string[], emptyHint: string): Promise<unknown> {
  const ignored = dropped.length ? ` Ignored server-managed fields: ${dropped.join(", ")}.` : "";
  if (Object.keys(body).length === 0) throw new BrewfatherError(`Nothing to send — ${emptyHint}${ignored}`);
  const response = await bfRequest(env, method, path, undefined, body);
  if (typeof response === "string" && /nothing to update/i.test(response)) {
    throw new BrewfatherError(
      `Brewfather answered "${response.trim()}" for ${method} ${path}: none of the fields sent (${Object.keys(body).join(", ")}) are writable on this endpoint. Nothing was written.${ignored}`,
    );
  }
  const out: Body = { response, sent: body };
  if (dropped.length) out.ignored_server_managed_fields = dropped;
  return out;
}

/**
 * List with paging. Brewfather returns at most API_MAX_LIMIT items per request whatever `limit` says, so larger
 * limits are served by following start_after until the limit is reached or a short page ends the list.
 */
async function bfList(env: Env, path: string, query: Query, limit: number | undefined) {
  const want = limit ?? API_DEFAULT_LIMIT;
  const items: { _id?: string }[] = [];
  const seen = new Set<string>();
  let startAfter = query.start_after;
  let hasMore = false;
  while (items.length < want) {
    const pageSize = Math.min(want - items.length, API_MAX_LIMIT);
    const page = await bfRequest(env, "GET", path, { ...query, limit: pageSize, start_after: startAfter });
    if (!Array.isArray(page)) return page;
    const fresh = (page as { _id?: string }[]).filter((it) => !it._id || !seen.has(it._id));
    for (const it of fresh) if (it._id) seen.add(it._id);
    items.push(...fresh);
    hasMore = page.length >= pageSize;
    const lastId = (page[page.length - 1] as { _id?: string } | undefined)?._id;
    // Stop on a short page, or if the cursor did not advance (nothing new came back).
    if (!hasMore || !lastId || fresh.length === 0) {
      if (fresh.length === 0) hasMore = false;
      break;
    }
    startAfter = lastId;
  }
  return { count: items.length, has_more: hasMore, last_id: items[items.length - 1]?._id ?? null, items };
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
  limit: z.number().int().min(1).max(200).optional().describe("Max items to return (default 10). Brewfather serves 50 per request; larger limits are fetched as several requests. If has_more is true, continue with start_after=last_id."),
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

// Some MCP clients send numbers and objects as strings ("6.15", "{...}", "null"). Accept those; the advertised schema is unchanged.
const fieldsObject = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}, z.record(z.string(), z.unknown()));

const lenientNumber = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const t = v.trim();
    if (t === "null") return null;
    return t !== "" && Number.isFinite(Number(t)) ? Number(t) : v;
  }, schema);

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
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

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
    (a) => run(() => bfList(env, "/batches", { ...listQuery(a), status: a.status }, a.limit)),
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

  // Exactly the fields PATCH /batches/:id accepts. Anything else comes back as "Nothing to update".
  const measured = {
    measured_mash_ph: ["measuredMashPh", "Mash pH (0–14)."],
    measured_boil_size: ["measuredBoilSize", "Pre-boil volume (liters, >= 0)."],
    measured_first_wort_gravity: ["measuredFirstWortGravity", "Pre-sparge / first wort gravity (SG, 0.1–1.9)."],
    measured_pre_boil_gravity: ["measuredPreBoilGravity", "Pre-boil gravity (SG, 0.1–1.9)."],
    measured_post_boil_gravity: ["measuredPostBoilGravity", "Post-boil gravity (SG, 0.1–1.9)."],
    measured_kettle_size: ["measuredKettleSize", "Post-boil volume (liters, >= 0)."],
    measured_og: ["measuredOg", "Original gravity (SG, 0.1–1.9, e.g. 1.055)."],
    measured_fermenter_top_up: ["measuredFermenterTopUp", "Fermenter top-up volume (liters, >= 0)."],
    measured_batch_size: ["measuredBatchSize", "Fermenter volume (liters, >= 0)."],
    measured_fg: ["measuredFg", "Final gravity (SG, 0.1–1.9, e.g. 1.011)."],
    measured_bottling_size: ["measuredBottlingSize", "Final bottling/kegging volume (liters, >= 0)."],
    carbonation_temp: ["carbonationTemp", "Carbonation temperature (°C, -50–100)."],
  } as const;

  const updateBatchShape: Record<string, z.ZodTypeAny> = {
    batch_id: z.string().min(1).describe("The _id of the batch to update."),
    status: z.enum(BATCH_STATUS).optional().describe("New batch status."),
  };
  for (const [key, [, desc]] of Object.entries(measured)) {
    updateBatchShape[key] = lenientNumber(z.number().nullable()).optional().describe(`${desc} Send null to clear.`);
  }
  updateBatchShape.fields = fieldsObject
    .optional()
    .describe("Escape hatch: extra raw API fields (camelCase) merged into the PATCH body. Brewfather currently only writes status, the measured* values above and carbonationTemp; ABV, efficiency, dates, notes etc. are not writable through the API and produce an error here.");

  server.registerTool(
    "brewfather_update_batch",
    {
      description:
        "Update a batch: status, measured gravities/volumes/mash pH, carbonation temperature. Only batch_id is required — send only what you want to change; send null to clear a measured value. ABV and efficiency are calculated by Brewfather from these and cannot be set; batches cannot be created through the API (create them in the app).",
      inputSchema: updateBatchShape,
      annotations: WRITE,
    },
    (a: Record<string, unknown>) =>
      run(async () => {
        const { clean: body, dropped } = sanitize(a.fields);
        if (a.status !== undefined) body.status = a.status;
        for (const [key, [apiKey]] of Object.entries(measured)) {
          if (a[key] !== undefined) body[apiKey] = a[key];
        }
        return bfWrite(env, "PATCH", `/batches/${encodeURIComponent(String(a.batch_id))}`, body, dropped, "provide status, a measured value or fields.");
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
    (a) => run(() => bfList(env, "/recipes", listQuery(a), a.limit)),
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

  const RECIPE_MANAGED = ["data"] as const;
  const recipeFieldHelp =
    "Metric units (liters, kg for fermentables, g for hops, °C, SG). Common root fields: name, type ('All Grain' | 'Partial Mash' | 'Extract'), author, batchSize, boilTime, efficiency, notes, style{}, equipment{}, mash{steps[]}, fermentation{steps[]}, water{}, fermentables[{name, amount(kg), type, color, potential, ...}], hops[{name, amount(g), alpha, use ('Boil' | 'Dry Hop' | 'Mash' | 'First Wort' | 'Aroma'), time, timeUnit, type}], yeasts[{name, amount, unit, type, form, attenuation}], miscs[{name, amount, unit, type, use, time}]. Easiest way to get a valid shape is to read an existing recipe with brewfather_get_recipe and reuse its structure (keep each ingredient's own _id so it stays linked to inventory). Root fields starting with '_', plus createdAt, updatedAt and data (calculated values), are server-managed and dropped.";

  server.registerTool(
    "brewfather_create_recipe",
    {
      description:
        "Create a new recipe. Always creates a separate recipe with a new _id (it never adds a version to an existing one). Returns {response: {id}} with the new _id. Validation errors from Brewfather are returned verbatim.",
      inputSchema: {
        recipe: fieldsObject.describe(`The recipe object. 'name' is required. ${recipeFieldHelp}`),
      },
      annotations: CREATE,
    },
    (a) =>
      run(async () => {
        const { clean: body, dropped } = sanitize(a.recipe, RECIPE_MANAGED);
        if (typeof body.name !== "string" || !body.name.trim()) throw new BrewfatherError("recipe.name is required.");
        return bfWrite(env, "POST", "/recipes", body, dropped, "provide a recipe object.");
      }),
  );

  server.registerTool(
    "brewfather_update_recipe",
    {
      description:
        "Update an existing recipe (its current working version). Shallow merge: each top-level field you send REPLACES that field; fields you omit are kept. Arrays (fermentables, hops, yeasts, miscs) and nested objects (mash, fermentation, water, style, equipment) are replaced whole — to change one hop, read the recipe, edit the hops array and send the full array back. Send null or \"\" to clear an optional top-level field. The merged recipe is validated as a whole; validation errors are returned verbatim.",
      inputSchema: {
        recipe_id: z.string().min(1).describe("The _id of the recipe."),
        fields: fieldsObject.describe(`Top-level recipe fields to replace. ${recipeFieldHelp}`),
      },
      annotations: WRITE,
    },
    (a) =>
      run(async () => {
        const { clean: body, dropped } = sanitize(a.fields, RECIPE_MANAGED);
        return bfWrite(env, "PATCH", `/recipes/${encodeURIComponent(a.recipe_id)}`, body, dropped, "provide at least one recipe field in fields.");
      }),
  );

  // Inventory ---------------------------------------------------------------

  const inventory = [
    {
      plural: "fermentables", singular: "fermentable", label: "fermentables (grains, extracts, sugars)", unit: "kg", costUnit: "per kg",
      fieldHelp: "name, type ('Grain' | 'Sugar' | 'Liquid Extract' | 'Dry Extract' | 'Adjunct' | 'Other'), supplier, origin, grainCategory, color (SRM), potential (SG, e.g. 1.037), potentialPercentage, attenuation, moisture, protein, diastaticPower, notFermentable, notes, userNotes, bestBeforeDate, manufacturingDate, hidden",
    },
    {
      plural: "hops", singular: "hop", label: "hops", unit: "g", costUnit: "per g",
      fieldHelp: "name, alpha (%), beta, type ('Pellet' | 'Whole' | 'Cryo' | 'Plug' | 'ISOExtract' | 'CO2Extract'), use ('Boil' | 'Dry Hop' | 'Mash' | 'First Wort' | 'Aroma'), usage ('Aroma' | 'Bittering' | 'Both'), origin, year, hsi, oil, myrcene, humulene, caryophyllene, farnesene, geraniol, linalool, notes, bestBeforeDate, hidden",
    },
    {
      plural: "miscs", singular: "misc", label: "miscellaneous ingredients (salts, finings, acids, etc.)", unit: "the item's own `unit` field (g, ml, oz, ...)", costUnit: "per one of the item's own `unit` (per g, per ml, per oz, ...)",
      fieldHelp: "name, type ('Spice' | 'Fining' | 'Water Agent' | 'Herb' | 'Flavor' | 'Other'), use ('Boil' | 'Mash' | 'Steep' | 'Primary' | 'Secondary' | 'Bottling' | 'Sparge' | 'Flameout'), unit ('g' | 'mg' | 'kg' | 'oz' | 'lb' | 'ml' | 'l' | 'tsp' | 'tbsp' | 'cup' | 'pkg' | 'items' | 'drops' | ...), time, timeUnit, concentration, waterAdjustment, notes, bestBeforeDate, hidden",
    },
    {
      plural: "yeasts", singular: "yeast", label: "yeasts", unit: "the item's own `unit` field (normally pkg)", costUnit: "per one of the item's own `unit` (normally per packet)",
      fieldHelp: "name, type ('Ale' | 'Lager' | 'Hybrid' | 'Wheat' | 'Wine' | 'Champagne' | 'Other'), form ('Dry' | 'Liquid' | 'Slant' | 'Culture' | 'Slurry'), unit ('pkg' | 'g' | 'ml' | 'billion cells' | 'oz'), laboratory, productId, flocculation ('Low' | 'Medium-Low' | 'Medium' | 'Medium-High' | 'High' | 'Very High'), attenuation, minAttenuation, maxAttenuation, minTemp, maxTemp, maxAbv, bestFor, notes, bestBeforeDate, manufacturingDate, hidden",
    },
  ] as const;

  /** Build an inventory POST/PATCH body. Named parameters win over the same key in `fields`. */
  const inventoryBody = (a: Record<string, unknown>) => {
    const { clean: body, dropped } = sanitize(a.fields);
    if (a.name !== undefined) body.name = a.name;
    if (a.cost_per_amount !== undefined) body.costPerAmount = a.cost_per_amount;
    if (a.inventory !== undefined) body.inventory = a.inventory;
    if (a.inventory_adjust !== undefined) body.inventory_adjust = a.inventory_adjust;
    // inventory wins over inventory_adjust, as in the API.
    if (body.inventory !== undefined) delete body.inventory_adjust;
    return { body, dropped };
  };

  for (const { plural, singular, label, unit, costUnit, fieldHelp } of inventory) {
    const idKey = `${singular}_id`;
    const fieldsHelp = `Raw API fields (camelCase) for anything without its own parameter: ${fieldHelp}. Values are validated by Brewfather and validation errors are returned verbatim. Root fields starting with '_', plus createdAt and updatedAt, are server-managed and dropped.`;
    const costShape = lenientNumber(z.number().min(0).nullable()).optional().describe(`Cost ${costUnit}, in the account's currency (API field costPerAmount). Send null to clear.`);

    server.registerTool(
      `brewfather_get_${plural}`,
      {
        description: `List ${label} in inventory. Set inventory_exists=true to only show items in stock. Stock amounts are in ${unit}. Add include='costPerAmount' (or complete=true) to see cost. Returns {count, has_more, last_id, items}.`,
        inputSchema: inventoryListShape,
        annotations: READ,
      },
      (a) => run(() => bfList(env, `/inventory/${plural}`, inventoryListQuery(a), a.limit)),
    );

    server.registerTool(
      `brewfather_get_${singular}`,
      {
        description: `Get a single ${singular} from inventory by _id, with all fields: stock amount (${unit}), costPerAmount (${costUnit}), supplier, notes, etc.`,
        inputSchema: { [idKey]: z.string().min(1).describe(`The _id of the ${singular}.`), ...getShape },
        annotations: READ,
      },
      (a: Record<string, unknown>) =>
        run(() => bfRequest(env, "GET", `/inventory/${plural}/${encodeURIComponent(String(a[idKey]))}`, getQuery(a as { complete?: boolean; include?: string }))),
    );

    server.registerTool(
      `brewfather_create_${singular}`,
      {
        description: `Create a new ${singular} in inventory. Returns {response: {id}} with the new _id. Check brewfather_get_${plural} first to avoid duplicating an existing item.`,
        inputSchema: {
          name: z.string().min(1).describe(`Name of the ${singular}.`),
          inventory: z.number().optional().describe(`Starting stock amount, in ${unit}.`),
          cost_per_amount: costShape,
          fields: fieldsObject.optional().describe(fieldsHelp),
        },
        annotations: CREATE,
      },
      (a: Record<string, unknown>) =>
        run(async () => {
          const { body, dropped } = inventoryBody({ ...a, inventory_adjust: undefined });
          return bfWrite(env, "POST", `/inventory/${plural}`, body, dropped, "provide a name.");
        }),
    );

    server.registerTool(
      `brewfather_update_${singular}`,
      {
        description: `Update a ${singular}: stock amount (${unit}), cost (${costUnit}), or any other field. Only the fields you send are changed; everything else on the item is left untouched. Use inventory for an absolute stock value or inventory_adjust to add/subtract (if both are given, inventory wins). At least one of inventory, inventory_adjust, cost_per_amount or fields is required.`,
        inputSchema: {
          [idKey]: z.string().min(1).describe(`The _id of the ${singular}.`),
          inventory: z.number().optional().describe(`Set the absolute stock amount, in ${unit}.`),
          inventory_adjust: z.number().optional().describe(`Add (positive) or subtract (negative) from current stock, in ${unit}.`),
          cost_per_amount: costShape,
          fields: fieldsObject.optional().describe(fieldsHelp),
        },
        annotations: WRITE,
      },
      (a: Record<string, unknown>) =>
        run(async () => {
          const { body, dropped } = inventoryBody({ ...a, name: undefined });
          return bfWrite(env, "PATCH", `/inventory/${plural}/${encodeURIComponent(String(a[idKey]))}`, body, dropped, "provide at least one of inventory, inventory_adjust, cost_per_amount or fields.");
        }),
    );
  }
}
