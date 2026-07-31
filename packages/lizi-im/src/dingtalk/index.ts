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
const CHUNK_MAX_ATTEMPTS = 2;
const CHUNK_RETRY_DELAY_MS = 1_000;
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

/** Save-only metadata plus the current DingTalk runtime state after rollback. */
export interface DingTalkBotSaveResult extends DingTalkBotState {
  // The previous runtime may be connected again after rollback. Preserve the
  // attempted connection failure separately so the UI never reports success.
  saveErrorStatus?: IMStatus;
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
  ): Promise<DingTalkBotSaveResult> {
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
    const saveErrorStatus =
      this.status.kind === "connected" ? undefined : this.status;
    // If the new credentials failed to establish a connection, restore the
    // previous credentials and reconnect so the user is not left with a
    // broken config on restart. Mirrors the Discord/Telegram rollback
    // pattern: persistent secrets + runtime identity + old connection.
    if (saveErrorStatus && previous) {
      this.restoreSecret(CLIENT_ID_SECRET_KEY, previous.clientId);
      this.restoreSecret(CLIENT_SECRET_SECRET_KEY, previous.clientSecret);
      this.restoreSecret(OWNER_USER_ID_SECRET_KEY, previousOwnerUserId);
      this.clientId = previous.clientId;
      this.ownerUserId = previousOwnerUserId?.trim() || "";
      try {
        await this.connect(previous);
      } catch {
        // Best-effort: if the old credentials also fail, leave the error
        // status from the new attempt so the user sees what went wrong.
      }
    }
    return {
      ...this.getState(),
      ...(saveErrorStatus ? { saveErrorStatus } : {}),
    };
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
    // After deleting persisted credentials, force-broadcast the full cleared
    // snapshot. setStatus deduplicates identical payloads, so after dispose()
    // already set idle the second call would be silently skipped — other
    // renderer windows would never learn that hasSecret flipped to false.
    this.status = { kind: "idle" };
    this.broadcastState();
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
    // 每段带序号标记发送；若某段限流/服务端错误则有限重试。
    // 重试仍失败后立即停止发送后续分块，并尝试发送一条简短提示，
    // 让用户明确知道本次回复不完整。最后统一向上层抛出首个错误。
    let firstError: unknown = null;
    for (let index = 0; index < chunks.length; index += 1) {
      const numbered = `[${index + 1}/${chunks.length}]\n\n${chunks[index]}`;
      try {
        await this.sendChunkWithRetry(output.userId, numbered);
      } catch (error) {
        if (firstError === null) firstError = error;
        // 本段重试后仍然失败，停止后续分块发送，尝试发送残缺提示。
        await this.sendIncompleteNotice(output.userId, index, chunks.length);
        break;
      }
    }
    if (firstError !== null) throw firstError;
  }

  /**
   * 对单个分块做有限重试：仅 429 / 5xx 等可重试错误触发重试。
   * 其余错误（如参数不合法、权限不足）直接抛出。
   */
  private async sendChunkWithRetry(
    userId: string,
    markdown: string,
  ): Promise<void> {
    for (let attempt = 0; attempt <= CHUNK_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.sendMarkdownText(userId, markdown);
        return;
      } catch (error) {
        const retryable = isRetryableChunkError(error);
        if (!retryable || attempt >= CHUNK_MAX_ATTEMPTS) throw error;
        // 退避等待后再试，避免限流场景下立即重打。
        await new Promise<void>((resolve) =>
          setTimeout(resolve, CHUNK_RETRY_DELAY_MS * (attempt + 1)),
        );
      }
    }
  }

  /**
   * 分块发送失败后，尝试向用户发一条简短纯文本提示，
   * 说明第几段发送失败以及本次回复不完整。
   * 此方法本身不抛出异常：提示发送失败不影响上层错误链路。
   */
  private async sendIncompleteNotice(
    userId: string,
    failedIndex: number,
    total: number,
  ): Promise<void> {
    try {
      await this.sendText(
        userId,
        `⚠️ 回复第 ${failedIndex + 1}/${total} 段发送失败，本次回复不完整，请重试。`,
      );
    } catch {
      // 提示本身发送失败时静默忽略，不能覆盖原始错误。
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
      // Endpoint discovery and the WebSocket open event share one deadline so
      // a connection attempt can never consume two full timeout windows.
      const deadline = Date.now() + CONNECTION_TIMEOUT_MS;
      const connectPromise = client.connect();
      const disconnectIfStale = () => {
        // The SDK does not support cancellation. If endpoint discovery settles
        // after timeout/disposal/replacement, close the WebSocket it may have
        // constructed instead of leaving a ghost connection running.
        if (version !== this.connectionVersion || this.client !== client) {
          client.disconnect();
        }
      };
      void connectPromise.then(disconnectIfStale, disconnectIfStale);
      await withDeadline(connectPromise, deadline);
      await waitForConnected(client, deadline);
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
      // httpPostJson returns { error: string } when JSON.parse fails on the
      // response body. Treat that as a transport error rather than silently
      // accepting a 200 response whose body was not actually valid JSON.
      const parseError = httpPostJsonError(response.body);
      if (parseError) throw new Error(parseError);
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
    // 记录本次请求对应的身份，用于重连后判断是否仍属于同一机器人。
    // 如果 Client ID 或 Owner 已变更，不得把旧会话结果通过新机器人发送。
    const expectedClientId = this.clientId;
    const expectedOwnerUserId = this.ownerUserId;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.postProactiveReplyOnce(userId, text);
        return;
      } catch (error) {
        const connectionChanged =
          error instanceof Error &&
          error.message === "DINGTALK_CONNECTION_CHANGED";
        // 非重连错误或已经重试过一次，直接向上抛出。
        if (!connectionChanged || attempt > 0) throw error;
        // 配置（Client ID / Owner）已变更，禁止把旧结果发到新机器人。
        if (
          this.clientId !== expectedClientId ||
          this.ownerUserId !== expectedOwnerUserId ||
          this.ownerUserId !== userId
        ) {
          throw new Error("DINGTALK_CONFIG_CHANGED");
        }
        // 同一配置的网络重连：清除旧 token，下一轮将使用新连接获取新 token。
        this.clearProactiveAccessToken();
        if (!this.client) throw new Error("DINGTALK_NOT_CONNECTED");
      }
    }
  }

  private async postProactiveReplyOnce(
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
    this.broadcastState();
  }

  // Push the current state snapshot to all status handlers and renderer
  // windows without deduplication. Used when callers need to guarantee that
  // observers see a specific transition even if the status object is unchanged.
  private broadcastState(): void {
    for (const handler of this.statusHandlers) handler(this.status);
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
  deadline: number,
): Promise<void> {
  // The official SDK considers the WebSocket usable once `connected` flips.
  // `registered` is an informational flag that is not emitted consistently
  // by every gateway response, so requiring it causes false timeouts.
  while (!client.connected && Date.now() < deadline) {
    // Clamp the last poll to the remaining budget so timer granularity cannot
    // extend the connection attempt beyond the shared absolute deadline.
    const remainingMs = deadline - Date.now();
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(CONNECTION_POLL_MS, remainingMs)),
    );
  }
  if (!client.connected) throw new Error("DINGTALK_CONNECT_TIMEOUT");
}

