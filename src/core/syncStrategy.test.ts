import { describe, expect, it } from "vite-plus/test";
import { automaticSyncDecision, SYNC_STRATEGIES } from "./syncStrategy.ts";

const id = "11111111-1111-4111-8111-111111111111";
const event = (hook_event_name: string, command?: string, exit_code?: number) =>
  JSON.stringify({
    hook_event_name,
    session_id: id,
    cwd: "/repo",
    tool_input: { command },
    tool_response: { exit_code },
  });

describe("selected history sync strategy", () => {
  it("keeps on-demand manual and ignores unrelated or failed tool calls", () => {
    expect(automaticSyncDecision(event("PostToolUse", "git commit -m x", 0)).sync).toBe(false);
    for (const strategy of SYNC_STRATEGIES)
      expect(automaticSyncDecision(event("PostToolUse", "git status", 0), strategy).sync).toBe(
        false,
      );
    expect(
      automaticSyncDecision(event("PostToolUse", "git commit -m x", 1), "on-commit").sync,
    ).toBe(false);
    expect(automaticSyncDecision(event("PostToolUse", "git commit -m x"), "on-commit").sync).toBe(
      false,
    );
    expect(automaticSyncDecision(event("PostToolUse", "git push", 1), "on-push").sync).toBe(false);
  });
  it("selects one trigger and links only a successful commit", () => {
    expect(
      automaticSyncDecision(event("PostToolUse", "git commit -m x", 0), "on-commit"),
    ).toMatchObject({ sync: true, linkHead: true, session: id, repo: "/repo" });
    expect(
      automaticSyncDecision(event("PostToolUse", "git push origin main", 0), "on-push"),
    ).toMatchObject({ sync: true, linkHead: false });
    expect(automaticSyncDecision(event("SessionEnd"), "full")).toMatchObject({
      sync: true,
      detached: true,
      linkHead: false,
    });
    expect(automaticSyncDecision(event("SessionEnd"), "on-push").sync).toBe(false);
    expect(
      automaticSyncDecision(
        event("PostToolUse", "git -c user.name=Agent commit -m x", 0),
        "on-commit",
      ).sync,
    ).toBe(true);
    expect(
      automaticSyncDecision(
        event("PostToolUse", "cd /work/repo && git push origin main", 0),
        "on-push",
      ),
    ).toMatchObject({ sync: true, repo: "/work/repo" });
    expect(
      automaticSyncDecision(event("PostToolUse", "git -C /work/repo push", 0), "on-push"),
    ).toMatchObject({ sync: true, repo: "/work/repo" });
    expect(
      automaticSyncDecision(
        JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: id,
          cwd: "/repo",
          tool_input: { command: "git commit -m x" },
          tool_response: { metadata: { exit_code: 0 } },
        }),
        "on-commit",
      ).sync,
    ).toBe(true);
    expect(() => automaticSyncDecision(event("SessionEnd"), "sometimes")).toThrow();
  });
});
