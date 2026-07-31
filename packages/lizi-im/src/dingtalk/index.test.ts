import { afterEach, describe, expect, it, vi } from "vitest";
import type { DWClientDownStream } from "dingtalk-stream";

import type { DingTalkDeliveryContext, IMHost } from "../types.js";
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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
    clientFactory?: () => DingTalkStreamClient;
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
  const clientFactory = options.clientFactory ?? (() => client);
  const im = new DingTalkIM(host, { clientFactory });
  return { im, client, host, secrets, broadcasts, posts };
}

function readProactiveText(post: { body: unknown }): string {
  if (!post.body || typeof post.body !== "object" || Array.isArray(post.body)) {
    throw new Error("DINGTALK_TEST_INVALID_PROACTIVE_BODY");
  }
  const msgParam = (post.body as Record<string, unknown>).msgParam;
  if (typeof msgParam !== "string") {
    throw new Error("DINGTALK_TEST_INVALID_MSG_PARAM");
  }
  const parsed = JSON.parse(msgParam) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DINGTALK_TEST_INVALID_MSG_PARAM_JSON");
  }
  const text = (parsed as Record<string, unknown>).text;
  if (typeof text !== "string") {
    throw new Error("DINGTALK_TEST_INVALID_PROACTIVE_TEXT");
  }
  return text;
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

