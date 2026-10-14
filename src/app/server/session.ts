// Who is signed in: their GitHub login and user token, in an encrypted HttpOnly cookie.
import { redirect } from "@tanstack/react-router";
import { useSession } from "@tanstack/react-start/server";

import { env } from "./env.ts";

export type User = {
  readonly login: string;
  /** A GitHub user token: the App's user-to-server token, or the dev token. */
  readonly token: string;
  readonly refreshToken: string | null;
  /** Epoch ms; null when it doesn't expire. */
  readonly expiresAt: number | null;
};

export const appSession = () =>
  useSession<{ user?: User | undefined; state?: string | undefined }>({
    name: "toolreader",
    password: env().sessionSecret,
    maxAge: 60 * 60 * 24 * 7,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    },
  });

/** The signed-in user, with a fresh token; else a redirect to the sign-in page. */
export async function requireUser(): Promise<User> {
  const session = await appSession();
  const user = session.data.user;
  if (!user) throw redirect({ to: "/login" });
  if (user.expiresAt === null || user.expiresAt > Date.now() + 60_000) return user;
  const refreshed = user.refreshToken ? await refresh(user) : null;
  if (!refreshed) {
    await session.clear();
    throw redirect({ to: "/login" });
  }
  await session.update({ user: refreshed });
  return refreshed;
}

/** GitHub's token response: an access token, and for expiring tokens a refresh token. */
export async function exchange(
  params: Record<string, string>,
): Promise<Omit<User, "login"> | null> {
  const { githubClientId, githubClientSecret } = env();
  if (!githubClientId || !githubClientSecret) return null;
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: githubClientId,
      client_secret: githubClientSecret,
      ...params,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.access_token !== "string") return null;
  return {
    token: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresAt: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : null,
  };
}

const refresh = async (user: User): Promise<User | null> => {
  const next = await exchange({ grant_type: "refresh_token", refresh_token: user.refreshToken! });
  return next ? { ...next, login: user.login } : null;
};
