// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDingTalkBot } from '../useDingTalkBot';

const authState = vi.hoisted(() => ({
  dataOwnerId: 'account-a' as string | null,
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    dataOwnerId: authState.dataOwnerId,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: toastMocks,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function installDingTalkApi() {
  const state: DingTalkBotState = {
    status: { kind: 'idle' },
    clientId: null,
    hasSecret: false,
    ownerUserId: null,
  };
  const api = {
    getState: vi.fn(async () => state),
    save: vi.fn(
      async (
        payload: { clientId: string; clientSecret: string; ownerUserId: string },
      ): Promise<DingTalkBotSaveResult> => ({
        ...state,
        status: { kind: 'connected', appId: payload.clientId } as DingTalkBotTransportStatus,
        clientId: payload.clientId,
        hasSecret: true,
        ownerUserId: payload.ownerUserId,
      }),
    ),
    reconnect: vi.fn(async () => state),
    clear: vi.fn(async () => state),
    onStateChange: vi.fn(() => () => {}),
  };
  (window as unknown as { electronAPI: { dingtalkBot: typeof api } }).electronAPI = {
    dingtalkBot: api,
  };
  return api;
}

describe('useDingTalkBot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.dataOwnerId = 'account-a';
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('requires an owner Staff ID before saving', async () => {
    installDingTalkApi();
    const { result } = renderHook(() => useDingTalkBot());

    await waitFor(() => expect(result.current.state.status.kind).toBe('idle'));
    act(() => {
      result.current.setClientId('ding-client');
      result.current.setClientSecret('client-secret');
    });

    await act(async () => {
      expect(await result.current.save()).toBe(false);
    });

    expect(result.current.validationError).toBe('logic.validation.dingtalkFieldsRequired');
  });

  it('sends the trimmed owner Staff ID with the app credentials', async () => {
    const api = installDingTalkApi();
    const { result } = renderHook(() => useDingTalkBot());

    await waitFor(() => expect(result.current.state.status.kind).toBe('idle'));
    act(() => {
      result.current.setClientId(' ding-client ');
      result.current.setClientSecret(' client-secret ');
      result.current.setOwnerUserId(' staff-1 ');
    });

    await act(async () => {
      expect(await result.current.save()).toBe(true);
    });

    expect(api.save).toHaveBeenCalledWith({
      clientId: 'ding-client',
      clientSecret: 'client-secret',
      ownerUserId: 'staff-1',
    });
    expect(result.current.state.ownerUserId).toBe('staff-1');
  });

  it('reports a failed replacement when the previous connection was restored', async () => {
    const api = installDingTalkApi();
    api.save.mockResolvedValueOnce({
      status: { kind: 'connected', appId: 'old-client' },
      clientId: 'old-client',
      hasSecret: true,
      ownerUserId: 'staff-old',
      saveErrorStatus: {
        kind: 'error',
        reason: 'DINGTALK_CONNECT_FAILED',
      },
    });
    const { result } = renderHook(() => useDingTalkBot());

    act(() => {
      result.current.setClientId('bad-client');
      result.current.setClientSecret('bad-secret');
      result.current.setOwnerUserId('staff-bad');
    });

    await act(async () => {
      expect(await result.current.save()).toBe(false);
    });

    expect(result.current.state).toEqual({
      status: { kind: 'connected', appId: 'old-client' },
      clientId: 'old-client',
      hasSecret: true,
      ownerUserId: 'staff-old',
    });
    expect(toastMocks.error).toHaveBeenCalledTimes(1);
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it('does not expose the previous account cache while the next account state is loading', async () => {
    const api = installDingTalkApi();
    api.getState.mockResolvedValueOnce({
      status: { kind: 'connected', appId: 'client-a' },
      clientId: 'client-a',
      hasSecret: true,
      ownerUserId: 'staff-a',
    });
    const accountA = renderHook(() => useDingTalkBot());

    await waitFor(() => expect(accountA.result.current.clientId).toBe('client-a'));
    accountA.unmount();

    authState.dataOwnerId = 'account-b';
    const accountBState = deferred<DingTalkBotState>();
    api.getState.mockImplementationOnce(() => accountBState.promise);
    const accountB = renderHook(() => useDingTalkBot());

    expect(accountB.result.current.state).toEqual({
      status: { kind: 'idle' },
      clientId: null,
      hasSecret: false,
      ownerUserId: null,
    });
    expect(accountB.result.current.clientId).toBe('');
    expect(accountB.result.current.ownerUserId).toBe('');

    accountBState.resolve({
      status: { kind: 'idle' },
      clientId: null,
      hasSecret: false,
      ownerUserId: null,
    });
    accountB.unmount();
  });

  it('ignores a previous account getState response that resolves after an owner switch', async () => {
    const api = installDingTalkApi();
    const accountAState = deferred<DingTalkBotState>();
    api.getState.mockImplementation(() => {
      if (authState.dataOwnerId === 'account-a') return accountAState.promise;
      return Promise.resolve({
        status: { kind: 'connected', appId: 'client-b' },
        clientId: 'client-b',
        hasSecret: true,
        ownerUserId: 'staff-b',
      });
    });
    const hook = renderHook(() => useDingTalkBot());

    authState.dataOwnerId = 'account-b';
    hook.rerender();

    await waitFor(() => expect(api.getState).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.clientId).toBe('client-b'));

    accountAState.resolve({
      status: { kind: 'connected', appId: 'client-a' },
      clientId: 'client-a',
      hasSecret: true,
      ownerUserId: 'staff-a',
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(hook.result.current.clientId).toBe('client-b');
    expect(hook.result.current.ownerUserId).toBe('staff-b');
  });
});
