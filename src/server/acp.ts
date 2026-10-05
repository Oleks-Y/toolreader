// One prompt to an ACP agent (https://agentclientprotocol.com), e.g. `codex-acp`, over stdio:
// initialize, a session in `cwd`, model and effort set through session config options, the prompt,
// and the agent's reply text. JSON-RPC rides on the Codex app-server protocol client, which leaves
// out the `"jsonrpc"` field ACP requires, so each outgoing line gets it here. The agent may not act:
// every permission request is answered "cancelled". Sanitizer.ts uses it for its agent pass.
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CodexAppServerRequestError } from "../codex-app-server/errors.ts";
import { makeTerminationError } from "../codex-app-server/_internal/stdio.ts";
import { makeCodexAppServerPatchedProtocol } from "../codex-app-server/protocol.ts";

export class AcpFailed extends Schema.TaggedErrorClass<AcpFailed>()("AcpFailed", {
  message: Schema.String,
}) {}

export interface AcpPrompt {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly cwd: string;
  /** Values of the session's `model` and `reasoning_effort` config options. */
  readonly model: string | null;
  readonly effort: string | null;
  readonly text: string;
}

const NewSession = Schema.Struct({ sessionId: Schema.String });
const decodeNewSession = Schema.decodeUnknownEffect(NewSession);
const MessageChunk = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Struct({
    sessionUpdate: Schema.Literal("agent_message_chunk"),
    content: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  }),
});
const decodeChunk = Schema.decodeUnknownOption(MessageChunk);

const encoder = new TextEncoder();
const withJsonRpc = (chunk: string | Uint8Array) =>
  typeof chunk !== "string"
    ? chunk
    : encoder.encode(chunk.startsWith("{") ? `{"jsonrpc":"2.0",${chunk.slice(1)}` : chunk);

/** The agent's reply to `text`, all its message chunks joined. */
export const acpPrompt = Effect.fn("acpPrompt")(
  function* (input: AcpPrompt) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        extendEnv: true,
        stderr: "ignore",
      }),
    );
    const reply = yield* Ref.make("");
    const rpc = yield* makeCodexAppServerPatchedProtocol({
      stdio: Stdio.make({
        args: Effect.succeed([]),
        stdin: handle.stdout,
        stdout: () => Sink.mapInput(handle.stdin, withJsonRpc),
        stderr: () => Sink.drain,
      }),
      terminationError: makeTerminationError(handle),
      onNotification: (n) =>
        n.method === "session/update"
          ? decodeChunk(n.params).pipe((chunk) =>
              chunk._tag === "Some"
                ? Ref.update(reply, (r) => r + chunk.value.update.content.text)
                : Effect.void,
            )
          : Effect.void,
      onRequest: (r) =>
        r.method === "session/request_permission"
          ? Effect.succeed({ outcome: { outcome: "cancelled" } })
          : Effect.fail(
              new CodexAppServerRequestError({
                code: -32601,
                errorMessage: `not supported: ${r.method}`,
              }),
            ),
    });
    yield* rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "toolreader", version: "0" },
    });
    const { sessionId } = yield* rpc
      .request("session/new", { cwd: input.cwd, mcpServers: [] })
      .pipe(Effect.flatMap(decodeNewSession));
    for (const [configId, value] of [
      ["model", input.model],
      ["reasoning_effort", input.effort],
    ] as const)
      if (value) yield* rpc.request("session/set_config_option", { sessionId, configId, value });
    yield* rpc.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: input.text }],
    });
    return yield* Ref.get(reply);
  },
  Effect.scoped,
  Effect.mapError((e) => new AcpFailed({ message: `${e._tag}: ${e.message}` })),
);
