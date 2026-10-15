/** API client: bearer session token, typed errors with stable codes (never raw server text). */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly details?: Record<string, unknown>) {
    super(code);
  }
}

let token: string | null = (() => {
  try {
    return sessionStorage.getItem("talaba.token");
  } catch {
    return null;
  }
})();
let onUnauthorized: (() => Promise<boolean>) | null = null;

export function setToken(t: string | null) {
  token = t;
  try {
    if (t) sessionStorage.setItem("talaba.token", t);
    else sessionStorage.removeItem("talaba.token");
  } catch {
    /* private mode */
  }
}
export function getToken() {
  return token;
}
export function setUnauthorizedHandler(fn: () => Promise<boolean>) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  if (!navigator.onLine && method !== "GET") throw new ApiError(0, "offline");
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !isForm ? { "content-type": "application/json" } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
  } catch {
    throw new ApiError(0, navigator.onLine ? "network_error" : "offline");
  }
  if (res.status === 401 && retry && onUnauthorized && (await onUnauthorized())) return request<T>(method, path, body, false);
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (json as { error?: { code?: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b ?? {}),
  del: <T>(p: string) => request<T>("DELETE", p),
  upload: <T>(p: string, form: FormData) => request<T>("POST", p, form),
};

export function newIdempotencyKey(prefix = "k") {
  return `${prefix}-${crypto.randomUUID()}`;
}
