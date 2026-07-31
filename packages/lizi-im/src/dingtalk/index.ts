import { randomUUID } from "node:crypto";

import {
  DWClient,
  TOPIC_ROBOT,
  type DWClientDownStream,
} from "dingtalk-stream";

import { BaseIM } from "../BaseIM.js";
import type { RichChannelIM, ImFinalOutput } from "../channelIM.js";
import type {
  IMCardActionEvent,
  IMHost,
  IMMessageEvent,
  IMStatus,
  SendFileResult,
  StreamingTextHandle,
} from "../types.js";
import { chunkDingTalkMarkdown, sanitizeDingTalkMarkdown } from "./chunk.js";
import {
  isDingTalkDirectMessage,
  parseDingTalkRobotPayload,
  toDingTalkMessageEvent,
  type DingTalkRobotPayload,
} from "./inbound.js";

const CLIENT_ID_SECRET_KEY = "dingtalk-bot-client-id";
const CLIENT_SECRET_SECRET_KEY = "dingtalk-bot-client-secret";
const OWNER_USER_ID_SECRET_KEY = "dingtalk-bot-owner-user-id";
const CONNECTION_TIMEOUT_MS = 15_000;
const CONNECTION_POLL_MS = 100;
const STATUS_POLL_MS = 1_000;
const WEBHOOK_HOSTS = new Set(["oapi.dingtalk.com", "api.dingtalk.com"]);
const PROACTIVE_DIRECT_MESSAGE_URL =
  "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
const ACCESS_TOKEN_HEADER = "x-acs-dingtalk-access-token";
const DEDUP_CAPACITY = 512;

type MessageHandler = (event: IMMessageEvent) => void;
type CardActionHandler = (event: IMCardActionEvent) => void;
type StatusHandler = (status: IMStatus) => void;

export interface DingTalkStreamClient {
  connected: boolean;
  registered?: boolean;
  registerCallbackListener(
    topic: string,
    callback: (event: DWClientDownStream) => void,
  ): DingTalkStreamClient;
  socketCallBackResponse(messageId: string, result: unknown): void;
  getAccessToken(): Promise<unknown>;
  connect(): Promise<void>;
  disconnect(): void;
}

export interface DingTalkIMOptions {
  clientFactory?: (credentials: {
    clientId: string;
    clientSecret: string;
  }) => DingTalkStreamClient;
  now?: () => number;
}

export interface DingTalkBotState {
  status: IMStatus;
  clientId: string | null;
  hasSecret: boolean;
  ownerUserId: string | null;
}

interface ReplyRoute {
  webhook: string;
  expiresAt: number;
}

/**
 * DingTalk application-bot transport for the first text-only milestone.
 * It accepts direct messages through Stream Mode. Replies prefer the
 * short-lived session webhook delivered with each inbound message, then use
 * DingTalk's proactive one-to-one API when that route is no longer usable.
 */
export class DingTalkIM extends BaseIM implements RichChannelIM {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly cardActionHandlers = new Set<CardActionHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly replyRoutes = new Map<string, ReplyRoute>();
  private readonly seenMessageIds = new Map<string, true>();
  private readonly clientFactory: NonNullable<
    DingTalkIMOptions["clientFactory"]
  >;
  private readonly now: () => number;

  private client: DingTalkStreamClient | null = null;
  private status: IMStatus = { kind: "idle" };
  private clientId = "";
  private ownerUserId = "";
  private connectionVersion = 0;
  private proactiveAccessToken: string | null = null;
  private proactiveAccessTokenPromise: Promise<string> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(host: IMHost, options: DingTalkIMOptions = {}) {
    super("dingtalk", host);
    this.clientFactory =
      options.clientFactory ??
      ((credentials) =>
        new DWClient({
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          keepAlive: true,
          ua: "Cindy Desktop",
        }));
    this.now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    const credentials = this.readCredentials();
    this.ownerUserId =
      this.host.secrets.read(OWNER_USER_ID_SECRET_KEY)?.trim() ?? "";
    if (!credentials) {
      this.clientId = "";
      this.ownerUserId = "";
      this.setStatus({ kind: "idle" });
      return;
    }
    this.clientId = credentials.clientId;
    await this.connect(credentials);
  }

