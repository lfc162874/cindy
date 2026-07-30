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

function createHarness() {
  const secrets = new Map<string, string>();
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const posts: Array<{ url: string; body: unknown }> = [];
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
    httpPostJson: async (url, body) => {
      posts.push({ url, body });
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

    const state = await im.saveConfig("ding-client", "invalid-test-secret");

    expect(state.status).toEqual({ kind: "connected", appId: "ding-client" });
    expect(client.registered).toBe(false);
    expect(state.clientId).toBe("ding-client");
    expect(state).not.toHaveProperty("clientSecret");
    expect(secrets.get("dingtalk-bot-client-secret")).toBe(
      "invalid-test-secret",
    );
    await im.dispose();
  });

  it("accepts only direct messages from the TOFU owner and deduplicates retries", async () => {
    const { im, client } = createHarness();
    const messages: unknown[] = [];
    im.onMessage((message) => messages.push(message));
    await im.saveConfig("ding-client", "invalid-test-secret");

    client.emit(directText());
    client.emit(directText());
    client.emit(directText({ msgId: "msg-group", conversationType: "2" }));
    client.emit(directText({ msgId: "msg-other", senderStaffId: "staff-2" }));
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

  it("replies through the allowlisted session webhook", async () => {
    const { im, client, posts } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret");
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

  it("refuses non-DingTalk reply webhooks", async () => {
    const { im, client } = createHarness();
    await im.saveConfig("ding-client", "invalid-test-secret");
    client.emit(
      directText({
        sessionWebhook: "https://example.com/steal",
      }),
    );
    await Promise.resolve();

    await expect(im.sendText("staff-1", "nope")).rejects.toThrow(
      "DINGTALK_REPLY_ROUTE_EXPIRED",
    );
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
