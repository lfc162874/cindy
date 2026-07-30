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
  const [validationError, setValidationError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'reconnect' | 'clear' | null>(null);

  const applyState = useCallback((next: DingTalkBotState) => {
    cachedState = next;
    setState(next);
    setClientId(next.clientId ?? '');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.dingtalkBot
      .getState()
      .then((next) => {
        if (!cancelled) applyState(next);
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
    if (!nextClientId || !nextSecret) {
      setValidationError(t('logic.validation.dingtalkFieldsRequired'));
      return false;
    }
    setValidationError(null);
    setBusy('save');
    try {
      const next = await window.electronAPI.dingtalkBot.save({
        clientId: nextClientId,
        clientSecret: nextSecret,
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
  }, [applyState, busy, clientId, clientSecret, t]);

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
    validationError,
    busy,
    save,
    reconnect,
    clear,
  };
}
