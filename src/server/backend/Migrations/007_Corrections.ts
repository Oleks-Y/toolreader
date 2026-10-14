// People's corrections to a finding's members (semantic grouping, core/semantic.ts): sessions
// added to or removed from a group a model proposed. Kept apart from the detection, so the next
// run's evidence never overwrites them.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE findings
    ADD COLUMN corrections jsonb NOT NULL DEFAULT '{"add": [], "remove": []}'::jsonb`;
});
