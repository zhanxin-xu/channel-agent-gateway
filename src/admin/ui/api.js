// The admin API (/api/admin/*). Every call sends JSON; errors carry the server's message and per-field errors.

export class ApiError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields ?? {};
  }
}

async function call(method, path, body) {
  const res = await fetch(`/api/admin/${path}`, {
    method,
    credentials: "same-origin",
    headers: method === "GET" ? {} : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "session") window.dispatchEvent(new CustomEvent("admin:signed-out"));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data.fields);
  return data;
}

const query = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();

export const api = {
  get: (path, params) => call("GET", params ? `${path}?${query(params)}` : path),
  post: (path, body) => call("POST", path, body),
  put: (path, body) => call("PUT", path, body),
  del: (path, body) => call("DELETE", path, body),
};
