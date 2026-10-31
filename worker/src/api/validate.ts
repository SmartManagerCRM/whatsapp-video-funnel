import { HttpError } from "../lib/util";

export async function json(c: { req: { json: () => Promise<any> } }): Promise<Record<string, any>> {
  try {
    const b = await c.req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
    return b;
  } catch { throw new HttpError(400, "Invalid JSON body"); }
}

export function str(v: unknown, field: string, opts: { max?: number; min?: number; optional?: boolean } = {}): string | null {
  if (v === undefined || v === null || v === "") {
    if (opts.optional) return null;
    throw new HttpError(400, `${field} is required`);
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text`);
  const s = v.trim();
  if (opts.min && s.length < opts.min) throw new HttpError(400, `${field} is too short`);
  if (s.length > (opts.max ?? 500)) throw new HttpError(400, `${field} is too long (max ${opts.max ?? 500})`);
  return s;
}

export function int(v: unknown, field: string, min: number, max: number, dflt?: number): number {
  if ((v === undefined || v === null || v === "") && dflt !== undefined) return dflt;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}`);
  return n;
}

export function url(v: unknown, field: string): string | null {
  const s = str(v, field, { optional: true, max: 500 });
  if (!s) return null;
  try {
    const u = new URL(s);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error();
    return u.toString();
  } catch { throw new HttpError(400, `${field} must be a valid http(s) URL`); }
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new HttpError(400, `${field} must be one of: ${allowed.join(", ")}`);
  return v as T;
}

export function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}