async function withDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("DINGTALK_CONNECT_TIMEOUT");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("DINGTALK_CONNECT_TIMEOUT")),
          remainingMs,
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

// Detect the { error: string } sentinel that httpPostJson returns when the
// response body cannot be parsed as JSON. Returns an error code string when
// the body represents a transport-level parse failure, null otherwise.
function httpPostJsonError(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" && error
    ? "DINGTALK_HTTP_PARSE_ERROR"
    : null;
}

function assertProactiveResponse(response: {
  status: number;
  body: unknown;
}): void {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`DINGTALK_PROACTIVE_HTTP_${response.status}`);
  }
  // httpPostJson returns { error: string } when the response body cannot be
  // parsed as JSON. A 200 response with a parse failure is not a real success;
  // reject it before inspecting structured fields.
  const parseError = httpPostJsonError(response.body);
  if (parseError) throw new Error(parseError);
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

/**
 * 判断分块发送错误是否值得重试：仅 429（限流）和 5xx（服务端错误）重试，
 * 避免对 4xx 客户端错误做无意义重试。
 */
function isRetryableChunkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { message } = error;
  // 显式限流标记（来自 assertProactiveResponse / postReply 等）。
  if (message === "DINGTALK_PROACTIVE_FLOW_CONTROLLED") return true;
  // 错误码格式如 DINGTALK_PROACTIVE_HTTP_429 / DINGTALK_REPLY_HTTP_502。
  const httpMatch = /_HTTP_(\d{3})$/.exec(message);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    return status === 429 || (status >= 500 && status < 600);
  }
  // SDK 内部连接变化错误也值得在重连后重试。
  if (message === "DINGTALK_CONNECTION_CHANGED") return true;
  return false;
}

function dingTalkConnectFailure(error: unknown): {
  code: string;
  logMessage: string;
} {
  const status = responseStatus(error);
  if (status === 400 || status === 401) {
    return {
      code: `DINGTALK_CONNECT_HTTP_${status}`,
      logMessage: `HTTP ${status}`,
    };
  }
  const message =
    error instanceof Error ? error.message : "DINGTALK_CONNECT_FAILED";
  return {
    code:
      message === "DINGTALK_CONNECT_TIMEOUT"
        ? message
        : "DINGTALK_CONNECT_FAILED",
    logMessage: message,
  };
}

function responseStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("response" in error))
    return null;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object" || !("status" in response))
    return null;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}
