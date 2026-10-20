// The app's server functions: every one reads the session first, and every repo read checks that
// GitHub lets the user read that repo (server/history.ts `mustRead`). Their bodies run on the
// server only; the browser gets RPC stubs.
import { createServerFn } from "@tanstack/react-start";
import * as Schema from "effect/Schema";

import { ACTION_KINDS, ActionKind } from "../core/domain.ts";
import { FINDING_STATUSES } from "../core/insights.ts";

const input = <A, I>(schema: Schema.Codec<A, I>) =>
  Schema.toStandardSchemaV1(schema as Schema.Codec<A, I, never, never>);

const Repo = Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/));
const RepoInput = input(Schema.Struct({ repo: Repo }));
const LedgerInput = input(Schema.Struct({ repo: Repo, before: Schema.NullOr(Schema.String) }));
const PullInput = input(Schema.Struct({ repo: Repo, number: Schema.Number }));
const CommitInput = input(
  Schema.Struct({ repo: Repo, sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,64}$/)) }),
);
const UrlInput = input(Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(2048)) }));
const SearchInput = input(
  Schema.Struct({
    repo: Repo,
    text: Schema.optional(Schema.String.check(Schema.isLengthBetween(2, 200))),
    commit: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{4,64}$/))),
    kinds: Schema.optional(Schema.Array(ActionKind).check(Schema.isMaxLength(ACTION_KINDS.length))),
  }),
);
const Id = Schema.String.check(Schema.isLengthBetween(1, 200));
const CiteInput = input(
  Schema.Struct({ repo: Repo, threadId: Id, entryId: Id, version: Schema.optional(Id) }),
);
const TitlesInput = input(
  Schema.Struct({ repo: Repo, ids: Schema.Array(Id).check(Schema.isMaxLength(50)) }),
);
const DecideInput = input(
  Schema.Struct({
    repo: Repo,
    id: Schema.String.check(Schema.isLengthBetween(1, 64)),
    to: Schema.Literals(FINDING_STATUSES),
    why: Schema.String.check(Schema.isLengthBetween(1, 2000)),
  }),
);

const server = async () => ({
  session: await import("./server/session.ts"),
  history: await import("./server/history.ts"),
  env: await import("./server/env.ts"),
});

export const getMe = createServerFn({ method: "GET" }).handler(async () => {
  const { session, env } = await server();
  const s = await session.appSession();
  const { githubClientId, devToken } = env.env();
  return {
    login: s.data.user?.login ?? null,
    canSignIn: githubClientId !== null,
    dev: devToken !== null,
  };
});

export const listRepos = createServerFn({ method: "GET" }).handler(async () => {
  const { session, history } = await server();
  return history.repos(await session.requireUser());
});

export const getLedger = createServerFn({ method: "GET" })
  .validator(LedgerInput)
  .handler(async ({ data }) => {
    const { session, history } = await server();
    return history.ledger(await session.requireUser(), data.repo, data.before);
  });

export const listPulls = createServerFn({ method: "GET" })
  .validator(RepoInput)
  .handler(async ({ data }) => {
    const { session, history } = await server();
    return history.pulls(await session.requireUser(), data.repo);
  });

export const getPullHistory = createServerFn({ method: "GET" })
  .validator(PullInput)
  .handler(async ({ data }) => {
    const { session, history } = await server();
    return history.pullHistory(await session.requireUser(), data.repo, data.number);
  });

export const getCommitHistory = createServerFn({ method: "GET" })
  .validator(CommitInput)
  .handler(async ({ data }) => {
    const { session, history } = await server();
    return history.commitHistory(await session.requireUser(), data.repo, data.sha);
  });

export const searchSessions = createServerFn({ method: "GET" })
  .validator(SearchInput)
  .handler(async ({ data }) => {
    const { session, history } = await server();
    const { repo, ...q } = data;
    return history.search(await session.requireUser(), repo, q);
  });

export const readCitation = createServerFn({ method: "GET" })
  .validator(CiteInput)
  .handler(async ({ data }) => {
    const { session, history } = await server();
    const { repo, ...cite } = data;
    return history.evidence(await session.requireUser(), repo, cite);
  });

export const getSessionTitles = createServerFn({ method: "GET" })
  .validator(TitlesInput)
  .handler(async ({ data }) => {
    const { session, history } = await server();
    return history.sessionTitles(await session.requireUser(), data.repo, data.ids);
  });

export const listFindings = createServerFn({ method: "GET" })
  .validator(RepoInput)
  .handler(async ({ data }) => {
    const { session, history } = await server();
    return history.findings(await session.requireUser(), data.repo);
  });

/** Runs the detectors over the repo's history: a POST, it writes findings. */
export const runDetectors = createServerFn({ method: "POST" })
  .validator(RepoInput)
  .handler(async ({ data }) => {
    const { session, history } = await server();
    return history.detect(await session.requireUser(), data.repo);
  });

/** Moves a finding along its lifecycle, as the signed-in person, with why. */
export const decideFinding = createServerFn({ method: "POST" })
  .validator(DecideInput)
  .handler(async ({ data }) => {
    const { session, history } = await server();
    const { repo, ...change } = data;
    return history.decide(await session.requireUser(), repo, change);
  });

/** Asks TypeSafe the first time a hunk is blamed: a POST, so nothing prefetches it. */
export const blameLine = createServerFn({ method: "POST" })
  .validator(UrlInput)
  .handler(async ({ data }) => {
    const { session, history } = await server();
    const blame = await import("./server/blame.ts");
    const user = await session.requireUser();
    try {
      return { ok: true as const, result: await blame.blameLine(user, data.url) };
    } catch (e) {
      // What the reader can act on comes back as a message; anything else is a server error.
      if (e instanceof blame.BlameFailed || e instanceof history.NotAllowed)
        return { ok: false as const, message: e.message };
      throw e;
    }
  });
