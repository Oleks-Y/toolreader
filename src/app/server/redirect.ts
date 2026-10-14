/**
 * A 302 to `path` on this origin. Not `Response.redirect`: its headers are immutable, and Start
 * adds the session cookie to the response.
 */
export const redirectTo = (request: Request, path: string) =>
  new Response(null, { status: 302, headers: { location: new URL(path, request.url).href } });
