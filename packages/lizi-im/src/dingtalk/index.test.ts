import { afterEach, describe, expect, it, vi } from "vitest";
import type { DWClientDownStream } from "dingtalk-stream";

import type { IMHost } from "../types.js";
import { chunkDingTalkMarkdown, sanitizeDingTalkMarkdown } from "./chunk.js";
import { DingTalkIM, type DingTalkStreamClient } from "./index.js";

class FakeClient implements DingTalkStreamClient {
  connected = false;
  registered = false;
  callback: ((event: DWClientDownStream) => void) | null = null;
  acknowledgements: Array<{ messageId: string; result: unknown }> = [];
  accessTokenCalls = 0;

  registerCallbackListener(
    _topic: string,
    callback: (event: DWClientDownStream) => void,
  ): DingTalkStreamClient {
    this.callback = callback;
    return this;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  socketCallBackResponse(messageId: string, result: unknown): void {
    this.acknowledgements.push({ messageId, result });
  }

  async getAccessToken(): Promise<string> {
    this.accessTokenCalls += 1;
    return "invalid-test-access-token";
  }

  emit(payload: Record<string, unknown>): void {
    this.callback?.({
      specVersion: "1.0",
      type: "CALLBACK",
      headers: {
        appId: "app",
        connectionId: "connection",
        contentType: "application/json",
        messageId: String(payload.msgId ?? "event"),
        time: String(Date.now()),
        topic: "/v1.0/im/bot/messages/get",
      },
      data: JSON.stringify(payload),
    });
  }
}

/**
 * Reproduces the DingTalk SDK's two-stage connection timing: endpoint lookup
 * settles `connect()` first, then the WebSocket reports `connected` later.
 */
class TimedFakeClient extends FakeClient {
  disconnectCalls = 0;
  private openTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly connectDelayMs: number,
    private readonly openDelayMs: number | null,
  ) {
    super();
  }

  override connect(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve();
        if (this.openDelayMs === null) return;
        this.openTimer = setTimeout(() => {
          // A late SDK continuation can reopen the transport after the caller
          // has already timed out unless the settled promise is cleaned up.
          this.connected = true;
        }, this.openDelayMs);
      }, this.connectDelayMs);
    });
  }

  override disconnect(): void {
    this.disconnectCalls += 1;
    // The real SDK closes a WebSocket that is still connecting, so the fake
    // cancels its pending open event to model that cleanup faithfully.
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
    super.disconnect();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

function createHarness(
  options: {
    postResponse?: (call: {
      url: string;
      body: unknown;
      options?: { headers?: Record<string, string> };
      index: number;
    }) =>
      | { status: number; body: unknown }
      | Promise<{ status: number; body: unknown }>;
  } = {},
) {
  const secrets = new Map<string, string>();
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const posts: Array<{
    url: string;
    body: unknown;
    options?: { headers?: Record<string, string> };
  }> = [];
  const client = new FakeClient();
  const host: IMHost = {
    paths: { feishuMediaDir: "/tmp/fake-feishu-media" },
    secrets: {
      isAvailable: () => true,
      write: (key, value) => {
        secrets.set(key, value);
        return true;
      },
      read: (key) => secrets.get(key) ?? null,
      remove: (key) => secrets.delete(key),
    },
    ipc: {
      handle: vi.fn(),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    },
    httpPostForm: vi.fn(),
    httpPostJson: async (
      url,
      body,
      requestOptions?: { headers?: Record<string, string> },
    ) => {
      const call = {
        url,
        body,
        ...(requestOptions ? { options: requestOptions } : {}),
        index: posts.length,
      };
      posts.push({
        url,
        body,
        ...(requestOptions ? { options: requestOptions } : {}),
      });
      if (options.postResponse) return options.postResponse(call);
      return { status: 200, body: { errcode: 0 } };
    },
  };
  const im = new DingTalkIM(host, { clientFactory: () => client });
  return { im, client, host, secrets, broadcasts, posts };
}

function directText(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    conversationId: "cid-private",
    conversationType: "1",
    msgId: "msg-1",
    msgtype: "text",
    robotCode: "robot-code",
    senderId: "opaque-sender",
    senderStaffId: "staff-1",
    senderNick: "Cindy User",
    sessionWebhook:
      "https://oapi.dingtalk.com/robot/sendBySession?session=invalid-test",
    sessionWebhookExpiredTime: Date.now() + 60_000,
    text: { content: " hello " },
    ...overrides,
  };
}

