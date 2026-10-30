// A queryable, filtered copy of a selected Codex rollout. The source file stays local.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import { archiveEvent } from "../../core/codexArchive.ts";
import { LIMITS, MEDIA_TYPES, type MediaType } from "../../core/historyApi.ts";
import { ABSOLUTE, HOME_RELATIVE } from "../../core/privacy.ts";
import { redactText } from "../../core/proof.ts";
import { archiveLines } from "./io.ts";

export type FilteredMedia = {
  readonly sha256: string;
  readonly mime: MediaType;
  readonly data: string;
};

export type FilterRolloutOptions = {
  readonly source: string;
  readonly destination: string;
  readonly repoRoot: string;
  readonly includeDirs: ReadonlyArray<string>;
  readonly extraRedactions?: ReadonlyArray<string>;
  readonly putMedia: (media: FilteredMedia) => Promise<void>;
};

const mediaType = (value: unknown): MediaType | null =>
  typeof value === "string" && (MEDIA_TYPES as ReadonlyArray<string>).includes(value)
    ? (value as MediaType)
    : null;
const imageExtension = /\.(png|jpe?g|webp|gif)$/i;
const imageMime = (name: string): MediaType | null => {
  const extension = imageExtension.exec(name)?.[1]?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return null;
};
const dataUri = /data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/_=\r\n-]+)/gi;
const imagePath =
  /(?<![A-Za-z0-9:/])(?:file:\/\/|\/|~\/|\.\.?\/)[^\s"'`<>()[\]{},;]+?\.(?:png|jpe?g|webp|gif)(?![A-Za-z0-9])/gi;
const obviousRelative = /(?<![A-Za-z0-9])\.\.?\/[A-Za-z0-9._~/-]+/g;
const encodedAbsolute = /%2F(?:[A-Za-z0-9._~%-]+%2F)*[A-Za-z0-9._~%-]+/gi;
const fileUrl = /file:\/\/[^\s"'`<>()[\]{},;]+/gi;
const pathField = /(?:^|_)(?:path|file|cwd|directory|dir|root|workspace|project)(?:$|_)/i;

const completeRaster = (bytes: Buffer, mime: MediaType) => {
  if (mime === "image/jpeg")
    return (
      bytes.length >= 4 &&
      bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) &&
      bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))
    );
  if (mime === "image/png")
    return (
      bytes.length >= 20 &&
      bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
      bytes.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))
    );
  if (mime === "image/gif")
    return (
      bytes.length >= 7 &&
      /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()) &&
      bytes.at(-1) === 0x3b
    );
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP" &&
    bytes.readUInt32LE(4) === bytes.length - 8
  );
};

const decodeMedia = (value: string, mime: MediaType): Buffer | null => {
  const compact = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) return null;
  const encoded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) return null;
  return completeRaster(bytes, mime) ? bytes : null;
};

/** Resolve an absent leaf through its nearest existing ancestor, so symlink parents still count. */
async function canonical(candidate: string): Promise<string> {
  let ancestor = NodePath.resolve(candidate);
  const suffix: string[] = [];
  for (;;) {
    try {
      return NodePath.join(await NodeFSP.realpath(ancestor), ...suffix.toReversed());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = NodePath.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(NodePath.basename(ancestor));
      ancestor = parent;
    }
  }
}

const within = (candidate: string, dir: string) =>
  candidate === dir || candidate.startsWith(`${dir}${NodePath.sep}`);

async function replaceAsync(
  value: string,
  pattern: RegExp,
  replacement: (match: string) => Promise<string>,
) {
  let result = "";
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    result += value.slice(offset, match.index);
    result += await replacement(match[0]);
    offset = match.index + match[0].length;
  }
  return result + value.slice(offset);
}

/** Resolves selected directories once, before reading any source event. */
export async function selectedDirectories(repoRoot: string, includeDirs: ReadonlyArray<string>) {
  const repo = await NodeFSP.realpath(repoRoot);
  const selected = [repo];
  for (const dir of includeDirs) {
    const absolute = NodePath.isAbsolute(dir) ? dir : NodePath.resolve(repo, dir);
    const resolved = await NodeFSP.realpath(absolute);
    if (!(await NodeFSP.stat(resolved)).isDirectory())
      throw new Error("Included history path is not a directory");
    if (!selected.includes(resolved)) selected.push(resolved);
  }
  return selected;
}

