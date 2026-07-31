export const IM_HTTP_POST_JSON_TIMEOUT = 'IM_HTTP_POST_JSON_TIMEOUT';
export const IM_HTTP_POST_JSON_TIMEOUT_MS = 20_000;

type JsonFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, 'status' | 'text'>>;

export interface JsonPostOptions {
  headers?: Record<string, string>;
}

/**
 * Build the host JSON transport with an absolute request/body deadline.
 * Timeout is deliberately surfaced as an ambiguous transport error: callers
 * must not retry or switch delivery routes because the remote endpoint may
 * already have accepted the message before the response was lost.
 */
export function createHttpPostJson(
  fetchJson: JsonFetch,
  timeoutMs = IM_HTTP_POST_JSON_TIMEOUT_MS,
) {
  return async (url: string, body: unknown, options?: JsonPostOptions) => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timeout.unref?.();

    try {
      const response = await fetchJson(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...options?.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      try {
        return { status: response.status, body: JSON.parse(text) as unknown };
      } catch {
        return {
          status: response.status,
          body: { error: text || `HTTP ${response.status}` },
        };
      }
    } catch (error) {
      if (timedOut) throw new Error(IM_HTTP_POST_JSON_TIMEOUT);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}
