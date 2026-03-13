import json
import os
import base64
from enum import Enum
from typing import Optional

from dotenv import load_dotenv
import httpx

load_dotenv()
from pydantic import BaseModel, Field, ConfigDict
from fastmcp import FastMCP

mcp = FastMCP("brewfather_mcp")

API_BASE = "https://api.brewfather.app/v2"

_http_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(timeout=30)
    return _http_client


def _get_auth_header() -> dict[str, str]:
    user_id = os.environ.get("BREWFATHER_USER_ID", "")
    api_key = os.environ.get("BREWFATHER_API_KEY", "")
    if not user_id or not api_key:
        raise ValueError(
            "BREWFATHER_USER_ID and BREWFATHER_API_KEY environment variables must be set"
        )
    token = base64.b64encode(f"{user_id}:{api_key}".encode()).decode()
    return {"authorization": f"Basic {token}"}


async def _request(
    method: str,
    path: str,
    params: Optional[dict] = None,
    json_body: Optional[dict] = None,
) -> dict | list | str:
    """Make an authenticated request to the Brewfather API with actionable errors."""
    headers = _get_auth_header()
    url = f"{API_BASE}{path}"
    client = _get_client()

    response = await client.request(
        method, url, headers=headers, params=params, json=json_body
    )

    if response.status_code == 401:
        raise ValueError(
            "Authentication failed (401). Verify BREWFATHER_USER_ID and BREWFATHER_API_KEY environment variables are correct."
        )
    if response.status_code == 403:
        raise ValueError(
            f"Forbidden (403) for {method} {path}. Your API key may lack the required scope. "
            "Check Brewfather Settings → API to enable the needed scope (e.g. batches.read, inventory.write)."
        )
    if response.status_code == 404:
        raise ValueError(
            f"Not found (404) for {path}. Verify the ID is correct and the resource exists."
        )
    if response.status_code == 429:
        retry_after = response.headers.get("Retry-After", "unknown")
        raise ValueError(
            f"Rate limited by Brewfather (429). Retry after {retry_after} seconds. "
            "The API allows 500 requests per hour per key."
        )
    response.raise_for_status()

    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        return response.json()
    return response.text


def _paginated_response(items: list, limit: Optional[int]) -> dict:
    """Wrap a list response with pagination metadata."""
    effective_limit = limit if limit is not None else 50
    last_id = items[-1]["_id"] if items and isinstance(items[-1], dict) and "_id" in items[-1] else None
    return {
        "count": len(items),
        "has_more": len(items) >= effective_limit,
        "last_id": last_id,
        "items": items,
    }


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class BatchStatus(str, Enum):
    Planning = "Planning"
    Brewing = "Brewing"
    Fermenting = "Fermenting"
    Conditioning = "Conditioning"
    Completed = "Completed"
    Archived = "Archived"


class SortDirection(str, Enum):
    asc = "asc"
    desc = "desc"


# ---------------------------------------------------------------------------
# Shared Pydantic models
# ---------------------------------------------------------------------------


