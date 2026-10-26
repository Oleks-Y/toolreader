import { useEffect, useState } from "react";

/**
 * A date in the reader's own locale and time zone. A server-rendered page (the webapp) can't know
 * those, so the server and the hydrating render both show the UTC day, and the browser's format
 * replaces it once mounted.
 */
export function When({ at, as }: { at: string; as: (iso: string) => string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <time dateTime={at}>{mounted ? as(at) : at.slice(0, 10)}</time>;
}