  async dispose(): Promise<void> {
    this.connectionVersion += 1;
    this.stopStatusTimer();
    this.client?.disconnect();
    this.client = null;
    this.replyRoutes.clear();
    this.clearProactiveAccessToken();
    // Runtime identity belongs to the live connection. Persistent credentials
    // remain in secure storage so reconnect can restore them explicitly.
    this.clientId = "";
    this.ownerUserId = "";
    this.setStatus({ kind: "idle" });
  }

  registerIpc(): void {
    // Desktop registers guarded IPC handlers in its main-process composition root.
  }

  getState(): DingTalkBotState {
    return {
      status: this.status,
      clientId: this.clientId || null,
      hasSecret: this.readCredentials() !== null,
      ownerUserId: this.ownerUserId || null,
    };
  }

  async saveConfig(
    clientId: string,
    clientSecret: string,
    ownerUserId: string,
  ): Promise<DingTalkBotState> {
    const nextClientId = clientId.trim();
    const nextClientSecret = clientSecret.trim();
    const nextOwnerUserId = ownerUserId.trim();
    if (!nextClientId || !nextClientSecret || !nextOwnerUserId)
      throw new Error("DINGTALK_CREDENTIALS_REQUIRED");
    if (!this.host.secrets.isAvailable())
      throw new Error("DINGTALK_SECURE_STORAGE_UNAVAILABLE");

    const previous = this.readCredentials();
    const previousOwnerUserId = this.host.secrets.read(
      OWNER_USER_ID_SECRET_KEY,
    );
    if (!this.host.secrets.write(CLIENT_ID_SECRET_KEY, nextClientId)) {
      throw new Error("DINGTALK_CREDENTIAL_SAVE_FAILED");
    }
    if (!this.host.secrets.write(CLIENT_SECRET_SECRET_KEY, nextClientSecret)) {
      this.restoreSecret(CLIENT_ID_SECRET_KEY, previous?.clientId ?? null);
      throw new Error("DINGTALK_CREDENTIAL_SAVE_FAILED");
    }
    if (!this.host.secrets.write(OWNER_USER_ID_SECRET_KEY, nextOwnerUserId)) {
      this.restoreSecret(CLIENT_ID_SECRET_KEY, previous?.clientId ?? null);
      this.restoreSecret(
        CLIENT_SECRET_SECRET_KEY,
        previous?.clientSecret ?? null,
      );
      this.restoreSecret(OWNER_USER_ID_SECRET_KEY, previousOwnerUserId);
      throw new Error("DINGTALK_CREDENTIAL_SAVE_FAILED");
    }

    this.clientId = nextClientId;
    this.ownerUserId = nextOwnerUserId;
    await this.connect({
      clientId: nextClientId,
      clientSecret: nextClientSecret,
    });
    return this.getState();
  }

  async reconnect(): Promise<DingTalkBotState> {
    const credentials = this.readCredentials();
    if (!credentials) throw new Error("DINGTALK_CREDENTIALS_MISSING");
    const ownerUserId =
      this.host.secrets.read(OWNER_USER_ID_SECRET_KEY)?.trim() ?? "";
    if (!ownerUserId) throw new Error("DINGTALK_OWNER_USER_ID_MISSING");
    this.clientId = credentials.clientId;
    this.ownerUserId = ownerUserId;
    await this.connect(credentials);
    return this.getState();
  }

