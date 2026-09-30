import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DB_PATH } from "./db.ts";

const LABELS_PATH = process.env.TOOLREADER_LABELS ?? join(homedir(), ".toolreader", "labels.json");
const TIMEOUT_MS = 180_000;

type Store = Record<string, Record<string, string>>;
let store: Store | null = null;

async function load(): Promise<Store> {
  if (!store) store = JSON.parse(await readFile(LABELS_PATH, "utf8").catch(() => "{}")) as Store;
  return store;
}

export async function labelsFor(threadId: string): Promise<Record<string, string>> {
  return (await load())[threadId] ?? {};
}

/** Model + effort from T3's text-generation setting, same defaults T3 uses. */
async function modelSelection(): Promise<{ model: string; effort: string }> {
  const settingsPath = join(dirname(DB_PATH), "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
  const sel = settings.textGenerationModelSelection ?? {};
  const opts = sel.options;
  const effort = Array.isArray(opts) ? opts.find((o: any) => o?.id === "reasoningEffort")?.value : opts?.reasoningEffort;
  // A non-Codex selection (e.g. Claude) can't run through codex exec: fall back to T3's Codex default.
  const isCodex = !sel.instanceId || sel.instanceId === "codex";
  return { model: (isCodex && sel.model) || "gpt-5.6-luna", effort: (isCodex && effort) || "low" };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["labels"],
  properties: {
    labels: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: { type: "string" }, label: { type: "string" } } },
    },
  },
};

export type LabelItem = { id: string; text: string };

function prompt(context: string, items: LabelItem[]): string {
  return [
    "You label actions a coding agent took, for a human skimming what the agent DID.",
    "For each item write one short past-tense phrase (max 9 words) saying what the action did and, when obvious, why.",
    'Good: "Checked how thread messages are persisted". "Ran server typecheck; failed on decider.ts". "Pushed the fix branch".',
    "Name concrete files or subsystems. No filler like 'The agent'. Return every id exactly once.",
    "",
    `Context (user request): ${context.slice(0, 1500)}`,
    "",
    "Items (JSON):",
    JSON.stringify(items),
  ].join("\n");
}

function run(cmd: string, args: string[], input: string, cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
    child.stdin.end(input);
  });
}

/** Labels items with `codex exec` (read-only sandbox, ephemeral), caches and returns all labels for the thread. */
export async function labelWithCodex(threadId: string, context: string, items: LabelItem[]): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "toolreader-"));
  try {
    const schemaPath = join(dir, "schema.json");
    const outPath = join(dir, "out.json");
    await writeFile(schemaPath, JSON.stringify(SCHEMA));
    const { model, effort } = await modelSelection();
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--model", model, "--config", `model_reasoning_effort="${effort}"`, "--output-schema", schemaPath, "--output-last-message", outPath, "-"];
    const { code, stderr } = await run(process.env.CODEX_BIN ?? "codex", args, prompt(context, items), dir);
    if (code !== 0) throw new Error(`codex exec failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" ")}`);
    const out = JSON.parse(await readFile(outPath, "utf8")) as { labels: Array<{ id: string; label: string }> };
    const s = await load();
    const thread = (s[threadId] ??= {});
    const wanted = new Set(items.map((i) => i.id));
    for (const l of out.labels) if (wanted.has(l.id) && l.label.trim()) thread[l.id] = l.label.trim();
    await mkdir(dirname(LABELS_PATH), { recursive: true });
    await writeFile(LABELS_PATH, JSON.stringify(s, null, 1));
    return thread;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
