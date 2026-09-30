import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { DB_PATH, getThread, listThreads, threadHead } from "./db.ts";
import { labelsFor, labelWithCodex, type LabelItem } from "./labels.ts";

const PORT = Number(process.env.PORT ?? 4777);
const DIST = join(import.meta.dirname, "..", "dist");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^[/\\]+/, "");
  const file = join(DIST, rel);
  if (!file.startsWith(DIST + sep)) return json(res, 400, { error: "bad path" });
  const data = await readFile(file).catch(() => null);
  if (!data) {
    const index = await readFile(join(DIST, "index.html")).catch(() => null);
    if (!index) return json(res, 503, { error: "Not built. Run `pnpm start` (or `pnpm dev` and open the Vite URL)." });
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(index);
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(data);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/api/threads") return json(res, 200, listThreads());
    const head = /^\/api\/threads\/([^/]+)\/head$/.exec(path);
    if (req.method === "GET" && head) return json(res, 200, threadHead(decodeURIComponent(head[1]!)));
    const thread = /^\/api\/threads\/([^/]+)$/.exec(path);
    if (req.method === "GET" && thread) {
      const id = decodeURIComponent(thread[1]!);
      const view = getThread(id, await labelsFor(id));
      return view ? json(res, 200, view) : json(res, 404, { error: "thread not found" });
    }
    if (req.method === "POST" && path === "/api/labels") {
      const { threadId, context, items } = (await readBody(req)) as { threadId: string; context: string; items: LabelItem[] };
      if (!threadId || !Array.isArray(items) || items.length === 0) return json(res, 400, { error: "threadId and items required" });
      return json(res, 200, await labelWithCodex(threadId, String(context ?? ""), items.slice(0, 150)));
    }
    if (req.method === "GET" && !path.startsWith("/api/")) return await serveStatic(path, res);
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

listThreads(); // warm the action-count cache
// Local only: this exposes every agent session on the machine.
server.listen(PORT, "127.0.0.1", () => console.log(`toolreader → http://127.0.0.1:${PORT}  (reading ${DB_PATH})`));