  async clearConfig(): Promise<DingTalkBotState> {
    await this.dispose();
    this.host.secrets.remove(CLIENT_ID_SECRET_KEY);
    this.host.secrets.remove(CLIENT_SECRET_SECRET_KEY);
    this.host.secrets.remove(OWNER_USER_ID_SECRET_KEY);
    this.clientId = "";
    this.ownerUserId = "";
    this.setStatus({ kind: "idle" });
    return this.getState();
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onCardAction(handler: CardActionHandler): () => void {
    this.cardActionHandlers.add(handler);
    return () => this.cardActionHandlers.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  getStatus(): IMStatus {
    return this.status;
  }

  sendText(userId: string, text: string): Promise<{ messageId: string }> {
    return this.postReply(
      userId,
      {
        msgtype: "text",
        text: { content: text },
        at: { atUserIds: [] },
      },
      text,
    );
  }

  sendMarkdownText(
    userId: string,
    markdown: string,
  ): Promise<{ messageId: string }> {
    const text = sanitizeDingTalkMarkdown(markdown);
    return this.postReply(
      userId,
      {
        msgtype: "markdown",
        markdown: { title: "Cindy", text },
        at: { atUserIds: [] },
      },
      text,
    );
  }

  async commitFinal(output: ImFinalOutput): Promise<void> {
    const chunks = chunkDingTalkMarkdown(sanitizeDingTalkMarkdown(output.text));
    for (const chunk of chunks) {
      await this.sendMarkdownText(output.userId, chunk);
    }
  }

  sendFile(): Promise<SendFileResult> {
    return Promise.resolve({ ok: false, reason: "SEND_FAIL" });
  }

  sendInteractiveCard(): Promise<{ messageId: string }> {
    return Promise.reject(new Error("DINGTALK_RICH_OUTPUT_UNSUPPORTED"));
  }

  updateInteractiveCard(): Promise<void> {
    return Promise.reject(new Error("DINGTALK_RICH_OUTPUT_UNSUPPORTED"));
  }

  patchMarkdownCard(): Promise<void> {
    return Promise.reject(new Error("DINGTALK_RICH_OUTPUT_UNSUPPORTED"));
  }

  startStreamingText(): Promise<StreamingTextHandle> {
    return Promise.reject(new Error("DINGTALK_RICH_OUTPUT_UNSUPPORTED"));
  }

  private async connect(credentials: {
    clientId: string;
    clientSecret: string;
  }): Promise<void> {
    const version = ++this.connectionVersion;
    this.stopStatusTimer();
    this.client?.disconnect();
    this.replyRoutes.clear();
    this.clearProactiveAccessToken();
    const client = this.clientFactory(credentials);
    this.client = client;
    this.setStatus({ kind: "connecting" });
    client.registerCallbackListener(TOPIC_ROBOT, (event) => {
      // CALLBACK topics are not auto-acked by the SDK. Acknowledge before
      // handing work to the app so DingTalk does not retry during a long turn.
      client.socketCallBackResponse(event.headers.messageId, {
        status: "SUCCESS",
      });
      queueMicrotask(() => {
        if (version !== this.connectionVersion || this.client !== client)
          return;
        this.handleDownstream(event, credentials.clientId);
      });
    });

    try {
      const connectPromise = client.connect();
      await withTimeout(connectPromise, CONNECTION_TIMEOUT_MS);
      await waitForConnected(client, CONNECTION_TIMEOUT_MS);
      if (version !== this.connectionVersion || this.client !== client) {
        client.disconnect();
        return;
      }
      this.setStatus({ kind: "connected", appId: credentials.clientId });
      this.statusTimer = setInterval(() => {
        if (version !== this.connectionVersion || this.client !== client)
          return;
        this.setStatus(
          client.connected
            ? { kind: "connected", appId: credentials.clientId }
            : { kind: "connecting" },
        );
      }, STATUS_POLL_MS);
      this.statusTimer.unref?.();
    } catch (error) {
      if (version !== this.connectionVersion || this.client !== client) return;
      client.disconnect();
      this.client = null;
      const failure = dingTalkConnectFailure(error);
      this.log.warn(`DingTalk connection failed: ${failure.logMessage}`);
      this.setStatus({ kind: "error", reason: failure.code });
    }
  }

  private handleDownstream(
    event: DWClientDownStream,
    fallbackContextId: string,
  ): void {
    const payload = parseDingTalkRobotPayload(event);
    if (
      !payload ||
      !isDingTalkDirectMessage(payload) ||
      this.seen(payload.msgId)
    )
      return;
    // DingTalk's proactive one-to-one API addresses staff IDs. Requiring the
    // configured senderStaffId here gives inbound authorization and delayed
    // outbound delivery one stable identity instead of trusting the first DM.
    const userId = payload.senderStaffId.trim();
    if (!userId || userId !== this.ownerUserId) return;
    const route = replyRoute(payload, this.now());
    if (route) this.replyRoutes.set(userId, route);
    const message = toDingTalkMessageEvent(payload, fallbackContextId);
    for (const handler of this.messageHandlers) handler(message);
  }

  private async postReply(
    userId: string,
    body: unknown,
    proactiveText: string,
  ): Promise<{ messageId: string }> {
    if (!this.ownerUserId || userId !== this.ownerUserId) {
      throw new Error("DINGTALK_RECIPIENT_NOT_OWNER");
    }
    if (!this.host.httpPostJson)
      throw new Error("DINGTALK_JSON_TRANSPORT_UNAVAILABLE");

    const route = this.replyRoutes.get(userId);
    if (route && route.expiresAt > this.now()) {
      // A thrown transport error is ambiguous: the webhook may have accepted
      // the message before the connection failed. Do not fall back and risk a
      // duplicate; only an explicit DingTalk rejection is safe to reroute.
      const response = await this.host.httpPostJson(route.webhook, body);
      const apiError = dingTalkApiError(response.body);
      if (
        response.status >= 200 &&
        response.status < 300 &&
        apiError === null
      ) {
        return { messageId: randomUUID() };
      }
      if (!apiError && (response.status < 400 || response.status >= 500)) {
        throw new Error(`DINGTALK_REPLY_HTTP_${response.status}`);
      }
      this.replyRoutes.delete(userId);
    } else if (route) {
      this.replyRoutes.delete(userId);
    }

    await this.postProactiveReply(userId, proactiveText);
    return { messageId: randomUUID() };
  }

  private async postProactiveReply(
    userId: string,
    text: string,
  ): Promise<void> {
    const body = {
      robotCode: this.clientId,
      userIds: [userId],
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title: "Cindy", text }),
    };
    let token = await this.getProactiveAccessToken();
    let response = await this.postProactiveRequest(body, token);
    if (response.status === 401) {
      // Tokens are intentionally cached only in memory. A 401 is the only
      // reliable expiry signal exposed by this SDK, so refresh exactly once.
      this.clearProactiveAccessToken();
      token = await this.getProactiveAccessToken();
      response = await this.postProactiveRequest(body, token);
    }
    assertProactiveResponse(response);
  }

