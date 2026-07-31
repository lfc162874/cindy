// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDingTalkBot } from '../useDingTalkBot';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

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
      async (payload: { clientId: string; clientSecret: string; ownerUserId: string }) => ({
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
});
