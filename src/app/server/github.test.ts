import { afterEach, expect, it, vi } from "@effect/vitest";
import { pullCommits } from "./github.ts";

afterEach(() => vi.unstubAllGlobals());

it("reads later PR commit pages, including a short final page", async () => {
  const commit = (sha: string) => ({ sha, commit: { message: sha, committer: null } });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => commit(String(i)))), {
        headers: { link: '<https://api.github.com/next>; rel="next"' },
      }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify([commit("last")])));
  vi.stubGlobal("fetch", fetch);
  const commits = await pullCommits("fake", "acme/app", 1);
  expect(commits).toHaveLength(101);
  expect(commits.at(-1)?.sha).toBe("last");
  expect(fetch.mock.calls[1]?.[0]).toContain("page=2");
});
