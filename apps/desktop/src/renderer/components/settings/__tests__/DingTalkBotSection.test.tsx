// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DingTalkBotSection } from '../DingTalkBotSection';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  reconnect: vi.fn(),
  clear: vi.fn(),
  save: vi.fn(),
  setClientId: vi.fn(),
  setClientSecret: vi.fn(),
  setOwnerUserId: vi.fn(),
  bot: {
    state: {
      status: { kind: 'idle' },
      clientId: null,
      hasSecret: false,
      ownerUserId: null,
    } as DingTalkBotState,
    clientId: '',
    clientSecret: '',
    ownerUserId: '',
    validationError: null as string | null,
    busy: null as 'save' | 'reconnect' | 'clear' | null,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@/hooks/useDingTalkBot', () => ({
  dingTalkConnectionErrorKey: (reason: string) =>
    reason === 'DINGTALK_CONNECT_TIMEOUT'
      ? 'settings.dingtalkBot.connectionErrors.timeout'
      : 'settings.dingtalkBot.connectionError',
  useDingTalkBot: () => ({
    ...mocks.bot,
    reconnect: mocks.reconnect,
    clear: mocks.clear,
    save: mocks.save,
    setClientId: mocks.setClientId,
    setClientSecret: mocks.setClientSecret,
    setOwnerUserId: mocks.setOwnerUserId,
  }),
}));

vi.mock('../ImDefaultSettingsSection', () => ({
  ImDefaultSettingsSection: () => <div data-testid="defaults" />,
}));

vi.mock('../ImChannelSettingsCard', () => ({
  useImChannelSettingsSummary: () => [null, vi.fn()],
  ImChannelSettingsCard: ({
    title,
    status,
    children,
  }: {
    title: string;
    status: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {status}
      {children}
    </section>
  ),
}));

describe('DingTalkBotSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirm.mockResolvedValue(true);
    mocks.reconnect.mockResolvedValue(undefined);
    mocks.clear.mockResolvedValue(undefined);
    mocks.save.mockResolvedValue(true);
    mocks.bot = {
      state: {
        status: { kind: 'idle' },
        clientId: null,
        hasSecret: false,
        ownerUserId: null,
      },
      clientId: '',
      clientSecret: '',
      ownerUserId: '',
      validationError: null,
      busy: null,
    };
  });

  it('shows saved config recovery actions after an automatic connection failure', () => {
    mocks.bot = {
      state: {
        status: { kind: 'error', reason: 'DINGTALK_CONNECT_TIMEOUT' },
        clientId: 'ding-client',
        hasSecret: true,
        ownerUserId: 'staff-1',
      },
      clientId: 'ding-client',
      clientSecret: '',
      ownerUserId: 'staff-1',
      validationError: null,
      busy: null,
    };

    render(<DingTalkBotSection expanded onToggle={vi.fn()} />);

    expect(
      (
        screen.getByRole('button', {
          name: 'settings.dingtalkBot.reconnect',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole('button', {
          name: 'settings.dingtalkBot.changeConfig',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe(
      'settings.dingtalkBot.connectionErrors.timeout',
    );
    expect(
      screen.queryByPlaceholderText('settings.dingtalkBot.clientSecretPlaceholder'),
    ).toBeNull();
  });

  it('keeps the saved config card visible while connecting and disables reconnect', () => {
    mocks.bot = {
      state: {
        status: { kind: 'connecting' },
        clientId: 'ding-client',
        hasSecret: true,
        ownerUserId: 'staff-1',
      },
      clientId: 'ding-client',
      clientSecret: '',
      ownerUserId: 'staff-1',
      validationError: null,
      busy: null,
    };

    render(<DingTalkBotSection expanded onToggle={vi.fn()} />);

    expect(screen.getByText('settings.dingtalkBot.savedConnecting')).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'settings.dingtalkBot.reconnect',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.queryByPlaceholderText('settings.dingtalkBot.clientSecretPlaceholder'),
    ).toBeNull();
  });

  it('enters and cancels config editing without restoring the saved secret', () => {
    mocks.bot = {
      state: {
        status: { kind: 'error', reason: 'DINGTALK_CONNECT_HTTP_401' },
        clientId: 'ding-client',
        hasSecret: true,
        ownerUserId: 'staff-1',
      },
      clientId: 'ding-client',
      clientSecret: '',
      ownerUserId: 'staff-1',
      validationError: null,
      busy: null,
    };

    render(<DingTalkBotSection expanded onToggle={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.dingtalkBot.changeConfig' }));

    expect(
      (
        screen.getByPlaceholderText(
          'settings.dingtalkBot.clientSecretPlaceholder',
        ) as HTMLInputElement
      ).value,
    ).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'settings.dingtalkBot.cancelChange' }));

    expect(mocks.setClientId).toHaveBeenLastCalledWith('ding-client');
    expect(mocks.setClientSecret).toHaveBeenLastCalledWith('');
    expect(mocks.setOwnerUserId).toHaveBeenLastCalledWith('staff-1');
    expect(
      screen.queryByPlaceholderText('settings.dingtalkBot.clientSecretPlaceholder'),
    ).toBeNull();
  });

  it('returns to the saved config card after replacement credentials are saved', async () => {
    mocks.bot = {
      state: {
        status: { kind: 'error', reason: 'DINGTALK_CONNECT_HTTP_401' },
        clientId: 'ding-client',
        hasSecret: true,
        ownerUserId: 'staff-1',
      },
      clientId: 'ding-client',
      clientSecret: '',
      ownerUserId: 'staff-1',
      validationError: null,
      busy: null,
    };

    const view = render(<DingTalkBotSection expanded onToggle={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.dingtalkBot.changeConfig' }));
    mocks.bot.clientSecret = 'replacement-secret';
    view.rerender(<DingTalkBotSection expanded onToggle={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.dingtalkBot.saveConfig' }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText('settings.dingtalkBot.clientSecretPlaceholder'),
      ).toBeNull(),
    );
  });

  it('keeps the first-time form when no secret is saved', () => {
    render(<DingTalkBotSection expanded onToggle={vi.fn()} />);

    expect(
      screen.getByPlaceholderText('settings.dingtalkBot.clientSecretPlaceholder'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.dingtalkBot.reconnect' })).toBeNull();
  });

  it('calls reconnect from the saved config card', () => {
    mocks.bot = {
      state: {
        status: { kind: 'error', reason: 'DINGTALK_CONNECT_TIMEOUT' },
        clientId: 'ding-client',
        hasSecret: true,
        ownerUserId: 'staff-1',
      },
      clientId: 'ding-client',
      clientSecret: '',
      ownerUserId: 'staff-1',
      validationError: null,
      busy: null,
    };

    render(<DingTalkBotSection expanded onToggle={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.dingtalkBot.reconnect' }));

    expect(mocks.reconnect).toHaveBeenCalledTimes(1);
  });
});
