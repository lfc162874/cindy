import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHttpPostJson,
  IM_HTTP_POST_JSON_TIMEOUT,
} from '../httpPostJson';

function response(status: number, text: string): Pick<Response, 'status' | 'text'> {
  return {
    status,
    text: vi.fn().mockResolvedValue(text),
  };
}

describe('createHttpPostJson', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts JSON with caller headers and parses a JSON response', async () => {
    const fetchJson = vi.fn().mockResolvedValue(response(200, '{"ok":true}'));
    const postJson = createHttpPostJson(fetchJson, 1_000);

    await expect(
      postJson('https://example.test/send', { text: 'hello' }, {
        headers: { Authorization: 'Bearer token' },
      }),
    ).resolves.toEqual({ status: 200, body: { ok: true } });

    expect(fetchJson).toHaveBeenCalledWith(
      'https://example.test/send',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer token',
        },
        body: '{"text":"hello"}',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('preserves the existing parse-fallback response shape', async () => {
    const postJson = createHttpPostJson(
      vi.fn().mockResolvedValue(response(502, 'upstream unavailable')),
      1_000,
    );

    await expect(postJson('https://example.test/send', {})).resolves.toEqual({
      status: 502,
      body: { error: 'upstream unavailable' },
    });
  });

  it('aborts a hung request at the deadline and clears its timer', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetchJson = vi.fn((_url: string, init: RequestInit) => {
      observedSignal = init.signal ?? undefined;
      return new Promise<Pick<Response, 'status' | 'text'>>((_resolve, reject) => {
        observedSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const postJson = createHttpPostJson(fetchJson, 250);
    const pending = postJson('https://example.test/send', {});
    const assertion = expect(pending).rejects.toThrow(IM_HTTP_POST_JSON_TIMEOUT);

    await vi.advanceTimersByTimeAsync(250);
    await assertion;

    expect(observedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline after a successful request', async () => {
    vi.useFakeTimers();
    const postJson = createHttpPostJson(
      vi.fn().mockResolvedValue(response(204, '')),
      250,
    );

    await postJson('https://example.test/send', {});

    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not rewrite non-timeout transport errors', async () => {
    const postJson = createHttpPostJson(
      vi.fn().mockRejectedValue(new Error('ECONNRESET')),
      1_000,
    );

    await expect(postJson('https://example.test/send', {})).rejects.toThrow(
      'ECONNRESET',
    );
  });
});
