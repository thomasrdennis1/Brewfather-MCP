// Offline check of every write tool: stubs fetch, then asserts the exact request sent to
// Brewfather and how API errors are reported. Run with `npm test`.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = fileURLToPath(new URL("..", import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "bf-mcp-")), "tools.mjs");
await build({ entryPoints: [join(repo, "src/tools.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
const { registerTools } = await import(pathToFileURL(out));
const tools = {};
registerTools({ registerTool: (n, cfg, h) => (tools[n] = { cfg, h }) }, { BREWFATHER_USER_ID: "u", BREWFATHER_API_KEY: "k" });
let last, reply = () => new Response("Updated");
globalThis.fetch = async (url, init) => { last = { url: String(url), method: init.method, body: init.body && JSON.parse(init.body) }; return reply(); };
let fail = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(ok ? "ok  " : "FAIL", label, ok ? "" : JSON.stringify(got)); };
const call = async (n, a) => { last = undefined; const r = await tools[n].h(a); return { text: r.content[0].text, err: !!r.isError }; };
console.log(Object.keys(tools).length, "tools:", Object.keys(tools).join(" "));
let r;
r = await call("brewfather_update_fermentable", { fermentable_id: "x", inventory_adjust: 0.001 }); eq("stock-only adjust", last.body, { inventory_adjust: 0.001 });
r = await call("brewfather_update_fermentable", { fermentable_id: "x", inventory: 2, inventory_adjust: 1 }); eq("inventory wins", last.body, { inventory: 2 });
r = await call("brewfather_update_fermentable", { fermentable_id: "x", cost_per_amount: 6.15 }); eq("cost", [last.method, last.url, last.body], ["PATCH", "https://api.brewfather.app/v2/inventory/fermentables/x", { costPerAmount: 6.15 }]);
r = await call("brewfather_update_hop", { hop_id: "x", cost_per_amount: null, inventory_adjust: -5, fields: { _id: "z", _rev: "r", createdAt: "c", supplier: "YVH", costPerAmount: "abc" } }); eq("fields merge + strip", last.body, { supplier: "YVH", costPerAmount: null, inventory_adjust: -5 }); eq("dropped reported", JSON.parse(r.text).ignored_server_managed_fields, ["_id", "_rev", "createdAt"]);
r = await call("brewfather_update_misc", { misc_id: "x", fields: { costPerAmount: "abc" } }); eq("bad value passes through", last.body, { costPerAmount: "abc" });
r = await call("brewfather_update_yeast", { yeast_id: "x" }); eq("empty -> error, no request", [r.err, last], [true, undefined]); console.log("    ", r.text);
r = await call("brewfather_update_yeast", { yeast_id: "x", fields: { _id: "a" } }); eq("only managed -> error, no request", [r.err, last], [true, undefined]); console.log("    ", r.text);
reply = () => new Response("Nothing to update"); r = await call("brewfather_update_batch", { batch_id: "b", fields: { measuredAbv: 4 } }); eq("nothing to update -> error", r.err, true); console.log("    ", r.text);
reply = () => new Response('[{"instancePath":"/costPerAmount","message":"must be number"}]', { status: 400 }); r = await call("brewfather_update_fermentable", { fermentable_id: "x", fields: { costPerAmount: "abc" } }); eq("400 -> error w/ body", [r.err, r.text.includes("must be number")], [true, true]); console.log("    ", r.text);
reply = () => new Response("Forbidden", { status: 403 }); r = await call("brewfather_update_fermentable", { fermentable_id: "x", inventory: 1 }); eq("403 names scope", r.text.includes("inventory.write"), true); console.log("    ", r.text);
r = await call("brewfather_create_recipe", { recipe: { name: "A" } }); eq("403 recipes scope", r.text.includes("recipes.write"), true);
reply = () => new Response("Too many", { status: 429, headers: { "retry-after": "120" } }); r = await call("brewfather_get_batch", { batch_id: "b" }); eq("429 retry-after", r.text.includes("Retry-After: 120"), true);
reply = () => Response.json({ id: "new1" });
r = await call("brewfather_create_hop", { name: "Citra", inventory: 100, cost_per_amount: 0.04, fields: { alpha: 13, _id: "q" } }); eq("create hop", [last.method, last.url, last.body], ["POST", "https://api.brewfather.app/v2/inventory/hops", { alpha: 13, name: "Citra", costPerAmount: 0.04, inventory: 100 }]); eq("create returns id", JSON.parse(r.text).response, { id: "new1" });
r = await call("brewfather_create_recipe", { recipe: { name: "IPA", data: {}, _id: "x", updatedAt: 1, hops: [{ _id: "keep", name: "Citra" }] } }); eq("create recipe", [last.method, last.url, last.body], ["POST", "https://api.brewfather.app/v2/recipes", { name: "IPA", hops: [{ _id: "keep", name: "Citra" }] }]);
r = await call("brewfather_create_recipe", { recipe: { type: "All Grain" } }); eq("recipe needs name", [r.err, last], [true, undefined]);
reply = () => new Response("Updated");
r = await call("brewfather_update_recipe", { recipe_id: "r/1", fields: { boilTime: 90, author: "" } }); eq("update recipe", [last.method, last.url, last.body], ["PATCH", "https://api.brewfather.app/v2/recipes/r%2F1", { boilTime: 90, author: "" }]);
r = await call("brewfather_update_batch", { batch_id: "b", status: "Fermenting", measured_og: 1.05, measured_fg: null, carbonation_temp: 4 }); eq("batch", last.body, { status: "Fermenting", measuredOg: 1.05, measuredFg: null, carbonationTemp: 4 });
// Paging: the API caps a page at 50 whatever limit is sent.
{
  const all = Array.from({ length: 120 }, (_, i) => ({ _id: "id" + String(i).padStart(3, "0") }));
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url); urls.push(u.search);
    const lim = Math.min(Number(u.searchParams.get("limit") ?? 10), 50);
    const from = u.searchParams.get("start_after") ? all.findIndex((x) => x._id === u.searchParams.get("start_after")) + 1 : 0;
    return Response.json(all.slice(from, from + lim));
  };
  let p = JSON.parse((await tools.brewfather_get_recipes.h({ limit: 200 })).content[0].text);
  eq("limit 200 pages through all", [p.count, p.has_more, p.last_id, urls.length], [120, false, "id119", 3]);
  urls.length = 0; p = JSON.parse((await tools.brewfather_get_recipes.h({ limit: 100 })).content[0].text);
  eq("limit 100 of 120 -> has_more", [p.count, p.has_more, p.last_id, urls.length], [100, true, "id099", 2]);
  urls.length = 0; p = JSON.parse((await tools.brewfather_get_hops.h({})).content[0].text);
  eq("default limit", [p.count, p.has_more, urls.length], [10, true, 1]);
}
process.exit(fail ? 1 : 0);
