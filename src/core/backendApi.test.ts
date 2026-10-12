import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { compareVersions, Meta, PutResult, TooLarge, UpgradeRequired } from "./backendApi.ts";

const decodePutResult = Schema.decodeUnknownSync(PutResult);

const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S["Type"]) => {
  const json = Schema.encodeSync(Schema.fromJsonString(schema))(value);
  assert.deepStrictEqual(Schema.decodeUnknownSync(Schema.fromJsonString(schema))(json), value);
};

describe("backendApi", () => {
  it("round-trips its schemas through JSON", () => {
    roundTrip(Meta, {
      server: "0.1.0",
      apiVersion: 1,
      minClient: "0.1.0",
      formats: { checkpoint: [1] },
      features: [],
    });
    for (const result of ["inserted", "exists", "differs", "replaced"] as const)
      roundTrip(PutResult, { id: "turn:t:u1", result });
    roundTrip(PutResult, {
      id: "x",
      result: "rejected",
      reason: "not-redacted",
      detail: "the redactor would change entries.2.output",
    });
    roundTrip(UpgradeRequired, new UpgradeRequired({ message: "upgrade", minClient: "0.2.0" }));
    roundTrip(TooLarge, new TooLarge({ message: "too large", maxBytes: 8 }));
    assert.throws(() => decodePutResult({ id: "x", result: "rejected", reason: "other" }));
  });

  it("orders versions as semver does", () => {
    const order = [
      "0.1.0",
      "0.1.9",
      "0.2.0-alpha.1",
      "0.2.0-alpha.2",
      "0.2.0-alpha.10",
      "0.2.0-beta.1",
      "0.2.0",
      "1.0.0",
    ];
    for (let i = 0; i < order.length; i++)
      for (let j = 0; j < order.length; j++)
        assert.strictEqual(Math.sign(compareVersions(order[i]!, order[j]!)!), Math.sign(i - j));
    assert.strictEqual(compareVersions("0.1.0+build.5", "0.1.0"), 0);
    assert.isBelow(compareVersions("1.0.0-1", "1.0.0-x")!, 0);
    assert.isAbove(compareVersions("1.0.0-alpha.x", "1.0.0-alpha.1")!, 0);
    assert.isNull(compareVersions("latest", "0.1.0"));
    assert.isNull(compareVersions("0.1", "0.1.0"));
  });
});
