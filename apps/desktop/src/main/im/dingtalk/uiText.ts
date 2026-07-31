import type { ImUiTextPack } from '../shared/types';
import { getResolvedMainLocale } from '../../i18n';
import { ui as wechatUi } from '../wechat/uiText';
import { DINGTALK_UI_TEXT_CATALOG, type DingTalkUiTextCatalog } from './uiTextCatalog';

type TemplateVars = Record<string, string | number>;

function format(template: string, vars: TemplateVars = {}): string {
  let value = template;
  for (const [key, replacement] of Object.entries(vars)) {
    value = value.replaceAll(`{{${key}}}`, () => String(replacement));
  }
  return value;
}

function currentCopy(): DingTalkUiTextCatalog {
  return DINGTALK_UI_TEXT_CATALOG[getResolvedMainLocale()];
}

/**
 * DingTalk's first milestone is text-only. Reachable slash/agent copy is
 * resolved at send time from the current main-process locale. Card copy stays
 * in the structural contract but is unreachable because rich commands are
 * disabled by the adapter.
 */
export const ui = {
  ...wechatUi,
  slash: {
    ...wechatUi.slash,
    get new() {
      return currentCopy().slash.newConversation;
    },
    get help() {
      return currentCopy().slash.help;
    },
    unknownCommand: (command: string) =>
      format(currentCopy().slash.unknownCommand, { command }),
    get detachedBySlash() {
      return currentCopy().slash.remoteControlUnsupported;
    },
    get detachedByRevoke() {
      return currentCopy().slash.remoteControlRevoked;
    },
    get notAttached() {
      return currentCopy().slash.remoteControlUnsupported;
    },
  },
  agent: {
    ...wechatUi.agent,
    get completedNoText() {
      return currentCopy().agent.completedNoText;
    },
    runtimeError: (error: string) => format(currentCopy().agent.runtimeError, { error }),
    sendInternalError: (error: string) =>
      format(currentCopy().agent.sendInternalError, { error }),
    get apiKeyMissing() {
      return currentCopy().agent.apiKeyMissing;
    },
    authMissing: (details) => {
      const copy = currentCopy().agent;
      const provider = details.providerLabel ?? details.providerId ?? copy.providerFallback;
      const reason =
        details.missing === 'gateway-key'
          ? copy.authReason.gatewayKey
          : details.missing === 'provider-key'
            ? copy.authReason.providerKey
            : details.missing === 'provider-disconnected'
              ? copy.authReason.providerDisconnected
              : format(copy.authReason.agentCredential, { agentKind: details.agentKind });
      return format(copy.authMissing, {
        provider,
        model: details.model,
        reason,
      });
    },
    get controlInProgress() {
      return currentCopy().agent.controlInProgress;
    },
    get credentialBusy() {
      return currentCopy().agent.credentialBusy;
    },
    queuedNotice: (position: number) =>
      format(currentCopy().agent.queuedNotice, { position }),
    stopDone: (droppedQueued: number) =>
      droppedQueued > 0
        ? format(currentCopy().agent.stopDoneWithQueue, { count: droppedQueued })
        : currentCopy().agent.stopDone,
    get stopIdle() {
      return currentCopy().agent.stopIdle;
    },
    scheduledTaskHeader: (name: string | null) =>
      name
        ? format(currentCopy().agent.scheduledTaskHeaderNamed, { name })
        : currentCopy().agent.scheduledTaskHeader,
    unsupportedOnly: (entries) => {
      const copy = currentCopy().agent;
      return format(copy.unsupportedOnly, {
        entries: entries.map((entry) => entry.label).join(copy.listSeparator),
      });
    },
    unsupportedNotice: (entries) => {
      const copy = currentCopy().agent;
      return format(copy.unsupportedNotice, {
        entries: entries.map((entry) => entry.label).join(copy.listSeparator),
      });
    },
  },
} satisfies ImUiTextPack;
