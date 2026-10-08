import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ThreadView } from "../core/domain.ts";
import type { ProofArtifact } from "../core/proof.ts";

// Exercise ActionView's effects without a browser, server, or provider process.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as { deps: unknown[]; cleanup?: (() => void) | undefined }[],
  effectCursor: 0,
  callbacks: [] as { deps: unknown[]; callback: unknown }[],
  callbackCursor: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states))
      hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.states[index],
      (value: unknown) => {
        hooks.states[index] = typeof value === "function" ? value(hooks.states[index]) : value;
      },
    ];
  },
  useCallback: (callback: unknown, deps: unknown[]) => {
    const index = hooks.callbackCursor++;
    const previous = hooks.callbacks[index];
    if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i])))
      return previous.callback;
    hooks.callbacks[index] = { deps, callback };
    return callback;
  },
  useMemo: (compute: () => unknown) => compute(),
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const index = hooks.effectCursor++;
    const previous = hooks.effects[index];
    if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
    previous?.cleanup?.();
    hooks.effects[index] = { deps, cleanup: effect() };
  },
}));
vi.mock("./client.ts", () => ({
  call: (request: (api: unknown) => unknown) => request(api),
  errorMessage: String,
}));
const get = vi.fn();
const head = vi.fn();
const api = { threads: { get, head } };
import { ActionView } from "./ActionView.tsx";

function view(
  status: ThreadView["thread"]["status"],
  marker = "one",
  prompt = "First turn",
): ThreadView {
  return {
    thread: {
      id: "codex:demo",
      source: "codex",
      origin: null,
      title: "Demo",
      projectId: "demo",
      projectTitle: "Demo",
      provider: "codex",
      status,
      archived: false,
      updatedAt: "2026-01-01T10:00:00Z",
      actionCount: 0,
      worktree: null,
      head: marker,
    },
    entries: [
      { type: "message", id: marker, role: "user", at: "2026-01-01T10:00:00Z", text: prompt },
    ],
    labels: {},
  };
}
function render(props: Parameters<typeof ActionView>[0]) {
  hooks.cursor = 0;
  hooks.effectCursor = 0;
  hooks.callbackCursor = 0;
  return ActionView(props);
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers();
  hooks.states = [];
  hooks.effects = [];
  hooks.callbacks = [];
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("document", { title: "" });
  get.mockReset();
  head.mockReset();
});
afterEach(() => {
  for (const effect of hooks.effects) effect.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ActionView live history", () => {
  it("keeps polling across running → idle → later interactive turns", async () => {
    let current = view("running");
    get.mockImplementation(async () => current);
    head.mockImplementation(async () => ({
      head: current.thread.head,
      status: current.thread.status,
    }));
    const props = { threadId: current.thread.id };
    render(props);
    await settle();
    render(props);
    current = view("idle"); // Status may change without a new head marker.
    await vi.advanceTimersByTimeAsync(3000);
    expect(get).toHaveBeenCalledTimes(2);
    render(props);
    await vi.advanceTimersByTimeAsync(3000);
    expect(get).toHaveBeenCalledTimes(2); // Unchanged idle head is cheap.
    current = view("running", "two", "Later interactive turn");
    await vi.advanceTimersByTimeAsync(3000);
    expect(JSON.stringify(render(props))).toContain("Later interactive turn");
    current = view("idle", "three", "Later completed turn");
    await vi.advanceTimersByTimeAsync(3000);
    expect(JSON.stringify(render(props))).toContain("Later completed turn");
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("starts watching a thread that is already idle", async () => {
    get.mockResolvedValue(view("idle"));
    head.mockResolvedValue({ head: "two", status: "idle" });
    render({ threadId: "codex:demo" });
    await settle();
    render({ threadId: "codex:demo" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each(["proof", "given", "embedded"])(
    "keeps %s views read-only even with a thread id",
    async (mode) => {
      const snapshot = view("running");
      const artifact: ProofArtifact = {
        formatVersion: 1,
        exportedAt: snapshot.thread.updatedAt,
        toolreaderVersion: "test",
        git: null,
        scope: { turns: null, range: null },
        outputs: "included",
        redactions: 0,
        view: snapshot,
      };
      const output = render({
        threadId: snapshot.thread.id,
        ...(mode === "proof" ? { artifact } : { view: snapshot, embedded: mode === "embedded" }),
      });
      await vi.advanceTimersByTimeAsync(9000);
      expect(get).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();
      expect(JSON.stringify(output)).not.toContain("/proof");
      const tree =
        mode === "embedded"
          ? output
          : output.props.children.find(
              (child: { props?: { className?: string } }) => child?.props?.className === "tree",
            );
      for (const turn of tree.props.children[0]) {
        expect(turn.props.onLabel).toBeUndefined();
        expect(turn.props.exportLink).toBeUndefined();
      }
    },
  );
});
