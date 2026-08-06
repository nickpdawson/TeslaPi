export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  statusText: string;
  fieldErrors?: FieldError[];

  constructor(status: number, statusText: string, message: string, fieldErrors?: FieldError[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.fieldErrors = fieldErrors;
  }
}

// FastAPI reports errors as {detail: string} (HTTPException) or, for validation
// failures, {detail: [{loc, msg, type}, ...]} (422). The client used to read only
// `error`/`message`, which FastAPI never sends, so every failure showed the bare
// status text. Turn `detail` into a readable message + per-field errors.
export function formatDetail(detail: unknown): { message?: string; fieldErrors?: FieldError[] } {
  if (typeof detail === 'string') {
    return { message: detail };
  }
  if (Array.isArray(detail)) {
    const fieldErrors: FieldError[] = detail.map((d) => {
      const loc = Array.isArray(d?.loc) ? d.loc : [];
      // Drop the leading source segment ("body"/"query"/"path") for readability.
      const field = loc
        .filter((p: unknown) => p !== 'body' && p !== 'query' && p !== 'path')
        .join('.') || 'request';
      const message = typeof d?.msg === 'string' ? d.msg : 'Invalid value';
      return { field, message };
    });
    if (fieldErrors.length === 0) return {};
    return { message: fieldErrors.map((f) => `${f.field}: ${f.message}`).join('; '), fieldErrors };
  }
  return {};
}

const BASE_URL = import.meta.env.DEV ? '/api' : '/api';

// A 401 on any call (except the auth endpoints themselves) means the session expired
// or was never established. The auth store registers a handler here to flip the UI to
// the login screen. Registered via callback so client.ts doesn't import the store
// (which imports the client) — avoids a circular import.
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {};

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin', // send the session cookie (same-origin via nginx)
    });
  } catch (err) {
    throw new ApiError(0, 'Network Error', 'Failed to connect to TeslaPi');
  }

  // Session expired / missing — let the app switch to the login screen. Skip the auth
  // endpoints: a 401 from /auth/login is just a wrong password, not a dead session.
  if (response.status === 401 && !path.startsWith('/auth/')) {
    unauthorizedHandler?.();
  }

  if (!response.ok) {
    let message = response.statusText;
    let fieldErrors: FieldError[] | undefined;
    try {
      const errBody = await response.json();
      if (errBody.error) message = errBody.error;
      if (errBody.message) message = errBody.message;
      // FastAPI's `detail` is the canonical field; let it win when present.
      if (errBody.detail !== undefined) {
        const parsed = formatDetail(errBody.detail);
        if (parsed.message) message = parsed.message;
        fieldErrors = parsed.fieldErrors;
      }
    } catch {
      // ignore parse failure
    }
    throw new ApiError(response.status, response.statusText, message, fieldErrors);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function get<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

export function del<T>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}