  private async postProactiveRequest(
    body: unknown,
    token: string,
  ): Promise<{ status: number; body: unknown }> {
    if (!this.host.httpPostJson)
      throw new Error("DINGTALK_JSON_TRANSPORT_UNAVAILABLE");
    return this.host.httpPostJson(PROACTIVE_DIRECT_MESSAGE_URL, body, {
      headers: { [ACCESS_TOKEN_HEADER]: token },
    });
  }

  private async getProactiveAccessToken(): Promise<string> {
    if (this.proactiveAccessToken) return this.proactiveAccessToken;
    if (this.proactiveAccessTokenPromise)
      return this.proactiveAccessTokenPromise;

    const client = this.client;
    const version = this.connectionVersion;
    if (!client) throw new Error("DINGTALK_NOT_CONNECTED");

    const request = Promise.resolve(client.getAccessToken())
      .then((value) => {
        if (version !== this.connectionVersion || this.client !== client) {
          throw new Error("DINGTALK_CONNECTION_CHANGED");
        }
        if (typeof value !== "string" || !value.trim()) {
          throw new Error("DINGTALK_ACCESS_TOKEN_INVALID");
        }
        this.proactiveAccessToken = value.trim();
        return this.proactiveAccessToken;
      })
      .finally(() => {
        if (this.proactiveAccessTokenPromise === request) {
          this.proactiveAccessTokenPromise = null;
        }
      });
    this.proactiveAccessTokenPromise = request;
    return request;
  }

  private clearProactiveAccessToken(): void {
    this.proactiveAccessToken = null;
    this.proactiveAccessTokenPromise = null;
  }

