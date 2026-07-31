import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';
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

interface OwnerScopedDingTalkCache {
  ownerId: string | null;
  state: DingTalkBotState;
}

// The renderer survives logout, so every reusable snapshot must carry the
// Cindy data owner that produced it. An unscoped module cache can otherwise
// expose one account's DingTalk identifiers to the next account on first paint.
let cachedState: OwnerScopedDingTalkCache | null = null;

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
  const { dataOwnerId } = useAuth();
  const cachedForOwner = cachedState?.ownerId === dataOwnerId ? cachedState.state : null;
  const [state, setState] = useState<DingTalkBotState>(() => cachedForOwner ?? EMPTY_STATE);
  const [clientId, setClientId] = useState(() => cachedForOwner?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [ownerUserId, setOwnerUserId] = useState(() => cachedForOwner?.ownerUserId ?? '');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'reconnect' | 'clear' | null>(null);
  const activeOwnerIdRef = useRef(dataOwnerId);
  const stateOwnerIdRef = useRef(dataOwnerId);
  const requestGenerationRef = useRef(0);
  // Update during render, not in an effect, so an old promise resolving
  // between the owner-change render and passive effects is rejected as stale.
  activeOwnerIdRef.current = dataOwnerId;
  const ownerMatches = stateOwnerIdRef.current === dataOwnerId;

  const applyState = useCallback((next: DingTalkBotState) => {
    cachedState = { ownerId: dataOwnerId, state: next };
    stateOwnerIdRef.current = dataOwnerId;
    setState(next);
    setClientId(next.clientId ?? '');
    setOwnerUserId(next.ownerUserId ?? '');
  }, [dataOwnerId]);

  useEffect(() => {
    let cancelled = false;
    const requestGeneration = ++requestGenerationRef.current;
    const requestOwnerId = dataOwnerId;
    if (stateOwnerIdRef.current !== requestOwnerId) {
      // Clear all account-owned fields before the asynchronous main-process
      // read starts. The render that observed the owner mismatch already
      // exposes EMPTY_STATE below, so no previous-account frame is visible.
      stateOwnerIdRef.current = requestOwnerId;
      setState(EMPTY_STATE);
      setClientId('');
      setClientSecret('');
      setOwnerUserId('');
      setValidationError(null);
    }
    void window.electronAPI.dingtalkBot
      .getState()
      .then((next) => {
        // Account A reads may resolve after account B has mounted. Generation
        // and owner checks make those late responses side-effect free.
        if (
          cancelled ||
          requestGenerationRef.current !== requestGeneration ||
          activeOwnerIdRef.current !== requestOwnerId ||
          stateOwnerIdRef.current !== requestOwnerId
        ) return;
        applyState(next);
      })
      .catch((error) => log.error('getState failed', extractIpcError(error)?.code ?? 'UNKNOWN'));
    const unsubscribe = window.electronAPI.dingtalkBot.onStateChange((next) => {
      if (
        requestGenerationRef.current !== requestGeneration ||
        activeOwnerIdRef.current !== requestOwnerId ||
        stateOwnerIdRef.current !== requestOwnerId
      ) return;
      applyState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyState, dataOwnerId]);

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
      // saveErrorStatus describes the attempted replacement, while the
      // ordinary state may already be connected again through rollback.
      const { saveErrorStatus, ...nextState } = next;
      applyState(nextState);
      setClientSecret('');
      const errorStatus =
        saveErrorStatus?.kind === 'error'
          ? saveErrorStatus
          : nextState.status.kind === 'error'
            ? nextState.status
            : null;
      if (errorStatus) {
        toast.error(t(dingTalkConnectionErrorKey(errorStatus.reason)));
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
    state: ownerMatches ? state : EMPTY_STATE,
    clientId: ownerMatches ? clientId : '',
    setClientId: (value: string) => {
      setClientId(value);
      setValidationError(null);
    },
    clientSecret: ownerMatches ? clientSecret : '',
    setClientSecret: (value: string) => {
      setClientSecret(value);
      setValidationError(null);
    },
    ownerUserId: ownerMatches ? ownerUserId : '',
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
