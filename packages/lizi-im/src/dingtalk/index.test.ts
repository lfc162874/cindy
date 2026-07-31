import { describe, expect, it, vi } from "vitest";
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
  return { im, client, secrets, broadcasts, posts };
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
});

describe("DingTalk text helpers", () => {
  it("chunks long Unicode text without breaking surrogate pairs", () => {
    expect(chunkDingTalkMarkdown("😀😀😀", 2)).toEqual(["😀😀", "😀"]);
  });

  it("removes local-only media URLs", () => {
    expect(sanitizeDingTalkMarkdown("![结果](xdt-image://abc)")).toBe(
      "[结果：图片暂不支持发送]",
    );
  });
});