describe("DingTalkIM", () => {
  it("stores credentials without exposing the client secret and connects", async () => {
    const { im, client, secrets } = createHarness();

    const state = await im.saveConfig(
      "ding-client",
      "invalid-test-secret",
      "staff-1",
    );

    expect(state.status).toEqual({ kind: "connected", appId: "ding-client" });
    expect(client.registered).toBe(false);
    expect(state.clientId).toBe("ding-client");
    expect(state.ownerUserId).toBe("staff-1");
    expect(state).not.toHaveProperty("clientSecret");
    expect(secrets.get("dingtalk-bot-client-secret")).toBe(
      "invalid-test-secret",
    );
    await im.dispose();
  });

  it("accepts only direct messages from the configured owner and deduplicates retries", async () => {
    const { im, client } = createHarness();
    const messages: unknown[] = [];
    im.onMessage((message) => messages.push(message));
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");

    client.emit(directText({ msgId: "msg-other", senderStaffId: "staff-2" }));
    client.emit(directText());
    client.emit(directText());
    client.emit(directText({ msgId: "msg-group", conversationType: "2" }));
    await Promise.resolve();

    expect(messages).toHaveLength(1);
    expect(client.acknowledgements).toHaveLength(4);
    expect(messages[0]).toMatchObject({
      channelName: "dingtalk",
      senderId: "staff-1",
      contextId: "robot-code",
      text: "hello",
    });
    await im.dispose();
  });

  it("drops a queued callback after the connection is disposed", async () => {
    const { im, client, secrets } = createHarness();
    const messages: unknown[] = [];
    im.onMessage((message) => messages.push(message));
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");

    client.emit(directText());
    await im.dispose();
    await Promise.resolve();

    expect(messages).toEqual([]);
    expect(secrets.get("dingtalk-bot-owner-user-id")).toBe("staff-1");
  });

  it("clears runtime identity before broadcasting the disposed state", async () => {
    const { im, broadcasts } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");

    await im.dispose();

    expect(im.getState()).toMatchObject({
      status: { kind: "idle" },
      clientId: null,
      ownerUserId: null,
      hasSecret: true,
    });
    expect(broadcasts.at(-1)?.payload).toMatchObject({
      status: { kind: "idle" },
      clientId: null,
      ownerUserId: null,
    });
  });

  it("replies through the allowlisted session webhook", async () => {
    const { im, client, posts } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    client.emit(directText());
    await Promise.resolve();

    await im.sendMarkdownText("staff-1", "**done**");

    expect(posts).toEqual([
      {
        url: "https://oapi.dingtalk.com/robot/sendBySession?session=invalid-test",
        body: {
          msgtype: "markdown",
          markdown: { title: "Cindy", text: "**done**" },
          at: { atUserIds: [] },
        },
      },
    ]);
    await im.dispose();
  });

  it("uses the proactive direct-message API when the session webhook is unavailable", async () => {
    const { im, client, posts } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    client.emit(
      directText({
        sessionWebhook: "https://example.com/steal",
      }),
    );
    await Promise.resolve();

    await im.sendText("staff-1", "done");

    expect(client.accessTokenCalls).toBe(1);
    expect(posts).toEqual([
      {
        url: "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
        body: {
          robotCode: "ding-client",
          userIds: ["staff-1"],
          msgKey: "sampleMarkdown",
          msgParam: JSON.stringify({ title: "Cindy", text: "done" }),
        },
        options: {
          headers: {
            "x-acs-dingtalk-access-token": "invalid-test-access-token",
          },
        },
      },
    ]);
    await im.dispose();
  });

  it("falls back to the proactive API when DingTalk explicitly rejects the session webhook", async () => {
    const { im, client, posts } = createHarness({
      postResponse: ({ index }) =>
        index === 0
          ? { status: 410, body: { errcode: 310000, errmsg: "expired" } }
          : { status: 200, body: {} },
    });
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    client.emit(directText());
    await Promise.resolve();

    await im.sendText("staff-1", "done");

    expect(posts.map(({ url }) => url)).toEqual([
      "https://oapi.dingtalk.com/robot/sendBySession?session=invalid-test",
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
    ]);
    await im.dispose();
  });

  it("refreshes the proactive access token once after an HTTP 401", async () => {
    const { im, client, posts } = createHarness({
      postResponse: ({ index }) =>
        index === 0
          ? { status: 401, body: { code: "InvalidAuthentication" } }
          : { status: 200, body: {} },
    });
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");

    await im.sendText("staff-1", "done");

    expect(client.accessTokenCalls).toBe(2);
    expect(posts).toHaveLength(2);
    await im.dispose();
  });

  it("rejects proactive responses that report the recipient as invalid", async () => {
    const { im } = createHarness({
      postResponse: () => ({
        status: 200,
        body: { invalidStaffIdList: ["staff-1"] },
      }),
    });
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");

    await expect(im.sendText("staff-1", "done")).rejects.toThrow(
      "DINGTALK_PROACTIVE_INVALID_STAFF_ID",
    );
    await im.dispose();
  });

  it("never sends a proactive message to anyone except the configured owner", async () => {
    const { im, client, posts } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");

    await expect(im.sendText("staff-2", "done")).rejects.toThrow(
      "DINGTALK_RECIPIENT_NOT_OWNER",
    );
    expect(client.accessTokenCalls).toBe(0);
    expect(posts).toEqual([]);
    await im.dispose();
  });

  it("does not fall back after an ambiguous session webhook transport failure", async () => {
    const { im, client, posts } = createHarness({
      postResponse: () => {
        throw new Error("network reset");
      },
    });
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    client.emit(directText());
    await Promise.resolve();

    await expect(im.sendText("staff-1", "done")).rejects.toThrow(
      "network reset",
    );
    expect(posts).toHaveLength(1);
    expect(client.accessTokenCalls).toBe(0);
    await im.dispose();
  });
  it("continues sending remaining chunks when an intermediate chunk fails", async () => {
    // When commitFinal sends multiple chunks and one fails mid-stream,
    // it should still attempt all subsequent chunks rather than silently
    // truncating the reply. The first error is re-thrown after the loop.
    let callIndex = 0;
    const { im, client, posts } = createHarness({
      postResponse: ({ index }) => {
        if (index === 1) {
          // Simulate a rate-limit or transport error on the second chunk.
          throw new Error("DINGTALK_CHUNK_RATE_LIMITED");
        }
        return { status: 200, body: { errcode: 0 } };
      },
    });
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    client.emit(
      directText({
        // Provide no session webhook so all chunks go through the proactive API,
        // making each chunk an independent HTTP call we can selectively fail.
        sessionWebhook: "",
        sessionWebhookExpiredTime: 0,
      }),
    );
    await Promise.resolve();

    // Send a text long enough to produce multiple chunks (chunk size ~4000).
    const longText = "a".repeat(8001);
    await expect(
      im.commitFinal({ userId: "staff-1", text: longText, terminal: "done" }),
    ).rejects.toThrow("DINGTALK_CHUNK_RATE_LIMITED");

    // All three chunks should have been attempted despite the middle one failing.
    expect(posts).toHaveLength(3);
    await im.dispose();
  });

  it("broadcasts hasSecret false to all windows after clearing credentials", async () => {
    // After clearConfig deletes persisted secrets, the final broadcast must
    // reflect hasSecret: false. Previously dispose() set idle first, and the
    // subsequent setStatus({ kind: "idle" }) was deduplicated, leaving
    // other renderer windows stuck with hasSecret: true.
    const { im, secrets, broadcasts } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");

    await im.clearConfig();

    expect(im.getState()).toMatchObject({
      status: { kind: "idle" },
      clientId: null,
      ownerUserId: null,
      hasSecret: false,
    });
    // The last broadcast must carry hasSecret: false so every renderer
    // window (not just the one that initiated the IPC) updates correctly.
    const lastBroadcast = broadcasts.at(-1)?.payload as Record<string, unknown>;
    expect(lastBroadcast).toMatchObject({
      status: { kind: "idle" },
      clientId: null,
      ownerUserId: null,
      hasSecret: false,
    });
  });
  it("throws when httpPostJson returns a parse-error sentinel on the session webhook", async () => {
    // httpPostJson returns { error: string } when the response body cannot
    // be parsed as JSON. A 200 response with that body must not be treated
    // as a successful delivery.
    const { im, client } = createHarness({
      postResponse: () => ({
        status: 200,
        body: { error: "invalid json" },
      }),
    });
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    client.emit(directText());
    await Promise.resolve();

    await expect(im.sendText("staff-1", "done")).rejects.toThrow(
      "DINGTALK_HTTP_PARSE_ERROR",
    );
    await im.dispose();
  });

  it("throws when httpPostJson returns a parse-error sentinel on the proactive API", async () => {
    // Same parse-error detection applies to the proactive direct-message
    // endpoint via assertProactiveResponse.
    const { im } = createHarness({
      postResponse: () => ({
        status: 200,
        body: { error: "invalid json" },
      }),
    });
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");

    await expect(im.sendText("staff-1", "done")).rejects.toThrow(
      "DINGTALK_HTTP_PARSE_ERROR",
    );
    await im.dispose();
  });

  it("uses one 15-second deadline across endpoint lookup and socket open", async () => {
    vi.useFakeTimers();
    const client = new TimedFakeClient(10_000, null);
    const { host } = createHarness();
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
    });

    let settled = false;
    const savePromise = im
      .saveConfig("ding-client", "invalid-test-secret", "staff-1")
      .finally(() => {
        settled = true;
      });

    // Endpoint discovery consumes ten seconds, leaving only five seconds for
    // the WebSocket instead of starting a second full timeout window.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(savePromise).resolves.toMatchObject({
      status: { kind: "error", reason: "DINGTALK_CONNECT_TIMEOUT" },
    });
    await im.dispose();
  });

  it("disconnects an endpoint lookup that settles after its timeout", async () => {
    vi.useFakeTimers();
    const client = new TimedFakeClient(16_000, 0);
    const { host } = createHarness();
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
    });

    const savePromise = im.saveConfig(
      "ding-client",
      "invalid-test-secret",
      "staff-1",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(savePromise).resolves.toMatchObject({
      status: { kind: "error", reason: "DINGTALK_CONNECT_TIMEOUT" },
    });
    expect(client.disconnectCalls).toBe(1);

    // The unresolved SDK work later constructs and opens its WebSocket. The
    // stale-client cleanup must close that ghost connection a second time.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.disconnectCalls).toBe(2);
    expect(client.connected).toBe(false);
    await im.dispose();
  });

  it("keeps a connection that opens before the shared deadline", async () => {
    vi.useFakeTimers();
    const client = new TimedFakeClient(10_000, 4_900);
    const { host } = createHarness();
    const im = new DingTalkIM(host, {
      clientFactory: () => client,
    });

    const savePromise = im.saveConfig(
      "ding-client",
      "invalid-test-secret",
      "staff-1",
    );
    await vi.advanceTimersByTimeAsync(14_900);
    await expect(savePromise).resolves.toMatchObject({
      status: { kind: "connected", appId: "ding-client" },
    });
    // Late-settlement cleanup is guarded by the active client identity and
    // must not disconnect a valid connection that completed in time.
    expect(client.disconnectCalls).toBe(0);
    await im.dispose();
  });

  it("restores previous credentials when new credentials fail to connect", async () => {
    // When saveConfig receives new credentials that fail the Stream
    // connection, it must roll back to the previous credentials (mirroring
    // the Discord/Telegram pattern) so the user is not stuck with a broken
    // config on restart.
    let connectCall = 0;
    const secrets = new Map<string, string>();
    const host: import("../types.js").IMHost = {
      paths: { feishuMediaDir: "/tmp/fake-feishu-media" },
      secrets: {
        isAvailable: () => true,
        write: (key, value) => { secrets.set(key, value); return true; },
        read: (key) => secrets.get(key) ?? null,
        remove: (key) => secrets.delete(key),
      },
      ipc: {
        handle: vi.fn(),
        broadcast: vi.fn(),
      },
      // The rollback scenario does not perform HTTP requests, but a complete
      // host fake keeps the test aligned with the production IMHost contract.
      httpPostForm: vi.fn(),
    };
    const im = new DingTalkIM(host, {
      clientFactory: () => {
        connectCall += 1;
        const client = new FakeClient();
        if (connectCall === 2) {
          // Second connection (new credentials) fails.
          client.connect = async () => {
            throw new Error("DINGTALK_CONNECT_FAILED");
          };
        }
        return client;
      },
    });

    // Save initial working credentials.
    await im.saveConfig("old-client", "old-secret", "staff-old");
    expect(secrets.get("dingtalk-bot-client-id")).toBe("old-client");

    // Try to replace with bad credentials.
    const result = await im.saveConfig(
      "bad-client",
      "bad-secret",
      "staff-bad",
    );

    // Secrets should have been rolled back to the old credentials.
    expect(secrets.get("dingtalk-bot-client-id")).toBe("old-client");
    expect(secrets.get("dingtalk-bot-client-secret")).toBe("old-secret");
    expect(secrets.get("dingtalk-bot-owner-user-id")).toBe("staff-old");
    // The old runtime connection is restored, but the save result must retain
    // the failed attempted status so the renderer does not report success.
    expect(result.status).toEqual({
      kind: "connected",
      appId: "old-client",
    });
    expect(result.clientId).toBe("old-client");
    expect(result.saveErrorStatus).toEqual({
      kind: "error",
      reason: "DINGTALK_CONNECT_FAILED",
    });
    await im.dispose();
  });
});


describe("DingTalk text helpers", () => {
  it("chunks long Unicode text without breaking surrogate pairs", () => {
    expect(chunkDingTalkMarkdown("😀😀😀", 2)).toEqual(["😀😀", "😀"]);
  });

  it("converts the source text to code points once", () => {
    const fromSpy = vi.spyOn(Array, "from");
    try {
      fromSpy.mockClear();
      expect(chunkDingTalkMarkdown("a".repeat(12), 3)).toEqual([
        "aaa",
        "aaa",
        "aaa",
        "aaa",
      ]);
      expect(fromSpy).toHaveBeenCalledTimes(1);
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("removes local-only media URLs", () => {
    expect(sanitizeDingTalkMarkdown("![结果](xdt-image://abc)")).toBe(
      "[结果：图片暂不支持发送]",
    );
  });
});
