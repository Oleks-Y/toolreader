// What a repo's sessions actually record, per provider (`history audit`): how many carry each
// snapshot field, how many commands kept an exit code, how many edits know their real lines.
// Counts only, never values, so the output can be shared.
import { SessionSnapshot, type Entry } from "./domain.ts";

export const SNAPSHOT_FIELDS = Object.keys(SessionSnapshot.fields) as Array<keyof SessionSnapshot>;

export type AuditSession = {
  readonly provider: string;
  readonly subagent: boolean;
  readonly entries: ReadonlyArray<Entry>;
  readonly snapshot?: SessionSnapshot | undefined;
};

export type ProviderAudit = {
  readonly provider: string;
  readonly sessions: number;
  readonly subagents: number;
  readonly fields: Readonly<Record<keyof SessionSnapshot, number>>;
  /** Shell commands, and those whose exit code was recorded (the rest only say ok or failed). */
  readonly commands: number;
  readonly withExitCode: number;
  /** Edits, and those whose line numbers are the file's own (needed to rebuild a tested state). */
  readonly edits: number;
  readonly exactEdits: number;
};

export function auditSessions(sessions: ReadonlyArray<AuditSession>): ProviderAudit[] {
  const by = new Map<string, AuditSession[]>();
  for (const s of sessions) by.set(s.provider, [...(by.get(s.provider) ?? []), s]);
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, group]) => {
      const actions = group.flatMap((s) =>
        s.entries.flatMap((e) => (e.type === "action" ? [e] : [])),
      );
      const commands = actions.filter((a) => a.command !== undefined);
      const edits = actions.filter((a) => (a.files?.length ?? 0) > 0);
      return {
        provider,
        sessions: group.length,
        subagents: group.filter((s) => s.subagent).length,
        fields: Object.fromEntries(
          SNAPSHOT_FIELDS.map((f) => [
            f,
            group.filter((s) => s.snapshot?.[f] !== undefined).length,
          ]),
        ) as Record<keyof SessionSnapshot, number>,
        commands: commands.length,
        withExitCode: commands.filter((a) => a.exitCode !== undefined).length,
        edits: edits.length,
        exactEdits: edits.filter((a) => a.files!.every((f) => f.exactLines)).length,
      };
    });
}

/** The audit as `history audit` prints it, a block per provider. */
export function auditLines(audit: ReadonlyArray<ProviderAudit>, unread: number): string[] {
  const of = (n: number, total: number) => `${n}/${total}`;
  return [
    ...audit.flatMap((p) => [
      `${p.provider}: ${p.sessions} session${p.sessions === 1 ? "" : "s"} (${p.subagents} subagent${p.subagents === 1 ? "" : "s"})`,
      `  starting state: ${SNAPSHOT_FIELDS.map((f) => `${f} ${of(p.fields[f], p.sessions)}`).join(", ")}`,
      `  commands with an exit code: ${of(p.withExitCode, p.commands)}`,
      `  edits with real line numbers: ${of(p.exactEdits, p.edits)}`,
    ]),
    ...(unread > 0 ? [`! ${unread} session${unread === 1 ? "" : "s"} couldn't be read`] : []),
  ];
}