class ListParams(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    limit: Optional[int] = Field(default=None, description="Max items to return (API default ~50).", ge=1, le=200)
    start_after: Optional[str] = Field(default=None, description="Pagination cursor — pass the _id of the last item from the previous page.", min_length=1)
    complete: bool = Field(default=False, description="If true, return all fields. Otherwise only default summary fields.")
    include: Optional[str] = Field(default=None, description="Comma-separated list of extra fields to include (e.g. 'recipe.fermentables').")
    order_by: Optional[str] = Field(default=None, description="Field name to order results by.")
    order_by_direction: Optional[SortDirection] = Field(default=None, description="Sort direction: 'asc' or 'desc'.")


class InventoryListParams(ListParams):
    inventory_negative: Optional[int] = Field(default=None, description="Set to 1 to only return items with negative inventory.")
    inventory_exists: Optional[bool] = Field(default=None, description="If true, only return items that have an inventory amount set.")


class GetByIdParams(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    complete: bool = Field(default=True, description="If true, return all fields.")
    include: Optional[str] = Field(default=None, description="Comma-separated list of extra fields to include.")


class InventoryUpdateParams(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    inventory: Optional[float] = Field(default=None, description="Set the absolute inventory amount.")
    inventory_adjust: Optional[float] = Field(default=None, description="Add (positive) or subtract (negative) from current inventory.")


def _list_query(params: ListParams) -> dict:
    """Convert a ListParams model to API query dict."""
    q: dict = {}
    if params.limit is not None:
        q["limit"] = params.limit
    if params.start_after:
        q["start_after"] = params.start_after
    if params.complete:
        q["complete"] = "true"
    if params.include:
        q["include"] = params.include
    if params.order_by:
        q["order_by"] = params.order_by
    if params.order_by_direction:
        q["order_by_direction"] = params.order_by_direction.value
    return q


def _inventory_list_query(params: InventoryListParams) -> dict:
    q = _list_query(params)
    if params.inventory_negative is not None:
        q["inventory_negative"] = params.inventory_negative
    if params.inventory_exists is not None:
        q["inventory_exists"] = str(params.inventory_exists).lower()
    return q


def _get_by_id_query(params: GetByIdParams) -> dict:
    q: dict = {}
    if params.complete:
        q["complete"] = "true"
    if params.include:
        q["include"] = params.include
    return q


def _inventory_update_body(params: InventoryUpdateParams) -> dict | None:
    body: dict = {}
    if params.inventory is not None:
        body["inventory"] = params.inventory
    if params.inventory_adjust is not None:
        body["inventory_adjust"] = params.inventory_adjust
    return body or None


# ---------------------------------------------------------------------------
# Read-only annotation shorthand
# ---------------------------------------------------------------------------

_READ = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": True,
}

_WRITE = {
    "readOnlyHint": False,
    "destructiveHint": True,
    "idempotentHint": False,
    "openWorldHint": True,
}


# ---------------------------------------------------------------------------
# Batches
# ---------------------------------------------------------------------------


class BatchListParams(ListParams):
    status: Optional[BatchStatus] = Field(default=None, description="Filter by batch status: Planning, Brewing, Fermenting, Conditioning, Completed, or Archived.")


@mcp.tool(name="brewfather_get_batches", annotations=_READ)
async def brewfather_get_batches(params: BatchListParams) -> str:
    """List brewing batches from Brewfather. Optionally filter by status. Returns pagination metadata with items. Use start_after with the _id of the last item to paginate."""
    q = _list_query(params)
    if params.status:
        q["status"] = params.status.value
    result = await _request("GET", "/batches", params=q)
    if isinstance(result, list):
        return json.dumps(_paginated_response(result, params.limit))
    return json.dumps(result)


@mcp.tool(name="brewfather_get_batch", annotations=_READ)
async def brewfather_get_batch(batch_id: str = Field(description="The _id of the batch to retrieve.", min_length=1), complete: bool = True, include: Optional[str] = None) -> str:
    """Get a specific brewing batch by its _id. Returns full batch details including recipe, measured values, readings, notes, and events by default."""
    q = _get_by_id_query(GetByIdParams(complete=complete, include=include))
    result = await _request("GET", f"/batches/{batch_id}", params=q)
    return json.dumps(result)


class BatchUpdateParams(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    batch_id: str = Field(description="The _id of the batch to update.", min_length=1)
    status: Optional[BatchStatus] = Field(default=None, description="Set batch status: Planning, Brewing, Fermenting, Conditioning, Completed, or Archived.")
    measured_og: Optional[float] = Field(default=None, description="Measured original gravity (SG).")
    measured_fg: Optional[float] = Field(default=None, description="Measured final gravity (SG).")
    measured_abv: Optional[float] = Field(default=None, description="Measured ABV (%).")
    measured_efficiency: Optional[float] = Field(default=None, description="Measured efficiency (%).")
    measured_batch_size: Optional[float] = Field(default=None, description="Measured batch size (liters).")
    measured_boil_size: Optional[float] = Field(default=None, description="Measured boil size (liters).")
    measured_pre_boil_gravity: Optional[float] = Field(default=None, description="Measured pre-boil gravity (SG).")
    measured_mash_ph: Optional[float] = Field(default=None, description="Measured mash pH.")
    measured_first_wort_gravity: Optional[float] = Field(default=None, description="Measured first wort gravity (SG).")
    measured_kettle_size: Optional[float] = Field(default=None, description="Measured kettle size (liters).")
    measured_fermenter_top_up: Optional[float] = Field(default=None, description="Measured fermenter top-up (liters).")
    measured_bottling_size: Optional[float] = Field(default=None, description="Measured bottling size (liters).")
    measured_conversion_efficiency: Optional[float] = Field(default=None, description="Measured conversion efficiency (%).")
    brew_date: Optional[int] = Field(default=None, description="Brew date as millisecond UTC timestamp.")
    fermentation_start_date: Optional[int] = Field(default=None, description="Fermentation start date as millisecond UTC timestamp.")
    bottling_date: Optional[int] = Field(default=None, description="Bottling date as millisecond UTC timestamp.")


@mcp.tool(name="brewfather_update_batch", annotations=_WRITE)
async def brewfather_update_batch(params: BatchUpdateParams) -> str:
    """Update a batch's status and/or measured values. All fields except batch_id are optional — send only what you want to change. Dates are millisecond UTC timestamps."""
    body: dict = {}
    if params.status is not None:
        body["status"] = params.status.value

    measured_fields = {
        "measuredOg": params.measured_og,
        "measuredFg": params.measured_fg,
        "measuredAbv": params.measured_abv,
        "measuredEfficiency": params.measured_efficiency,
        "measuredBatchSize": params.measured_batch_size,
        "measuredBoilSize": params.measured_boil_size,
        "measuredPreBoilGravity": params.measured_pre_boil_gravity,
        "measuredMashPh": params.measured_mash_ph,
        "measuredFirstWortGravity": params.measured_first_wort_gravity,
        "measuredKettleSize": params.measured_kettle_size,
        "measuredFermenterTopUp": params.measured_fermenter_top_up,
        "measuredBottlingSize": params.measured_bottling_size,
        "measuredConversionEfficiency": params.measured_conversion_efficiency,
    }
    date_fields = {
        "brewDate": params.brew_date,
        "fermentationStartDate": params.fermentation_start_date,
        "bottlingDate": params.bottling_date,
    }
    for key, val in {**measured_fields, **date_fields}.items():
        if val is not None:
            body[key] = val

    if not body:
        return "Nothing to update — provide at least one field."

    result = await _request("PATCH", f"/batches/{params.batch_id}", json_body=body)
    return str(result)


@mcp.tool(name="brewfather_get_batch_last_reading", annotations=_READ)
async def brewfather_get_batch_last_reading(batch_id: str = Field(description="The _id of the batch.", min_length=1)) -> str:
    """Get the latest reading (e.g. iSpindel, Tilt, or other connected device) for a batch. Returns temperature, gravity, battery, angle, and timestamp."""
    result = await _request("GET", f"/batches/{batch_id}/readings/last")
    return json.dumps(result)


@mcp.tool(name="brewfather_get_batch_readings", annotations=_READ)
async def brewfather_get_batch_readings(batch_id: str = Field(description="The _id of the batch.", min_length=1)) -> str:
    """Get all readings stored for a batch. Each reading includes temperature, gravity, and timestamp from connected devices."""
    result = await _request("GET", f"/batches/{batch_id}/readings")
    return json.dumps(result)


@mcp.tool(name="brewfather_get_batch_brewtracker", annotations=_READ)
async def brewfather_get_batch_brewtracker(batch_id: str = Field(description="The _id of the batch.", min_length=1)) -> str:
    """Get the latest brew tracker status for a batch. Returns stages, steps, and timing. Returns empty object when tracker is not active."""
    result = await _request("GET", f"/batches/{batch_id}/brewtracker")
    return json.dumps(result)


# ---------------------------------------------------------------------------
# Recipes
# ---------------------------------------------------------------------------


@mcp.tool(name="brewfather_get_recipes", annotations=_READ)
async def brewfather_get_recipes(params: ListParams) -> str:
    """List recipes from Brewfather. Returns pagination metadata with items. Default summary fields: _id, name, author, type, equipment.name, style.name. Set complete=true for all fields."""
    q = _list_query(params)
    result = await _request("GET", "/recipes", params=q)
    if isinstance(result, list):
        return json.dumps(_paginated_response(result, params.limit))
    return json.dumps(result)


@mcp.tool(name="brewfather_get_recipe", annotations=_READ)
async def brewfather_get_recipe(recipe_id: str = Field(description="The _id of the recipe to retrieve.", min_length=1), complete: bool = True, include: Optional[str] = None) -> str:
    """Get a specific recipe by its _id. Returns full recipe details including ingredients, style, profiles, and calculated values by default."""
    q = _get_by_id_query(GetByIdParams(complete=complete, include=include))
    result = await _request("GET", f"/recipes/{recipe_id}", params=q)
    return json.dumps(result)


# ---------------------------------------------------------------------------
# Inventory — Fermentables
# ---------------------------------------------------------------------------


@mcp.tool(name="brewfather_get_fermentables", annotations=_READ)
async def brewfather_get_fermentables(params: InventoryListParams) -> str:
    """List fermentables in inventory. Set inventory_exists=true to only show items with stock. Returns pagination metadata with items."""
    q = _inventory_list_query(params)
    result = await _request("GET", "/inventory/fermentables", params=q)
    if isinstance(result, list):
        return json.dumps(_paginated_response(result, params.limit))
    return json.dumps(result)


@mcp.tool(name="brewfather_get_fermentable", annotations=_READ)
async def brewfather_get_fermentable(fermentable_id: str = Field(description="The _id of the fermentable.", min_length=1), complete: bool = True, include: Optional[str] = None) -> str:
    """Get a specific fermentable ingredient by its _id including type, supplier, color, potential, and inventory amount."""
    q = _get_by_id_query(GetByIdParams(complete=complete, include=include))
    result = await _request("GET", f"/inventory/fermentables/{fermentable_id}", params=q)
    return json.dumps(result)


@mcp.tool(name="brewfather_update_fermentable", annotations=_WRITE)
async def brewfather_update_fermentable(fermentable_id: str = Field(description="The _id of the fermentable.", min_length=1), params: InventoryUpdateParams = InventoryUpdateParams()) -> str:
    """Update a fermentable's inventory amount. Set inventory for an absolute value, or inventory_adjust to add/subtract. If both provided, inventory takes precedence."""
    body = _inventory_update_body(params)
    if not body:
        return "Nothing to update — provide inventory or inventory_adjust."
    result = await _request("PATCH", f"/inventory/fermentables/{fermentable_id}", json_body=body)
    return str(result)


# ---------------------------------------------------------------------------
# Inventory — Hops
# ---------------------------------------------------------------------------


@mcp.tool(name="brewfather_get_hops", annotations=_READ)
async def brewfather_get_hops(params: InventoryListParams) -> str:
    """List hops in inventory. Set inventory_exists=true to only show items with stock. Returns pagination metadata with items."""
    q = _inventory_list_query(params)
    result = await _request("GET", "/inventory/hops", params=q)
    if isinstance(result, list):
        return json.dumps(_paginated_response(result, params.limit))
    return json.dumps(result)


@mcp.tool(name="brewfather_get_hop", annotations=_READ)
async def brewfather_get_hop(hop_id: str = Field(description="The _id of the hop.", min_length=1), complete: bool = True, include: Optional[str] = None) -> str:
    """Get a specific hop by its _id including alpha acid, type, use, supplier, and inventory amount."""
    q = _get_by_id_query(GetByIdParams(complete=complete, include=include))
    result = await _request("GET", f"/inventory/hops/{hop_id}", params=q)
    return json.dumps(result)


@mcp.tool(name="brewfather_update_hop", annotations=_WRITE)
async def brewfather_update_hop(hop_id: str = Field(description="The _id of the hop.", min_length=1), params: InventoryUpdateParams = InventoryUpdateParams()) -> str:
    """Update a hop's inventory amount. Set inventory for an absolute value, or inventory_adjust to add/subtract. If both provided, inventory takes precedence."""
    body = _inventory_update_body(params)
    if not body:
        return "Nothing to update — provide inventory or inventory_adjust."
    result = await _request("PATCH", f"/inventory/hops/{hop_id}", json_body=body)
    return str(result)


# ---------------------------------------------------------------------------
# Inventory — Miscs
# ---------------------------------------------------------------------------


@mcp.tool(name="brewfather_get_miscs", annotations=_READ)
async def brewfather_get_miscs(params: InventoryListParams) -> str:
    """List miscellaneous ingredients in inventory (salts, finings, acids, etc.). Set inventory_exists=true to only show items with stock."""
    q = _inventory_list_query(params)
    result = await _request("GET", "/inventory/miscs", params=q)
    if isinstance(result, list):
        return json.dumps(_paginated_response(result, params.limit))
    return json.dumps(result)


@mcp.tool(name="brewfather_get_misc", annotations=_READ)
async def brewfather_get_misc(misc_id: str = Field(description="The _id of the misc ingredient.", min_length=1), complete: bool = True, include: Optional[str] = None) -> str:
    """Get a specific miscellaneous ingredient by its _id including type, use, and inventory amount."""
    q = _get_by_id_query(GetByIdParams(complete=complete, include=include))
    result = await _request("GET", f"/inventory/miscs/{misc_id}", params=q)
    return json.dumps(result)


@mcp.tool(name="brewfather_update_misc", annotations=_WRITE)
async def brewfather_update_misc(misc_id: str = Field(description="The _id of the misc ingredient.", min_length=1), params: InventoryUpdateParams = InventoryUpdateParams()) -> str:
    """Update a misc ingredient's inventory amount. Set inventory for an absolute value, or inventory_adjust to add/subtract. If both provided, inventory takes precedence."""
    body = _inventory_update_body(params)
    if not body:
        return "Nothing to update — provide inventory or inventory_adjust."
    result = await _request("PATCH", f"/inventory/miscs/{misc_id}", json_body=body)
    return str(result)


# ---------------------------------------------------------------------------
# Inventory — Yeasts
# ---------------------------------------------------------------------------


@mcp.tool(name="brewfather_get_yeasts", annotations=_READ)
async def brewfather_get_yeasts(params: InventoryListParams) -> str:
    """List yeasts in inventory. Set inventory_exists=true to only show items with stock. Returns pagination metadata with items."""
    q = _inventory_list_query(params)
    result = await _request("GET", "/inventory/yeasts", params=q)
    if isinstance(result, list):
        return json.dumps(_paginated_response(result, params.limit))
    return json.dumps(result)


@mcp.tool(name="brewfather_get_yeast", annotations=_READ)
async def brewfather_get_yeast(yeast_id: str = Field(description="The _id of the yeast.", min_length=1), complete: bool = True, include: Optional[str] = None) -> str:
    """Get a specific yeast by its _id including type, form, flocculation, attenuation, and inventory amount."""
    q = _get_by_id_query(GetByIdParams(complete=complete, include=include))
    result = await _request("GET", f"/inventory/yeasts/{yeast_id}", params=q)
    return json.dumps(result)


@mcp.tool(name="brewfather_update_yeast", annotations=_WRITE)
async def brewfather_update_yeast(yeast_id: str = Field(description="The _id of the yeast.", min_length=1), params: InventoryUpdateParams = InventoryUpdateParams()) -> str:
    """Update a yeast's inventory amount. Set inventory for an absolute value, or inventory_adjust to add/subtract. If both provided, inventory takes precedence."""
    body = _inventory_update_body(params)
    if not body:
        return "Nothing to update — provide inventory or inventory_adjust."
    result = await _request("PATCH", f"/inventory/yeasts/{yeast_id}", json_body=body)
    return str(result)


if __name__ == "__main__":
    mcp.run()
