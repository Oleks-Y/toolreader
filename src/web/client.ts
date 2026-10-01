import type * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Predicate from "effect/Predicate";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { ToolreaderApi } from "../core/api.ts";

const runtime = ManagedRuntime.make(FetchHttpClient.layer);
const client = runtime.runPromise(HttpApiClient.make(ToolreaderApi, { baseUrl: location.origin }));

/** Runs one typed API call; rejects with the decoded API error (e.g. ThreadNotFound) or a transport error. */
export async function call<A, E>(
  f: (api: Awaited<typeof client>) => Effect.Effect<A, E>,
): Promise<A> {
  return runtime.runPromise(f(await client));
}

export function errorMessage(error: unknown): string {
  if (Predicate.isTagged(error, "ThreadNotFound") && Predicate.hasProperty(error, "threadId"))
    return `Thread ${String(error.threadId)} not found`;
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message) && error.message)
    return error.message;
  if (Predicate.hasProperty(error, "_tag")) return String(error._tag);
  return String(error);
}
