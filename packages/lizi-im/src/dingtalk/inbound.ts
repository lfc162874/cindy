import type { DWClientDownStream } from "dingtalk-stream";

import type { IMMessageEvent } from "../types.js";

export interface DingTalkRobotPayload {
  conversationId: string;
  conversationType: string;
  msgId: string;
  msgtype: string;
  robotCode: string;
  senderId: string;
  senderStaffId: string;
  senderNick: string;
  sessionWebhook: string;
  sessionWebhookExpiredTime: number;
  text?: { content?: string };
}

export function parseDingTalkRobotPayload(
  event: DWClientDownStream,
): DingTalkRobotPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(event.data) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  const payload: DingTalkRobotPayload = {
    conversationId: stringValue(raw.conversationId),
    conversationType: stringValue(raw.conversationType),
    msgId: stringValue(raw.msgId),
    msgtype: stringValue(raw.msgtype),
    robotCode: stringValue(raw.robotCode),
    senderId: stringValue(raw.senderId),
    senderStaffId: stringValue(raw.senderStaffId),
    senderNick: stringValue(raw.senderNick),
    sessionWebhook: stringValue(raw.sessionWebhook),
    sessionWebhookExpiredTime: numberValue(raw.sessionWebhookExpiredTime),
  };
  const text = isRecord(raw.text) ? stringValue(raw.text.content) : "";
  if (text) payload.text = { content: text };

  if (!payload.msgId || !payload.conversationId || !senderUserId(payload))
    return null;
  return payload;
}

export function isDingTalkDirectMessage(
  payload: DingTalkRobotPayload,
): boolean {
  return payload.conversationType === "1";
}

export function senderUserId(payload: DingTalkRobotPayload): string {
  return payload.senderStaffId || payload.senderId;
}

export function toDingTalkMessageEvent(
  payload: DingTalkRobotPayload,
  fallbackContextId: string,
): IMMessageEvent {
  const text =
    payload.msgtype === "text" ? (payload.text?.content ?? "").trim() : "";
  return {
    channelName: "dingtalk",
    senderId: senderUserId(payload),
    chatId: payload.conversationId,
    contextId: payload.robotCode || fallbackContextId,
    messageId: payload.msgId,
    text,
    attachments: [],
    unsupported:
      payload.msgtype === "text"
        ? []
        : [
            {
              type: payload.msgtype || "unknown",
              label: payload.msgtype || "unknown message",
            },
          ],
    raw: {
      conversationType: payload.conversationType,
      msgtype: payload.msgtype,
      senderNick: payload.senderNick,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