async function receiveDeliveryContext(
  im: DingTalkIM,
  client: FakeClient,
  overrides: Record<string, unknown> = {},
): Promise<DingTalkDeliveryContext> {
  let deliveryContext: DingTalkDeliveryContext | undefined;
  const off = im.onMessage((message) => {
    if (message.deliveryContext?.channelName === "dingtalk") {
      deliveryContext = message.deliveryContext;
    }
  });
  client.emit(directText(overrides));
  await Promise.resolve();
  off();
  if (!deliveryContext) {
    throw new Error("DINGTALK_TEST_DELIVERY_CONTEXT_MISSING");
  }
  return deliveryContext;
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

  it("binds an inbound message to the current DingTalk bot generation", async () => {
    const { im, client } = createHarness();
    const messages: unknown[] = [];
    im.onMessage((message) => messages.push(message));
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");

    client.emit(directText({ robotCode: "ding-client" }));
    await Promise.resolve();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      deliveryContext: {
        channelName: "dingtalk",
        clientId: "ding-client",
        ownerUserId: "staff-1",
        generationToken: expect.any(String),
      },
    });
    await im.dispose();
  });

  it("rotates the bot generation when the configured owner changes", async () => {
    const { im, client, posts } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    const firstContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client",
      msgId: "msg-owner-1",
    });

    await im.saveConfig("ding-client", "invalid-test-secret", "staff-2");
    const secondContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client",
      msgId: "msg-owner-2",
      senderStaffId: "staff-2",
    });

    expect(secondContext.generationToken).not.toBe(
      firstContext.generationToken,
    );
    await expect(
      im.commitFinal({
        userId: "staff-1",
        text: "result generated for the previous owner",
        terminal: "done",
        deliveryContext: firstContext,
      }),
    ).rejects.toThrow("DINGTALK_STALE_TURN");
    expect(posts).toHaveLength(0);
    await im.dispose();
  });

  it("invalidates an old turn after dispose and reinitialization", async () => {
    const { im, client, posts } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    const firstContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client",
      msgId: "msg-before-dispose",
    });

    await im.dispose();
    await im.init();
    const secondContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client",
      msgId: "msg-after-init",
    });

    expect(secondContext.generationToken).not.toBe(
      firstContext.generationToken,
    );
    await expect(
      im.commitFinal({
        userId: "staff-1",
        text: "result generated before disposal",
        terminal: "done",
        deliveryContext: firstContext,
      }),
    ).rejects.toThrow("DINGTALK_STALE_TURN");
    expect(posts).toHaveLength(0);
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

  it("fails closed when terminal output has no delivery context", async () => {
    const { im, posts } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");

    await expect(
      im.commitFinal({
        userId: "staff-1",
        text: "old result",
        terminal: "done",
      }),
    ).rejects.toThrow("DINGTALK_STALE_TURN");
    expect(posts).toHaveLength(0);
    await im.dispose();
  });

  it("does not send bot A terminal output through bot B with the same owner", async () => {
    const { im, client, posts } = createHarness();
    await im.saveConfig("ding-client-a", "invalid-test-secret", "staff-1");
    const deliveryContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client-a",
      sessionWebhook: "",
      sessionWebhookExpiredTime: 0,
    });

    await im.saveConfig("ding-client-b", "invalid-test-secret", "staff-1");

    await expect(
      im.commitFinal({
        userId: "staff-1",
        text: "result generated for bot A",
        terminal: "done",
        deliveryContext,
      }),
    ).rejects.toThrow("DINGTALK_STALE_TURN");
    expect(posts).toHaveLength(0);
    await im.dispose();
  });

  it("does not let bot B webhook replace bot A terminal route", async () => {
    const { im, client, posts } = createHarness();
    await im.saveConfig("ding-client-a", "invalid-test-secret", "staff-1");
    const deliveryContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client-a",
      msgId: "msg-a",
      sessionWebhook:
        "https://oapi.dingtalk.com/robot/sendBySession?session=bot-a",
    });

    await im.saveConfig("ding-client-b", "invalid-test-secret", "staff-1");
    await receiveDeliveryContext(im, client, {
      robotCode: "ding-client-b",
      msgId: "msg-b",
      sessionWebhook:
        "https://oapi.dingtalk.com/robot/sendBySession?session=bot-b",
    });

    await expect(
      im.commitFinal({
        userId: "staff-1",
        text: "result generated for bot A",
        terminal: "done",
        deliveryContext,
      }),
    ).rejects.toThrow("DINGTALK_STALE_TURN");
    expect(posts).toHaveLength(0);
    await im.dispose();
  });

  it("allows an old turn after a same-bot network reconnect", async () => {
    const { im, client, posts } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    const deliveryContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client",
      sessionWebhook: "",
      sessionWebhookExpiredTime: 0,
    });

    await im.reconnect();

    await expect(
      im.commitFinal({
        userId: "staff-1",
        text: "same bot result",
        terminal: "done",
        deliveryContext,
      }),
    ).resolves.toBeUndefined();
    expect(posts).toHaveLength(1);
    await im.dispose();
  });

  it("stops remaining chunks when the bot changes during delivery", async () => {
    let im!: DingTalkIM;
    const harness = createHarness({
      postResponse: async ({ index }) => {
        if (index === 0) {
          await im.saveConfig(
            "ding-client-b",
            "invalid-test-secret",
            "staff-1",
          );
        }
        return { status: 200, body: { errcode: 0 } };
      },
    });
    im = harness.im;
    await im.saveConfig("ding-client-a", "invalid-test-secret", "staff-1");
    const deliveryContext = await receiveDeliveryContext(im, harness.client, {
      robotCode: "ding-client-a",
      sessionWebhook: "",
      sessionWebhookExpiredTime: 0,
    });

    await expect(
      im.commitFinal({
        userId: "staff-1",
        text: "a".repeat(8001),
        terminal: "done",
        deliveryContext,
      }),
    ).rejects.toThrow("DINGTALK_STALE_TURN");
    expect(harness.posts).toHaveLength(1);
    await im.dispose();
  });

  it("allows an old turn to deliver after a failed config replacement rolls back", async () => {
    // 保存新凭证连接失败时，回滚应恢复原投递代次，使旧 turn 仍能投递。
    let connectCall = 0;
    let firstClient: FakeClient | null = null;
    const { im, posts } = createHarness({
      clientFactory: () => {
        connectCall += 1;
        const c = new FakeClient();
        if (connectCall === 1) firstClient = c;
        // 第二次连接（新凭证）失败，触发回滚。
        if (connectCall === 2) {
          c.connect = async () => {
            throw new Error("DINGTALK_CONNECT_FAILED");
          };
        }
        return c;
      },
    });

    // 保存初始工作凭证。
    await im.saveConfig("ding-client-a", "invalid-test-secret", "staff-1");
    // 入站一条消息，捕获此时投递代次。
    const deliveryContext = await receiveDeliveryContext(
      im,
      firstClient!,
      {
        robotCode: "ding-client-a",
        sessionWebhook: "",
        sessionWebhookExpiredTime: 0,
      },
    );

    // 尝试保存新凭证（会连接失败并回滚）。
    await im.saveConfig("ding-client-b", "invalid-test-secret", "staff-1");

    // 回滚后旧凭证已恢复；旧 turn 的代次应仍然有效。
    await expect(
      im.sendText("staff-1", "old turn result", {
        deliveryContext,
      }),
    ).resolves.toEqual({ messageId: expect.any(String) });
    expect(posts).toHaveLength(1);
    await im.dispose();
  });

  it("rejects an outbound sendText whose deliveryContext belongs to a different bot", async () => {
    // 入站时绑定的代次与当前机器人不一致时，sendText 也必须 fail closed。
    const { im, client, posts } = createHarness();
    await im.saveConfig("ding-client-a", "invalid-test-secret", "staff-1");
    const deliveryContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client-a",
      sessionWebhook: "",
      sessionWebhookExpiredTime: 0,
    });

    // 切换到机器人 B（同 owner）。
    await im.saveConfig("ding-client-b", "invalid-test-secret", "staff-1");

    // 旧 turn 的 deliveryContext 仍属 A，应被拒绝。
    await expect(
      im.sendText("staff-1", "stale reply", { deliveryContext }),
    ).rejects.toThrow("DINGTALK_STALE_TURN");
    expect(posts).toHaveLength(0);
    await im.dispose();
  });

  it("stops after a non-retryable chunk failure and sends an incomplete notice", async () => {
    // 分块发送时若中间段失败（且不属于可重试错误），应立即停止后续分块，
    // 并发送一条简短提示告知用户回复不完整。
    const { im, client, posts } = createHarness({
      postResponse: ({ index }) => {
        // index 1 是第 2 段的首次发送，模拟不可重试错误。
        if (index === 1) throw new Error("DINGTALK_CHUNK_RATE_LIMITED");
        return { status: 200, body: { errcode: 0 } };
      },
    });
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    const deliveryContext = await receiveDeliveryContext(im, client, {
      // 不提供 session webhook，使所有分块走主动发送 API。
      robotCode: "ding-client",
      sessionWebhook: "",
      sessionWebhookExpiredTime: 0,
    });

    const longText = "a".repeat(8001);
    await expect(
      im.commitFinal({
        userId: "staff-1",
        text: longText,
        terminal: "done",
        deliveryContext,
      }),
    ).rejects.toThrow("DINGTALK_CHUNK_RATE_LIMITED");

    const sentTexts = posts.map(readProactiveText);
    expect(sentTexts).toEqual([
      expect.stringMatching(/^\[1\/3\]\n\n/),
      expect.stringMatching(/^\[2\/3\]\n\n/),
      "⚠️ 回复第 2/3 段发送失败，本次回复不完整，请重试。",
    ]);
    expect(sentTexts.some((text) => text.startsWith("[3/3]"))).toBe(false);
    await im.dispose();
  });

  it("stops and sends incomplete notice after a retryable chunk failure", async () => {
    // 对 429 限流错误，应做有限重试；重试仍失败后停止后续分块并发送提示。
    vi.useFakeTimers();
    const { im, client, posts } = createHarness({
      postResponse: ({ index }) => {
        // index 0: chunk 1 成功
        // index 1, 2, 3: chunk 2 的初始发送 + 2 次重试，全部 429
        if (index >= 1 && index <= 3)
          return { status: 429, body: { message: "rate limited" } };
        return { status: 200, body: { errcode: 0 } };
      },
    });
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    const deliveryContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client",
      sessionWebhook: "",
      sessionWebhookExpiredTime: 0,
    });

    const longText = "a".repeat(8001);
    const sendPromise = expect(
      im.commitFinal({
        userId: "staff-1",
        text: longText,
        terminal: "done",
        deliveryContext,
      }),
    ).rejects.toThrow("DINGTALK_PROACTIVE_HTTP_429");

    // 推进 fake timer 让退避 setTimeout 立即到期。
    await vi.advanceTimersByTimeAsync(3_000);
    await sendPromise;

    const sentTexts = posts.map(readProactiveText);
    expect(sentTexts).toEqual([
      expect.stringMatching(/^\[1\/3\]\n\n/),
      expect.stringMatching(/^\[2\/3\]\n\n/),
      expect.stringMatching(/^\[2\/3\]\n\n/),
      expect.stringMatching(/^\[2\/3\]\n\n/),
      "⚠️ 回复第 2/3 段发送失败，本次回复不完整，请重试。",
    ]);
    expect(sentTexts.some((text) => text.startsWith("[3/3]"))).toBe(false);
    await im.dispose();
  });

  it("continues with later chunks when a retry succeeds", async () => {
    // 第 2 段首次遇到 429，第一次重试成功后应继续发送第 3 段。
    vi.useFakeTimers();
    const { im, client, posts } = createHarness({
      postResponse: ({ index }) =>
        index === 1
          ? { status: 429, body: { message: "rate limited" } }
          : { status: 200, body: { errcode: 0 } },
    });
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    const deliveryContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client",
      sessionWebhook: "",
      sessionWebhookExpiredTime: 0,
    });

    const commitPromise = im.commitFinal({
      userId: "staff-1",
      text: "a".repeat(8001),
      terminal: "done",
      deliveryContext,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(commitPromise).resolves.toBeUndefined();

    expect(posts.map(readProactiveText)).toEqual([
      expect.stringMatching(/^\[1\/3\]\n\n/),
      expect.stringMatching(/^\[2\/3\]\n\n/),
      expect.stringMatching(/^\[2\/3\]\n\n/),
      expect.stringMatching(/^\[3\/3\]\n\n/),
    ]);
    await im.dispose();
  });

  it("numbers every chunk without exceeding the DingTalk text budget", async () => {
    const { im, client, posts } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    const deliveryContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client",
      sessionWebhook: "",
      sessionWebhookExpiredTime: 0,
    });

    await im.commitFinal({
      userId: "staff-1",
      text: "😀".repeat(8001),
      terminal: "done",
      deliveryContext,
    });

    const sentTexts = posts.map(readProactiveText);
    expect(sentTexts.map((text) => text.slice(0, 5))).toEqual([
      "[1/3]",
      "[2/3]",
      "[3/3]",
    ]);
    expect(sentTexts.every((text) => Array.from(text).length <= 4_000)).toBe(
      true,
    );
    await im.dispose();
  });

  it("preserves the chunk error when the incomplete notice also fails", async () => {
    const originalError = new Error("DINGTALK_CHUNK_REJECTED");
    const { im, client, posts } = createHarness({
      postResponse: ({ index }) => {
        if (index === 1) throw originalError;
        if (index === 2) throw new Error("DINGTALK_NOTICE_FAILED");
        return { status: 200, body: { errcode: 0 } };
      },
    });
    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    const deliveryContext = await receiveDeliveryContext(im, client, {
      robotCode: "ding-client",
      sessionWebhook: "",
      sessionWebhookExpiredTime: 0,
    });

    await expect(
      im.commitFinal({
        userId: "staff-1",
        text: "a".repeat(8001),
        terminal: "done",
        deliveryContext,
      }),
    ).rejects.toBe(originalError);
    expect(posts.map(readProactiveText)).toEqual([
      expect.stringMatching(/^\[1\/3\]\n\n/),
      expect.stringMatching(/^\[2\/3\]\n\n/),
      "⚠️ 回复第 2/3 段发送失败，本次回复不完整，请重试。",
    ]);
    await im.dispose();
  });

  it("retries proactive reply with new connection after reconnect races token fetch", async () => {
    // 获取 token 期间发生重连，旧 token 请求返回 DINGTALK_CONNECTION_CHANGED。
    // 新逻辑应捕获该错误，使用新连接重试一次并成功发送。
    const firstClient = new FakeClient();
    const nextClient = new FakeClient();
    const clients = [firstClient, nextClient];
    const token = deferred<string>();
    vi.spyOn(firstClient, "getAccessToken").mockReturnValue(token.promise);
    const { im, posts } = createHarness({
      clientFactory: () => {
        const client = clients.shift();
        if (!client) throw new Error("DINGTALK_TEST_CLIENT_EXHAUSTED");
        return client;
      },
    });

    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    const sendPromise = im.sendText("staff-1", "done");
    await Promise.resolve();

    // 触发重连，新 client 使用默认的 getAccessToken（立即返回）。
    await im.reconnect();
    // 旧 token 请求返回，触发 DINGTALK_CONNECTION_CHANGED。
    token.resolve("stale-token");

    // 重连后应使用新 client 重试，最终发送成功。
    await expect(sendPromise).resolves.toMatchObject({
      messageId: expect.any(String),
    });
    // 仅产生 1 次主动发送 POST（重试后的那次）。
    expect(posts).toHaveLength(1);
    await im.dispose();
  });

  it("fails closed when config changes during proactive token fetch", async () => {
    // 如果重连后 Client ID 已变更，不得用新机器人发送旧会话结果。
    const firstClient = new FakeClient();
    const nextClient = new FakeClient();
    const clients = [firstClient, nextClient];
    const token = deferred<string>();
    vi.spyOn(firstClient, "getAccessToken").mockReturnValue(token.promise);
    const { im } = createHarness({
      clientFactory: () => {
        const client = clients.shift();
        if (!client) throw new Error("DINGTALK_TEST_CLIENT_EXHAUSTED");
        return client;
      },
    });

    await im.saveConfig("ding-client", "invalid-test-secret", "staff-1");
    const sendPromise = im.sendText("staff-1", "done");
    await Promise.resolve();

    // 重连前更换 Client ID，模拟配置变更。
    await im.saveConfig("ding-client-new", "invalid-test-secret", "staff-1");
    token.resolve("stale-token");

    await expect(sendPromise).rejects.toThrow("DINGTALK_STALE_TURN");
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
        write: (key, value) => {
          secrets.set(key, value);
          return true;
        },
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
    const result = await im.saveConfig("bad-client", "bad-secret", "staff-bad");

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
