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

/**
 * Core fetch wrapper used by all API modules.
 * Automatically sets Content-Type for JSON bodies and throws ApiError on failure.
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

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

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
