import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

const log = createLogger('useDingTalkBot');

const EMPTY_STATE: DingTalkBotState = {
  status: { kind: 'idle' },
  clientId: null,
  hasSecret: false,
  ownerUserId: null,
};

let cachedState: DingTalkBotState | null = null;

export function dingTalkConnectionErrorKey(reason: string): string {
  if (reason === 'DINGTALK_CONNECT_HTTP_401') {
    return 'settings.dingtalkBot.connectionErrors.unauthorized';
  }
  if (reason === 'DINGTALK_CONNECT_HTTP_400') {
    return 'settings.dingtalkBot.connectionErrors.badRequest';
  }
  if (reason === 'DINGTALK_CONNECT_TIMEOUT') {
    return 'settings.dingtalkBot.connectionErrors.timeout';
  }
  return 'settings.dingtalkBot.connectionError';
}

export function useDingTalkBot() {
  const { t } = useTranslation();
  const [state, setState] = useState<DingTalkBotState>(() => cachedState ?? EMPTY_STATE);
  const [clientId, setClientId] = useState(() => cachedState?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [ownerUserId, setOwnerUserId] = useState(() => cachedState?.ownerUserId ?? '');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'reconnect' | 'clear' | null>(null);

  const applyState = useCallback((next: DingTalkBotState) => {
    cachedState = next;
    setState(next);
    setClientId(next.clientId ?? '');
    setOwnerUserId(next.ownerUserId ?? '');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.dingtalkBot
      .getState()
      .then((next) => {
        if (cancelled) return;
        // If the main process reports a different identity than the module
        // cache (e.g. account A logged out while this page was unmounted and
        // the dispose broadcast was missed), discard the stale cache so the
        // next account does not inherit the previous one's Client ID / Staff ID.
        if (cachedState && cachedState.clientId !== next.clientId) {
          cachedState = null;
        }
        applyState(next);
      })
      .catch((error) => log.error('getState failed', extractIpcError(error)?.code ?? 'UNKNOWN'));
    const unsubscribe = window.electronAPI.dingtalkBot.onStateChange(applyState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyState]);

  const save = useCallback(async () => {
    if (busy) return false;
    const nextClientId = clientId.trim();
    const nextSecret = clientSecret.trim();
    const nextOwnerUserId = ownerUserId.trim();
    if (!nextClientId || !nextSecret || !nextOwnerUserId) {
      setValidationError(t('logic.validation.dingtalkFieldsRequired'));
      return false;
    }
    setValidationError(null);
    setBusy('save');
    try {
      const next = await window.electronAPI.dingtalkBot.save({
        clientId: nextClientId,
        clientSecret: nextSecret,
        ownerUserId: nextOwnerUserId,
      });
      applyState(next);
      setClientSecret('');
      if (next.status.kind === 'error') {
        toast.error(t(dingTalkConnectionErrorKey(next.status.reason)));
        return false;
      }
      toast.success(t('logic.toasts.dingtalkBotConnected'));
      return true;
    } catch (error) {
      log.error('save failed', extractIpcError(error)?.code ?? 'UNKNOWN');
      toast.error(t('logic.toasts.dingtalkBotConnectFailed'));
      return false;
    } finally {
      setBusy(null);
    }
  }, [applyState, busy, clientId, clientSecret, ownerUserId, t]);

  const reconnect = useCallback(async () => {
    if (busy) return;
    setBusy('reconnect');
    try {
      const next = await window.electronAPI.dingtalkBot.reconnect();
      applyState(next);
      if (next.status.kind === 'error') {
        toast.error(t(dingTalkConnectionErrorKey(next.status.reason)));
      }
      else toast.success(t('logic.toasts.dingtalkBotConnected'));
    } catch (error) {
      log.error('reconnect failed', extractIpcError(error)?.code ?? 'UNKNOWN');
      toast.error(t('logic.toasts.dingtalkBotConnectFailed'));
    } finally {
      setBusy(null);
    }
  }, [applyState, busy, t]);

  const clear = useCallback(async () => {
    if (busy) return;
    setBusy('clear');
    try {
      applyState(await window.electronAPI.dingtalkBot.clear());
      setClientId('');
      setClientSecret('');
      setOwnerUserId('');
      setValidationError(null);
      toast.success(t('logic.toasts.dingtalkBotCleared'));
    } catch (error) {
      log.error('clear failed', extractIpcError(error)?.code ?? 'UNKNOWN');
      toast.error(t('logic.toasts.dingtalkBotClearFailed'));
    } finally {
      setBusy(null);
    }
  }, [applyState, busy, t]);

  return {
    state,
    clientId,
    setClientId: (value: string) => {
      setClientId(value);
      setValidationError(null);
    },
    clientSecret,
    setClientSecret: (value: string) => {
      setClientSecret(value);
      setValidationError(null);
    },
    ownerUserId,
    setOwnerUserId: (value: string) => {
      setOwnerUserId(value);
      setValidationError(null);
    },
    validationError,
    busy,
    save,
    reconnect,
    clear,
  };
}
