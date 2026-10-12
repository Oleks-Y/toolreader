// Tests only: a throwaway Postgres for the checkpoint store. TOOLREADER_TEST_PG_URL wins (a
// Postgres you run yourself); otherwise `docker run` starts one on a free 127.0.0.1 port, and the
// layer's scope removes it by the container id docker printed, never by name.
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as PgClient from "@effect/sql-pg/PgClient";

import { CheckpointStore } from "./CheckpointStore.ts";

const IMAGE = "postgres:17.5";

class DockerFailed extends Schema.TaggedErrorClass<DockerFailed>()("DockerFailed", {
  message: Schema.String,
}) {}

const docker = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make("docker", args));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== ChildProcessSpawner.ExitCode(0))
      return yield* new DockerFailed({ message: `docker ${args[0]}: ${stderr.trim()}` });
    return stdout.trim();
  }).pipe(Effect.scoped);

export const PgTestLive = Layer.unwrap(
  Effect.gen(function* () {
    const given = yield* Config.option(Config.string("TOOLREADER_TEST_PG_URL"));
    if (Option.isSome(given)) return PgClient.layer({ url: Redacted.make(given.value) });
    const id = yield* Effect.acquireRelease(
      docker([
        "run",
        "--rm",
        "-d",
        "-e",
        "POSTGRES_PASSWORD=toolreader",
        "-p",
        "127.0.0.1::5432",
        IMAGE,
      ]),
      (id) => Effect.ignore(docker(["rm", "-f", id])),
    );
    // The image restarts once after initdb, and listens on TCP only after that. No sleeps between
    // tries: tests run on a TestClock that never wakes them; each `docker exec` takes ~60 ms.
    yield* docker(["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).pipe(
      Effect.retry({ times: 1000 }),
    );
    const port = (yield* docker(["port", id, "5432/tcp"])).split("\n")[0]?.split(":").at(-1);
    return PgClient.layer({
      url: Redacted.make(`postgres://postgres:toolreader@127.0.0.1:${port}/postgres`),
    });
  }).pipe(Effect.orDie),
);

/** Workspace `slug`'s checkpoints (created if new), written as the CLI writes them: no token. */
export const inWorkspace = (slug: string) =>
  Effect.flatMap(CheckpointStore, (store) =>
    Effect.map(store.workspace(slug), (workspaceId) =>
      store.at({ workspaceId, tokenId: null, client: "test" }),
    ),
  );
