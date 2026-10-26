// The backend's media bucket: screenshots agents looked at, by workspace and content hash, in any
// S3-compatible store (MinIO locally, Cloudflare R2 or S3 deployed), private, path-style. The
// backend holds the bucket's key and proxies every byte: clients never get bucket access.
// Off unless TOOLREADER_MEDIA_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY are set.
import { AwsClient } from "aws4fetch";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class MediaBucketFailed extends Schema.TaggedErrorClass<MediaBucketFailed>()(
  "MediaBucketFailed",
  { message: Schema.String },
) {}

export type MediaBucketConfig = {
  /** e.g. http://127.0.0.1:9000 (MinIO) or https://<account>.r2.cloudflarestorage.com. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
  /** `auto` for R2; MinIO and S3 take their region. */
  readonly region: string;
};

/** An object's key: the workspace, then the image's SHA-256 (hex, checked by the caller). */
export const mediaKey = (workspaceId: string, sha256: string) => `${workspaceId}/${sha256}`;

export class MediaBucket extends Context.Service<
  MediaBucket,
  {
    /** Null when no bucket is configured: media is off for every workspace. */
    readonly config: MediaBucketConfig | null;
    readonly put: (
      key: string,
      bytes: Uint8Array,
      mime: string,
    ) => Effect.Effect<void, MediaBucketFailed>;
    /** The object's bytes, or none when it isn't there. */
    readonly get: (key: string) => Effect.Effect<Option.Option<Uint8Array>, MediaBucketFailed>;
    readonly remove: (key: string) => Effect.Effect<void, MediaBucketFailed>;
  }
>()("toolreader/server/backend/MediaBucket") {
  static readonly make = (config: MediaBucketConfig) => {
    const aws = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: Redacted.value(config.secretAccessKey),
      service: "s3",
      region: config.region,
    });
    const url = (key: string) =>
      `${config.endpoint.replace(/\/$/, "")}/${encodeURIComponent(config.bucket)}/${key}`;
    // Statuses only: a bucket's error body can echo the key, which names the workspace.
    const send = (key: string, init: RequestInit, what: string) =>
      Effect.tryPromise({
        try: () => aws.fetch(url(key), init),
        catch: () => new MediaBucketFailed({ message: `The media bucket didn't answer (${what})` }),
      });
    return MediaBucket.of({
      config,
      put: (key, bytes, mime) =>
        send(key, { method: "PUT", body: bytes, headers: { "content-type": mime } }, "put").pipe(
          Effect.flatMap((r) =>
            r.ok
              ? Effect.void
              : Effect.fail(
                  new MediaBucketFailed({
                    message: `The media bucket refused a put (${r.status})`,
                  }),
                ),
          ),
        ),
      get: (key) =>
        send(key, { method: "GET" }, "get").pipe(
          Effect.flatMap((r) =>
            r.status === 404
              ? Effect.succeed(Option.none())
              : r.ok
                ? Effect.tryPromise({
                    try: async () => Option.some(new Uint8Array(await r.arrayBuffer())),
                    catch: () =>
                      new MediaBucketFailed({ message: "The media bucket cut a read short" }),
                  })
                : Effect.fail(
                    new MediaBucketFailed({
                      message: `The media bucket refused a read (${r.status})`,
                    }),
                  ),
          ),
        ),
      remove: (key) =>
        send(key, { method: "DELETE" }, "delete").pipe(
          Effect.flatMap((r) =>
            r.ok || r.status === 404
              ? Effect.void
              : Effect.fail(
                  new MediaBucketFailed({
                    message: `The media bucket refused a delete (${r.status})`,
                  }),
                ),
          ),
        ),
    });
  };

  static readonly disabled = Layer.succeed(
    MediaBucket,
    MediaBucket.of({
      config: null,
      put: () => Effect.fail(new MediaBucketFailed({ message: "No media bucket" })),
      get: () => Effect.succeed(Option.none()),
      remove: () => Effect.void,
    }),
  );

  /** Tests only: a bucket in memory, its objects in `objects`. */
  static readonly memory = (objects = new Map<string, Uint8Array>()) =>
    Layer.succeed(
      MediaBucket,
      MediaBucket.of({
        config: {
          endpoint: "memory:",
          bucket: "test",
          accessKeyId: "",
          secretAccessKey: Redacted.make(""),
          region: "auto",
        },
        put: (key, bytes) => Effect.sync(() => void objects.set(key, bytes)),
        get: (key) => Effect.sync(() => Option.fromNullishOr(objects.get(key))),
        remove: (key) => Effect.sync(() => void objects.delete(key)),
      }),
    );

  /** From TOOLREADER_MEDIA_*: the bucket when all four are set, else off. */
  static readonly layerConfig = Layer.unwrap(
    Effect.gen(function* () {
      const endpoint = yield* Config.option(Config.string("TOOLREADER_MEDIA_ENDPOINT"));
      const bucket = yield* Config.option(Config.string("TOOLREADER_MEDIA_BUCKET"));
      const accessKeyId = yield* Config.option(Config.string("TOOLREADER_MEDIA_ACCESS_KEY_ID"));
      const secret = yield* Config.option(Config.redacted("TOOLREADER_MEDIA_SECRET_ACCESS_KEY"));
      const region = yield* Config.withDefault(Config.string("TOOLREADER_MEDIA_REGION"), "auto");
      if (
        Option.isNone(endpoint) ||
        Option.isNone(bucket) ||
        Option.isNone(accessKeyId) ||
        Option.isNone(secret)
      )
        return MediaBucket.disabled;
      return Layer.succeed(
        MediaBucket,
        MediaBucket.make({
          endpoint: endpoint.value,
          bucket: bucket.value,
          accessKeyId: accessKeyId.value,
          secretAccessKey: secret.value,
          region,
        }),
      );
    }).pipe(Effect.orDie),
  );
}