  private readCredentials(): { clientId: string; clientSecret: string } | null {
    const clientId = this.host.secrets.read(CLIENT_ID_SECRET_KEY)?.trim() ?? "";
    const clientSecret =
      this.host.secrets.read(CLIENT_SECRET_SECRET_KEY)?.trim() ?? "";
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }

  private restoreSecret(key: string, value: string | null): void {
    if (value) this.host.secrets.write(key, value);
    else this.host.secrets.remove(key);
  }

  private setStatus(status: IMStatus): void {
    if (JSON.stringify(this.status) === JSON.stringify(status)) return;
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
    this.host.ipc.broadcast("dingtalkBot:state-change", this.getState());
  }

  private stopStatusTimer(): void {
    if (!this.statusTimer) return;
    clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  private seen(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) return true;
    this.seenMessageIds.set(messageId, true);
    while (this.seenMessageIds.size > DEDUP_CAPACITY) {
      const oldest = this.seenMessageIds.keys().next().value;
      if (oldest === undefined) break;
      this.seenMessageIds.delete(oldest);
    }
    return false;
  }
}

export function createDingTalkIM(
  host: IMHost,
  options?: DingTalkIMOptions,
): DingTalkIM {
  return new DingTalkIM(host, options);
}

function replyRoute(
  payload: DingTalkRobotPayload,
  now: number,
): ReplyRoute | null {
  if (!payload.sessionWebhook) return null;
  let url: URL;
  try {
    url = new URL(payload.sessionWebhook);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !WEBHOOK_HOSTS.has(url.hostname))
    return null;
  const rawExpiry = payload.sessionWebhookExpiredTime;
  const expiresAt =
    rawExpiry > 0
      ? rawExpiry < 1_000_000_000_000
        ? rawExpiry * 1_000
        : rawExpiry
      : now + 50 * 60_000;
  return expiresAt > now ? { webhook: url.toString(), expiresAt } : null;
}

async function waitForConnected(
  client: DingTalkStreamClient,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // The official SDK considers the WebSocket usable once `connected` flips.
  // `registered` is an informational flag that is not emitted consistently
  // by every gateway response, so requiring it causes false timeouts.
  while (!client.connected && Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, CONNECTION_POLL_MS),
    );
  }
  if (!client.connected) throw new Error("DINGTALK_CONNECT_TIMEOUT");
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("DINGTALK_CONNECT_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function dingTalkApiError(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const code = record.errcode;
  if (code === undefined || code === 0 || code === "0") return null;
  return `DINGTALK_API_${String(code)}`;
}

function assertProactiveResponse(response: {
  status: number;
  body: unknown;
}): void {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`DINGTALK_PROACTIVE_HTTP_${response.status}`);
  }
  if (
    !response.body ||
    typeof response.body !== "object" ||
    Array.isArray(response.body)
  ) {
    return;
  }
  const record = response.body as Record<string, unknown>;
  if (
    Array.isArray(record.invalidStaffIdList) &&
    record.invalidStaffIdList.length > 0
  ) {
    throw new Error("DINGTALK_PROACTIVE_INVALID_STAFF_ID");
  }
  if (
    Array.isArray(record.flowControlledStaffIdList) &&
    record.flowControlledStaffIdList.length > 0
  ) {
    throw new Error("DINGTALK_PROACTIVE_FLOW_CONTROLLED");
  }
}

function dingTalkConnectFailure(error: unknown): { code: string; logMessage: string } {
  const status = responseStatus(error);
  if (status === 400 || status === 401) {
    return {
      code: `DINGTALK_CONNECT_HTTP_${status}`,
      logMessage: `HTTP ${status}`,
    };
  }
  const message = error instanceof Error ? error.message : "DINGTALK_CONNECT_FAILED";
  return {
    code: message === "DINGTALK_CONNECT_TIMEOUT" ? message : "DINGTALK_CONNECT_FAILED",
    logMessage: message,
  };
}

function responseStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("response" in error)) return null;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object" || !("status" in response)) return null;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}