export async function filterRollout(options: FilterRolloutOptions): Promise<{
  readonly bytes: number;
  readonly sha256: string;
  readonly events: number;
  readonly mediaBytes: number;
  readonly missingMedia: number;
  readonly selectedDirs: ReadonlyArray<string>;
}> {
  const selectedDirs = await selectedDirectories(options.repoRoot, options.includeDirs);
  const repoRoot = selectedDirs[0]!;
  const home = NodeOS.homedir();
  const seenMedia = new Set<string>();
  let mediaBytes = 0;
  let missingMedia = 0;

  const absolute = (value: string) => {
    if (value.startsWith("~/")) return NodePath.resolve(home, value.slice(2));
    if (value.startsWith("file://")) return new URL(value).pathname;
    return NodePath.isAbsolute(value) ? value : NodePath.resolve(repoRoot, value);
  };
  const allowed = async (value: string) => {
    try {
      const resolved = await canonical(absolute(value));
      return selectedDirs.some((dir) => within(resolved, dir));
    } catch {
      return false;
    }
  };
  const store = async (bytes: Buffer, mime: MediaType) => {
    if (bytes.length === 0 || bytes.length > LIMITS.mediaBytes)
      throw new Error("Embedded media exceeds the configured media limit");
    const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (!seenMedia.has(sha256)) {
      await options.putMedia({ sha256, mime, data: bytes.toString("base64") });
      seenMedia.add(sha256);
      mediaBytes += bytes.length;
    }
    return `toolreader-media:${sha256}`;
  };
  const embedded = async (data: string, mime: MediaType) => {
    const bytes = decodeMedia(data, mime);
    if (!bytes) {
      missingMedia++;
      return "[missing-media:invalid-or-incomplete]";
    }
    if (bytes.length > LIMITS.mediaBytes) {
      missingMedia++;
      return "[media-too-large]";
    }
    return store(bytes, mime);
  };
  const mediaAt = async (value: string) => {
    if (!(await allowed(value))) {
      missingMedia++;
      return "[media-outside-scope]";
    }
    let bytes: Buffer;
    try {
      const file = absolute(value);
      if ((await NodeFSP.stat(file)).size > LIMITS.mediaBytes) {
        missingMedia++;
        return "[media-too-large]";
      }
      bytes = await NodeFSP.readFile(file);
    } catch {
      missingMedia++;
      return "[missing-media]";
    }
    const mime = imageMime(value);
    if (!mime) return "[unsupported-media]";
    if (!completeRaster(bytes, mime)) {
      missingMedia++;
      return "[missing-media:invalid-or-incomplete]";
    }
    return store(bytes, mime);
  };
  const cleanPath = async (value: string) => ((await allowed(value)) ? value : "[redacted path]");
  const cleanString = async (value: string, key?: string): Promise<string> => {
    let text = await replaceAsync(value, dataUri, async (match) => {
      const parsed = /^data:([^;]+);base64,([A-Za-z0-9+/_=\r\n-]+)$/i.exec(match);
      const mime = mediaType(parsed?.[1]);
      return mime && parsed ? embedded(parsed[2]!, mime) : "[unsupported-media]";
    });
    text = await replaceAsync(text, imagePath, mediaAt);
    text = redactText(text).text;
    for (const secret of options.extraRedactions ?? [])
      if (secret.length >= 3) text = text.replaceAll(secret, "[redacted]");
    // Path-valued fields can hold a bare relative name. Free text keeps ordinary relative words.
    if (key && pathField.test(key) && !text.includes("\n")) text = await cleanPath(text);
    text = await replaceAsync(text, encodedAbsolute, async (match) => {
      try {
        return (await allowed(decodeURIComponent(match))) ? match : "[redacted path]";
      } catch {
        return "[redacted path]";
      }
    });
    text = await replaceAsync(text, fileUrl, cleanPath);
    text = await replaceAsync(text, HOME_RELATIVE, cleanPath);
    text = await replaceAsync(text, ABSOLUTE, cleanPath);
    text = await replaceAsync(text, obviousRelative, cleanPath);
    return text;
  };
  const filter = async (value: unknown, key?: string, reasoning = false): Promise<unknown> => {
    if (typeof value === "string")
      return key &&
        /^(?:password|passwd|secret|token|api_?key|access_?token|refresh_?token|client_?secret|private_?key)$/i.test(
          key,
        )
        ? "[redacted]"
        : key === "encrypted_content"
          ? reasoning && /^[A-Za-z0-9+/_=-]+$/.test(value) && value.length >= 32
            ? value
            : "[redacted]"
          : cleanString(value, key);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) result.push(await filter(item, undefined, reasoning));
      return result;
    }
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const declaredMime =
      source["mimeType"] ??
      source["mime_type"] ??
      source["media_type"] ??
      (source["source"] && typeof source["source"] === "object"
        ? (source["source"] as Record<string, unknown>)["media_type"]
        : undefined);
    const mime = mediaType(declaredMime);
    const result: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(source)) {
      const safeName = await cleanString(name);
      result[safeName] =
        name === "data" && typeof item === "string" && typeof declaredMime === "string"
          ? mime
            ? await embedded(item, mime)
            : "[unsupported-media]"
          : await filter(item, name, source["type"] === "reasoning");
    }
    return result;
  };

  const output = await NodeFSP.open(options.destination, "wx", 0o600);
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  let events = 0;
  try {
    for await (const line of archiveLines(options.source)) {
      const original = archiveEvent(line, ++events);
      const filtered = await filter(original.raw);
      const data = Buffer.from(`${JSON.stringify(filtered)}\n`);
      await output.writeFile(data);
      hash.update(data);
      bytes += data.length;
    }
    if (!events) throw new Error("Empty Codex rollout");
  } catch (error) {
    await output.close();
    await NodeFSP.rm(options.destination, { force: true });
    throw error;
  }
  await output.close();
  return { bytes, sha256: hash.digest("hex"), events, mediaBytes, missingMedia, selectedDirs };
}
