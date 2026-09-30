export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? res.statusText);
  return body as T;
}

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
export const fmtTime = (iso: string) => (iso ? time.format(new Date(iso)) : "");
export const fmtDay = (iso: string) => (iso ? day.format(new Date(iso)) : "");

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d`;
}

export const since = (iso: string) => fmtDuration(Date.now() - Date.parse(iso)).split(" ")[0] + " ago";
