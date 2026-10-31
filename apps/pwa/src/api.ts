export const SLUG = (location.pathname.match(/^\/t\/([^/]+)/) ?? [])[1] ?? null;
export const IS_OWNER = location.pathname.startsWith("/owner");
export const BASE = IS_OWNER ? "/owner/api" : `/t/${SLUG}/api`;
export const APP_PATH = IS_OWNER ? "/owner/" : `/t/${SLUG}/`;

let csrf = "";
export const setCsrf = (t: string) => { csrf = t; };

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  if (method !== "GET") headers["X-CSRF-Token"] = csrf;
  let res: Response;
  try { res = await fetch(BASE + path, { method, headers, body: payload, credentials: "same-origin" }); }
  catch { throw new ApiError(0, "You appear to be offline. Please check your connection and try again.", "offline"); }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code);
  return data as T;
}
export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b?: unknown) => api<T>("POST", p, b ?? {});
export const put = <T = any>(p: string, b?: unknown) => api<T>("PUT", p, b ?? {});
export const del = <T = any>(p: string) => api<T>("DELETE", p);
