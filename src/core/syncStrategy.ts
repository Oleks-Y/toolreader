// Decide when the selected-session history uploader runs from a Codex hook event.
import * as Schema from "effect/Schema";
import { SessionId } from "./codexArchive.ts";

export const SYNC_STRATEGIES = ["on-demand", "on-commit", "on-push", "full"] as const;
export type SyncStrategy = (typeof SYNC_STRATEGIES)[number];

const HookEvent = Schema.Struct({
  hook_event_name: Schema.String,
  session_id: SessionId,
  cwd: Schema.optional(Schema.String),
  tool_input: Schema.optional(Schema.Unknown),
  tool_response: Schema.optional(Schema.Unknown),
});
const ToolInput = Schema.Struct({
  command: Schema.optional(Schema.String),
  cmd: Schema.optional(Schema.String),
});
const ToolResponse = Schema.Struct({
  exit_code: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  metadata: Schema.optional(
    Schema.Struct({
      exit_code: Schema.optional(Schema.Number),
      exitCode: Schema.optional(Schema.Number),
    }),
  ),
});
const decodeHook = Schema.decodeUnknownSync(Schema.fromJsonString(HookEvent));
const decodeInput = Schema.decodeUnknownOption(ToolInput);
const decodeResponse = Schema.decodeUnknownOption(ToolResponse);

export function automaticSyncDecision(input: string, configured?: string) {
  const strategy = configured || "on-demand";
  if (!SYNC_STRATEGIES.includes(strategy as SyncStrategy))
    throw new Error(`Unknown sync strategy: ${strategy}`);
  const event = decodeHook(input);
  const commandInput = decodeInput(event.tool_input);
  const command =
    commandInput._tag === "Some"
      ? (commandInput.value.command ?? commandInput.value.cmd ?? "")
      : "";
  const response = decodeResponse(event.tool_response);
  const exit =
    response._tag === "Some"
      ? (response.value.exit_code ??
        response.value.exitCode ??
        response.value.metadata?.exit_code ??
        response.value.metadata?.exitCode)
      : undefined;
  const successful =
    exit === 0 ||
    (typeof event.tool_response === "string" &&
      /(?:exit_code|exitCode|Process exited with code)[:\s]+0\b/.test(event.tool_response));
  // Codex reports the shell command, not Git's argv. Common global Git options
  // precede the subcommand, and a tool call can start with `cd … &&`.
  const git =
    /(?:^|&&|;|\n)\s*(?:command\s+)?git\s+(?:(?:-c\s+\S+|-C\s+(?:"[^"]+"|'[^']+'|\S+)|--(?:git-dir|work-tree)=\S+)\s+)*(commit|push)(?=\s|$)/.exec(
      command,
    );
  const directory = /(?:^|&&|;|\n)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*&&/.exec(command);
  const gitDirectory = /(?:^|\s)-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(git?.[0] ?? "");
  const commit = git?.[1] === "commit";
  const push = git?.[1] === "push";
  const isTool = event.hook_event_name === "PostToolUse";
  const sync =
    (strategy === "on-commit" && isTool && successful && commit) ||
    (strategy === "on-push" && isTool && successful && push) ||
    (strategy === "full" && event.hook_event_name === "SessionEnd");
  return {
    sync,
    detached: sync && strategy === "full",
    linkHead: sync && strategy === "on-commit",
    repo:
      gitDirectory?.[1] ??
      gitDirectory?.[2] ??
      gitDirectory?.[3] ??
      directory?.[1] ??
      directory?.[2] ??
      directory?.[3] ??
      event.cwd ??
      ".",
    session: event.session_id,
  };
}
