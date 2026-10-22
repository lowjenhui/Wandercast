/**
 * Open-Meteo endpoints, served through the app's local weather cache (server/), which stores
 * results in SQLite and meters upstream use. The paths mirror Open-Meteo's own.
 */
export const OPEN_METEO = {
  forecast: '/api/om/forecast',
  archive: '/api/om/archive',
  airQuality: '/api/om/air-quality',
  status: '/api/om/status',
};

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Seconds to wait before retrying, from a Retry-After header. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/**
 * Past-trip mode: while a past trip's analysis is open, every local API request carries its range
 * id, and the server answers from stored data only (archived fares, stored weather and calendars).
 */
let archiveRange: number | null = null;
export function setArchiveRange(id: number | null) {
  archiveRange = id;
}

/** fetch + JSON with a timeout and readable errors. */
export async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  if (archiveRange !== null && url.startsWith('/api/')) {
    init = { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'X-Wandercast-Archive': String(archiveRange) } };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  init.signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      let detail = '';
      try {
        const text = await res.text();
        // Our cache server returns { reason } JSON; show that rather than raw JSON.
        try {
          detail = (JSON.parse(text) as { reason?: string }).reason ?? text.slice(0, 200);
        } catch {
          detail = text.slice(0, 200);
        }
      } catch {
        /* ignore */
      }
      const retry = Number(res.headers.get('Retry-After'));
      throw new ServiceError(detail || `HTTP ${res.status}`, res.status, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new ServiceError(init.signal?.aborted ? 'Request cancelled' : 'Request timed out');
    }
    throw new ServiceError(`Network error: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
}
