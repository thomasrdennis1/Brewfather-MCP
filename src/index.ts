import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "./tools.js";
import icon512 from "../assets/icon-512.png";
import icon192 from "../assets/icon-192.png";
import icon32 from "../assets/icon-32.png";
import faviconIco from "../assets/favicon.ico";
import iconSvg from "../assets/icon.svg";
import indexHtml from "../assets/index.html";

const STATIC: Record<string, [BodyInit, string]> = {
  "/": [indexHtml, "text/html; charset=utf-8"],
  "/favicon.ico": [faviconIco, "image/x-icon"],
  "/icon.svg": [iconSvg, "image/svg+xml"],
  "/icon-32.png": [icon32, "image/png"],
  "/icon-192.png": [icon192, "image/png"],
  "/icon-512.png": [icon512, "image/png"],
  "/apple-touch-icon.png": [icon192, "image/png"],
};

export interface Env {
  BREWFATHER_USER_ID: string;
  BREWFATHER_API_KEY: string;
  /** Shared secret, sent as "Authorization: Bearer <secret>". At least 32 characters. */
  MCP_SECRET: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function authorized(request: Request, env: Env): boolean {
  if (!env.MCP_SECRET || env.MCP_SECRET.length < 32) return false;
  // Header only: secrets in URLs end up in logs. Accept "Bearer <secret>", a bare
  // "<secret>", or a doubled "Bearer Bearer <secret>" (some clients prepend "Bearer").
  const auth = (request.headers.get("authorization") ?? "").trim().replace(/^(bearer\s+)+/i, "").trim();
  return auth.length > 0 && timingSafeEqual(auth, env.MCP_SECRET);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const asset = STATIC[url.pathname];
    if (asset && request.method === "GET") {
      return new Response(asset[0], { headers: { "content-type": asset[1], "cache-control": "public, max-age=86400" } });
    }
    if (url.pathname === "/health") {
      return new Response("brewfather-mcp: ok\n");
    }
    if (url.pathname !== "/mcp") {
      return new Response("Not found\n", { status: 404 });
    }
    if (!authorized(request, env)) {
      return json(401, { error: "unauthorized" });
    }

    // Stateless: no sessions, no SSE stream, nothing persisted between requests.
    if (request.method !== "POST") {
      return json(405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed (stateless server: POST only)" },
        id: null,
      });
    }

    const server = new McpServer({
      name: "brewfather_mcp",
      title: "Brewfather",
      version: "2.0.0",
      websiteUrl: url.origin,
      icons: [
        { src: `${url.origin}/icon-192.png`, mimeType: "image/png", sizes: ["192x192"] },
        { src: `${url.origin}/icon-512.png`, mimeType: "image/png", sizes: ["512x512"] },
        { src: `${url.origin}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
      ],
    });
    registerTools(server, env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
