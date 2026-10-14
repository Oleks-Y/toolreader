// The webapp's settings, read on the server only (server functions and server routes). The
// browser holds a session cookie and nothing else.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export const env = () => ({
  backendUrl: need("TOOLREADER_BACKEND_URL"),
  /** One workspace is one organisation. */
  backendToken: need("TOOLREADER_BACKEND_TOKEN"),
  workspace: need("TOOLREADER_BACKEND_WORKSPACE"),
  /** At least 32 characters: it encrypts the session cookie. */
  sessionSecret: need("SESSION_SECRET"),
  /** The GitHub App's user authorization (sign-in). */
  githubClientId: process.env.GITHUB_APP_CLIENT_ID ?? null,
  githubClientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? null,
  /**
   * Development only: sign in as this token's user without the App (`gh auth token`). Refused
   * when NODE_ENV is production.
   */
  devToken: process.env.NODE_ENV === "production" ? null : (process.env.GITHUB_DEV_TOKEN ?? null),
});

/** TypeSafe's key: the environment's, else the file a developer wrote it to. */
export const typesafeKey = (): string | null => {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    return (
      NodeFS.readFileSync(
        NodePath.join(NodeOS.homedir(), ".toolreader", "typesafe.key"),
        "utf8",
      ).trim() || null
    );
  } catch {
    return null;
  }
};
