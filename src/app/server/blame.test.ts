import { beforeEach, expect, it, vi } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";

vi.doMock("./backend.ts", () => ({
  commits: vi.fn(),
  threads: vi.fn(),
  storedBlame: vi.fn(),
  putBlame: vi.fn(),
}));
vi.doMock("./github.ts", () => ({
  canRead: vi.fn(),
  commit: vi.fn(),
  fileAt: vi.fn(),
  blameCommit: vi.fn(),
  compareFiles: vi.fn(),
}));
vi.doMock("./env.ts", () => ({ typesafeKey: () => null }));

const backend = await import("./backend.ts");
const github = await import("./github.ts");
const { evidenceHash, hunkWith, blameLine } = await import("./blame.ts");

const sha = "a".repeat(40);
const detail = {
  sha,
  commit: { message: "test", committer: null },
  files: [
    { filename: "x.ts", patch: "@@ -0,0 +1,2 @@\n+same\n+first\n@@ -4,0 +6,2 @@\n+same\n+second" },
  ],
};
const links = [{ threadId: "t1", turns: [] }];
const threads = [{ thread: { id: "t1", title: "writer" }, entries: [] }];
const url = `https://github.com/acme/app/commit/${sha}#diff-${NodeCrypto.createHash("sha256").update("x.ts").digest("hex")}R6`;

beforeEach(() => {
  vi.mocked(github.canRead).mockResolvedValue(true);
  vi.mocked(github.commit).mockResolvedValue(detail);
  vi.mocked(github.fileAt).mockResolvedValue("same\nfirst\n\n\n\nsame\nsecond");
  vi.mocked(github.blameCommit).mockResolvedValue(sha);
  vi.mocked(backend.commits).mockResolvedValue([
    { sha, subject: "test", committedAt: "2026-01-01T00:00:00Z", links },
  ] as never);
  vi.mocked(backend.threads).mockResolvedValue(threads as never);
});

it("selects the second duplicate by original position", () => {
  expect(hunkWith(detail, "x.ts", 6)?.hunk.header).toBe("@@ -4,0 +6,2 @@");
});

it("does not reuse answers for changed links or thread evidence", async () => {
  vi.mocked(backend.storedBlame).mockResolvedValue({ evidenceHash: "old" } as never);
  await expect(
    blameLine({ login: "test", token: "fake", refreshToken: null, expiresAt: null }, url),
  ).rejects.toThrow("no TypeSafe key");
  expect(evidenceHash(links, threads)).not.toBe(
    evidenceHash([{ ...links[0], turns: ["new"] }], threads),
  );
  expect(evidenceHash(links, threads)).not.toBe(
    evidenceHash(links, [{ ...threads[0], entries: [{ id: "new" }] }]),
  );
});

it("reuses an answer only for identical current evidence", async () => {
  vi.mocked(backend.storedBlame).mockResolvedValue({
    evidenceHash: evidenceHash(links, threads),
    pieces: [],
    main: { id: "none", p: 1 },
    model: "fake",
    inputTokens: 0,
  } as never);
  const result = await blameLine(
    { login: "test", token: "fake", refreshToken: null, expiresAt: null },
    url,
  );
  expect(result.line).toBe(6);
  expect(result.hunk.header).toBe("@@ -4,0 +6,2 @@");
});

it("maps a selected duplicate past a later insertion to the original hunk", async () => {
  const rev = "b".repeat(40);
  vi.mocked(github.commit).mockImplementation(async (_token, _repo, requested) => ({
    ...detail,
    sha: requested === rev ? rev : sha,
  }));
  const original = "same\nfirst\n\n\n\nsame\nsecond";
  vi.mocked(github.fileAt).mockImplementation(async (_token, _repo, _path, requested) =>
    requested === rev ? `inserted\n${original}` : original,
  );
  vi.mocked(github.compareFiles).mockResolvedValue([
    {
      filename: "x.ts",
      patch: "@@ -1,7 +1,8 @@\n+inserted\n same\n first\n \n \n \n same\n second",
    },
  ]);
  vi.mocked(backend.storedBlame).mockResolvedValue({
    evidenceHash: evidenceHash(links, threads),
    pieces: [],
    main: { id: "none", p: 1 },
    model: "fake",
    inputTokens: 0,
  } as never);
  const result = await blameLine(
    { login: "test", token: "fake", refreshToken: null, expiresAt: null },
    url.replace(sha, rev).replace("R6", "R7"),
  );
  expect(result.line).toBe(6);
  expect(result.hunk.header).toBe("@@ -4,0 +6,2 @@");
});
