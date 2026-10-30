// Synthetic rollouts only. Filtering never reads a real Codex session in tests.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { filterRollout, type FilteredMedia } from "./filteredRollout.ts";

const id = "11111111-1111-4111-8111-111111111111";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmWQAAAAASUVORK5CYII=",
  "base64",
);
const rows = (values: ReadonlyArray<unknown>) =>
  values.map((x) => JSON.stringify(x)).join("\n") + "\n";

describe("filtered Codex rollout", () => {
  it("keeps every event and long output while redacting secrets and paths outside selected dirs", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "filtered-rollout-"));
    try {
      const repo = NodePath.join(dir, "repo");
      const extra = NodePath.join(dir, "extra");
      const outside = NodePath.join(dir, "outside");
      await Promise.all([repo, extra, outside].map((p) => NodeFSP.mkdir(p)));
      await NodeFSP.symlink(outside, NodePath.join(repo, "escape"));
      const source = NodePath.join(dir, "original.jsonl");
      const destination = NodePath.join(dir, "filtered.jsonl");
      const long = "z".repeat(20_000);
      await NodeFSP.writeFile(
        source,
        rows([
          { type: "session_meta", payload: { id, cwd: repo } },
          {
            type: "turn_context",
            payload: {
              model: "gpt-6",
              approval_policy: "never",
              sandbox_policy: { type: "read-only" },
            },
          },
          {
            type: "response_item",
            payload: {
              type: "reasoning",
              summary: [{ text: "Readable summary" }],
              encrypted_content: "a".repeat(64),
            },
          },
          {
            type: "future_event",
            payload: {
              output: `${long} ${NodePath.join(repo, "src", "a.ts")} ${NodePath.join(extra, "data.txt")} ${NodePath.join(outside, "secret.txt")} ${NodePath.join(repo, "escape", "secret.txt")} ../outside/secret.txt ./src/a.ts ${encodeURIComponent(NodePath.join(outside, "secret.txt"))} API_KEY=verysecretvalue`,
              outside_path: NodePath.join(outside, "private file.txt"),
              token: "unknown-secret-format",
              file_url: `file://${NodePath.join(outside, "private.txt")}`,
              encrypted_content: "pasted-secret-value",
              note: "The client supplied pasted-secret-value in this prompt.",
              prompt: "Keep this ordinary user prompt, even if someone pasted it from a file.",
            },
          },
        ]),
      );
      const output = await filterRollout({
        source,
        destination,
        repoRoot: repo,
        includeDirs: ["../extra"],
        extraRedactions: ["pasted-secret-value"],
        putMedia: async () => {},
      });
      const filtered = (await NodeFSP.readFile(destination, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(output.events).toBe(4);
      expect(output.selectedDirs).toEqual([
        await NodeFSP.realpath(repo),
        await NodeFSP.realpath(extra),
      ]);
      expect(output.bytes).toBe(Buffer.byteLength(await NodeFSP.readFile(destination)));
      expect(filtered.map((x) => x.type)).toEqual([
        "session_meta",
        "turn_context",
        "response_item",
        "future_event",
      ]);
      expect(filtered[2].payload.encrypted_content).toBe("a".repeat(64));
      expect(filtered[3].payload.output).toContain(long);
      expect(filtered[3].payload.output).toContain(NodePath.join(repo, "src", "a.ts"));
      expect(filtered[3].payload.output).toContain(NodePath.join(extra, "data.txt"));
      expect(filtered[3].payload.output).toContain("./src/a.ts");
      expect(filtered[3].payload.output).not.toContain(NodePath.join(outside, "secret.txt"));
      expect(filtered[3].payload.output).not.toContain("../outside/secret.txt");
      expect(filtered[3].payload.output).not.toContain(
        encodeURIComponent(NodePath.join(outside, "secret.txt")),
      );
      expect(filtered[3].payload.output).not.toContain("verysecretvalue");
      expect(filtered[3].payload.outside_path).toBe("[redacted path]");
      expect(filtered[3].payload.token).toBe("[redacted]");
      expect(filtered[3].payload.file_url).toBe("[redacted path]");
      expect(filtered[3].payload.encrypted_content).toBe("[redacted]");
      expect(filtered[3].payload.note).not.toContain("pasted-secret-value");
      expect(filtered[3].payload.prompt).toContain("ordinary user prompt");
      expect(await NodeFSP.readFile(source, "utf8")).toContain("verysecretvalue");
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("extracts embedded and path-only images and marks an unavailable file", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "filtered-media-"));
    try {
      const repo = NodePath.join(dir, "repo");
      await NodeFSP.mkdir(repo);
      const image = png;
      const imagePath = NodePath.join(repo, "image.png");
      await NodeFSP.writeFile(imagePath, image);
      const external = NodePath.join(dir, "external.png");
      await NodeFSP.writeFile(external, Buffer.from("outside bytes"));
      const escape = NodePath.join(repo, "escape.png");
      await NodeFSP.symlink(external, escape);
      const source = NodePath.join(dir, "original.jsonl");
      const destination = NodePath.join(dir, "filtered.jsonl");
      await NodeFSP.writeFile(
        source,
        rows([
          { type: "session_meta", payload: { id } },
          {
            type: "response_item",
            payload: {
              content: [
                { type: "image", mimeType: "image/png", data: image.toString("base64") },
                {
                  type: "input_image",
                  image_url: `data:image/png;base64,${image.toString("base64")}`,
                },
                { type: "image", path: imagePath },
                { type: "image", path: NodePath.join(repo, "gone.png") },
                { type: "image", path: external },
                { type: "image", path: escape },
              ],
            },
          },
        ]),
      );
      const sent: FilteredMedia[] = [];
      const output = await filterRollout({
        source,
        destination,
        repoRoot: repo,
        includeDirs: [],
        putMedia: async (blob) => {
          sent.push(blob);
        },
      });
      const filtered = (await NodeFSP.readFile(destination, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const content = filtered[1].payload.content;
      expect(sent).toHaveLength(1);
      expect(sent[0]!.mime).toBe("image/png");
      expect(sent[0]!.data).toBe(image.toString("base64"));
      expect(output.mediaBytes).toBe(image.length);
      expect(output.missingMedia).toBe(3);
      expect(content[0].data).toMatch(/^toolreader-media:[0-9a-f]{64}$/);
      expect(content[1].image_url).toBe(content[0].data);
      expect(content[2].path).toBe(content[0].data);
      expect(content[3].path).toBe("[missing-media]");
      expect(content[4].path).toBe("[media-outside-scope]");
      expect(content[5].path).toBe("[media-outside-scope]");
      expect(await NodeFSP.readFile(destination, "utf8")).not.toContain(imagePath);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("marks a truncated image data URI while keeping the later complete image", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "filtered-truncated-"));
    try {
      const repo = NodePath.join(dir, "repo");
      await NodeFSP.mkdir(repo);
      const source = NodePath.join(dir, "original.jsonl");
      const destination = NodePath.join(dir, "filtered.jsonl");
      const full = png.toString("base64");
      const truncated = full.slice(0, 38);
      const urlSafe = full.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      await NodeFSP.writeFile(
        source,
        rows([
          { type: "session_meta", payload: { id } },
          {
            type: "response_item",
            payload: { type: "message", text: `preview data:image/png;base64,${truncated} after` },
          },
          {
            type: "response_item",
            payload: { type: "input_image", image_url: `data:image/png;base64,${urlSafe}` },
          },
          {
            type: "response_item",
            payload: {
              type: "image",
              mimeType: "image/png",
              data: `${full.slice(0, 30)}\n${full.slice(30)}`,
            },
          },
        ]),
      );
      const sent: FilteredMedia[] = [];
      const result = await filterRollout({
        source,
        destination,
        repoRoot: repo,
        includeDirs: [],
        putMedia: async (blob) => {
          sent.push(blob);
        },
      });
      const filtered = (await NodeFSP.readFile(destination, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(result.events).toBe(4);
      expect(result.missingMedia).toBe(1);
      expect(sent).toHaveLength(1);
      expect(filtered[1].payload.text).toContain("[missing-media:invalid-or-incomplete]");
      expect(filtered[1].payload.text).toContain("after");
      expect(filtered[2].payload.image_url).toMatch(/^toolreader-media:[0-9a-f]{64}$/);
      expect(filtered[3].payload.data).toBe(filtered[2].payload.image_url);
      expect(await NodeFSP.readFile(destination, "utf8")).not.toContain(truncated);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not publish a partial filtered file when media upload fails", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "filtered-fail-"));
    try {
      const repo = NodePath.join(dir, "repo");
      await NodeFSP.mkdir(repo);
      const source = NodePath.join(dir, "original.jsonl");
      const destination = NodePath.join(dir, "filtered.jsonl");
      await NodeFSP.writeFile(
        source,
        rows([
          { type: "session_meta", payload: { id } },
          {
            type: "response_item",
            payload: { image: `data:image/png;base64,${png.toString("base64")}` },
          },
        ]),
      );
      await expect(
        filterRollout({
          source,
          destination,
          repoRoot: repo,
          includeDirs: [],
          putMedia: async () => {
            throw new Error("bucket unavailable");
          },
        }),
      ).rejects.toThrow("bucket unavailable");
      await expect(NodeFSP.stat(destination)).rejects.toThrow();
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
