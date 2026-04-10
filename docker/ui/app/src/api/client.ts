/** Base URL for all API requests — proxied through Vite dev server in development */
const API_BASE = '/api';

/**
 * Structured error thrown by apiRequest when the server returns a non-2xx status.
 * Parses FastAPI validation errors (detail as array) and plain string details.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly raw?: unknown;

  constructor(status: number, message: string, raw?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.raw = raw;
  }
}

/**
 * Extracts a human-readable message from FastAPI error shapes.
 * Handles both `{ detail: "string" }` and `{ detail: [{ msg, loc }] }` forms.
 */
function extractErrorMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return String(body);
  }

  const record = body as Record<string, unknown>;

  if (typeof record['detail'] === 'string') {
    return record['detail'];
  }

  if (Array.isArray(record['detail'])) {
    return record['detail']
      .map((item) => {
        if (typeof item === 'object' && item !== null) {
          const err = item as Record<string, unknown>;
          const loc = Array.isArray(err['loc']) ? err['loc'].join('.') : '';
          const msg = typeof err['msg'] === 'string' ? err['msg'] : JSON.stringify(err);
          return loc ? `${loc}: ${msg}` : msg;
        }
        return String(item);
      })
      .join('; ');
  }

  if (typeof record['message'] === 'string') {
    return record['message'];
  }

  return JSON.stringify(body);
}

const AUTH_TOKEN_KEY = 'auth_token';

/**
 * Core fetch wrapper used by all API modules.
 * Automatically injects the JWT Bearer token from localStorage and sets
 * Content-Type for JSON bodies. Throws ApiError on failure.
 *
 * On 401 responses the token is cleared from localStorage and the user is
 * redirected to /login so they can re-authenticate.
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${API_BASE}${path}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  // Inject Bearer token when present. The login endpoint itself does not
  // require a token, so omitting it there is fine — the header just won't be set.
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // 401 means the token is missing, expired, or invalid. Clear it and bounce
  // the user to the login page. The replace() avoids polluting browser history.
  if (response.status === 401) {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    window.location.replace('/login');
    // Throw so any in-flight promise chains stop cleanly.
    throw new ApiError(401, 'Session expired. Please log in again.');
  }

  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = await response.text().catch(() => 'Unknown error');
    }
    const message = extractErrorMessage(errorBody);
    throw new ApiError(response.status, message, errorBody);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
