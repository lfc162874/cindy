import { Eye, EyeOff, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { cn } from '@/lib/utils';
import { dingTalkConnectionErrorKey, useDingTalkBot } from '@/hooks/useDingTalkBot';
import { ImChannelSettingsCard, useImChannelSettingsSummary } from './ImChannelSettingsCard';
import { ImDefaultSettingsSection } from './ImDefaultSettingsSection';

const DEVELOPER_PORTAL_URL = 'https://open-dev.dingtalk.com/';

const statusKey: Record<DingTalkBotTransportStatus['kind'], string> = {
  idle: 'settings.dingtalkBot.status.needsConfig',
  connecting: 'settings.dingtalkBot.status.connecting',
  connected: 'settings.dingtalkBot.status.connected',
  conflict: 'settings.dingtalkBot.status.error',
  error: 'settings.dingtalkBot.status.error',
};

function statusColor(status: DingTalkBotTransportStatus): string {
  if (status.kind === 'connected') return 'var(--settings-badge-connected)';
  if (status.kind === 'error' || status.kind === 'conflict') return 'var(--settings-badge-error)';
  if (status.kind === 'connecting') return 'var(--settings-badge-saved)';
  return 'var(--settings-badge-needs-config)';
}

export function DingTalkBotSection({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const bot = useDingTalkBot();
  const { confirm } = useConfirmDialog();
  const [showSecret, setShowSecret] = useState(false);
  const [routeSummary, setRouteSummary] = useImChannelSettingsSummary('dingtalk');
  const connected = bot.state.status.kind === 'connected';
  const handleClear = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.dingtalkBot.clearConfirm.title'),
      description: t('settings.dingtalkBot.clearConfirm.description'),
      confirmText: t('settings.dingtalkBot.clearConfirm.confirm'),
      cancelText: t('settings.dingtalkBot.clearConfirm.cancel'),
    });
    if (confirmed) await bot.clear();
  }, [bot, confirm, t]);

  return (
    <ImChannelSettingsCard
      id="personal-im-dingtalk"
      title={t('settings.dingtalkBot.title')}
      description={t('settings.dingtalkBot.description')}
      routeSummary={
        routeSummary
          ? `${t(`settings.imBot.defaults.agents.${routeSummary.agentKind}`)} · ${routeSummary.model}`
          : null
      }
      expanded={expanded}
      onToggle={onToggle}
      status={
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] px-2.5 py-1 text-11 font-medium"
          style={{ color: statusColor(bot.state.status) }}
          role="status"
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: statusColor(bot.state.status) }}
          />
          {t(statusKey[bot.state.status.kind])}
        </span>
      }
    >
      <ImDefaultSettingsSection channel="dingtalk" embedded onSummaryChange={setRouteSummary} />
      <div className="h-px w-full bg-[var(--border-default)]" />

      {connected ? (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] p-4">
          <div className="text-13 font-medium text-[var(--text-primary)]">
            {t('settings.dingtalkBot.connectedTitle')}
          </div>
          <div className="text-12 leading-5 text-[var(--text-secondary)]">
            Client ID · {bot.state.clientId}
            <br />
            {t('settings.dingtalkBot.ownerLabel')} ·{' '}
            {bot.state.ownerUserId ?? t('settings.dingtalkBot.ownerWaiting')}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void bot.reconnect()}
              disabled={bot.busy !== null}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-default)] px-4 text-12 text-[var(--text-primary)] disabled:opacity-50"
            >
              {bot.busy === 'reconnect' ? (
                // Spinner rotation on HTML wrapper per DESIGN.md §14.4; SVG stays static.
                <span className="inline-flex animate-spinner motion-reduce:animate-none"><Loader2 size={14} /></span>
              ) : (
                <RefreshCw size={14} />
              )}
              {t('settings.dingtalkBot.reconnect')}
            </button>
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={bot.busy !== null}
              aria-label={t('settings.dingtalkBot.clear')}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--settings-trash-icon)] hover:text-[var(--settings-trash-icon-hover)] disabled:opacity-50"
            >
              <Trash2 size={17} />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="text-12 font-medium text-[var(--settings-section-desc)]">
            Client ID
          </label>
          <input
            value={bot.clientId}
            onChange={(event) => bot.setClientId(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('settings.dingtalkBot.clientIdPlaceholder')}
            className="h-[42px] w-full rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-[14px] text-13 text-[var(--settings-input-text)] outline-none placeholder:text-[var(--settings-input-placeholder)] focus:border-[var(--settings-input-border-focus)]"
          />
          <label className="text-12 font-medium text-[var(--settings-section-desc)]">
            Client Secret
          </label>
          <div className="relative">
            <input
              type={showSecret ? 'text' : 'password'}
              value={bot.clientSecret}
              onChange={(event) => bot.setClientSecret(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('settings.dingtalkBot.clientSecretPlaceholder')}
              className="h-[42px] w-full rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] pl-[14px] pr-10 text-13 text-[var(--settings-input-text)] outline-none placeholder:text-[var(--settings-input-placeholder)] focus:border-[var(--settings-input-border-focus)]"
            />
            <button
              type="button"
              onClick={() => setShowSecret((value) => !value)}
              aria-label={t(
                showSecret ? 'settings.dingtalkBot.hideSecret' : 'settings.dingtalkBot.showSecret',
              )}
              className="absolute right-[14px] top-1/2 -translate-y-1/2 text-[var(--settings-eye-icon)] hover:text-[var(--settings-eye-icon-hover)]"
            >
              {showSecret ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <label className="text-12 font-medium text-[var(--settings-section-desc)]">
            {t('settings.dingtalkBot.ownerUserIdLabel')}
          </label>
          <input
            value={bot.ownerUserId}
            onChange={(event) => bot.setOwnerUserId(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('settings.dingtalkBot.ownerUserIdPlaceholder')}
            className="h-[42px] w-full rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-[14px] text-13 text-[var(--settings-input-text)] outline-none placeholder:text-[var(--settings-input-placeholder)] focus:border-[var(--settings-input-border-focus)]"
          />
          {bot.validationError ? (
            <p className="text-12 text-[var(--settings-error-text)]" role="alert">
              {bot.validationError}
            </p>
          ) : bot.state.status.kind === 'error' ? (
            <p className="text-12 text-[var(--settings-error-text)]" role="alert">
              {t(dingTalkConnectionErrorKey(bot.state.status.reason))}
            </p>
          ) : (
            <p className="text-12 leading-5 text-[var(--settings-source-meta)]">
              {t('settings.dingtalkBot.formHint')}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => window.electronAPI.openExternal?.(DEVELOPER_PORTAL_URL)}
              className="text-12 text-[var(--settings-source-link)] hover:underline"
            >
              {t('settings.dingtalkBot.openConsole')}
            </button>
            <div className="flex items-center gap-2">
              {bot.state.hasSecret && (
                <button
                  type="button"
                  onClick={() => void handleClear()}
                  disabled={bot.busy !== null}
                  aria-label={t('settings.dingtalkBot.clear')}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--settings-trash-icon)] hover:text-[var(--settings-trash-icon-hover)] disabled:opacity-50"
                >
                  <Trash2 size={17} />
                </button>
              )}
              <button
                type="button"
                onClick={() => void bot.save()}
                disabled={
                  !bot.clientId.trim() ||
                  !bot.clientSecret.trim() ||
                  !bot.ownerUserId.trim() ||
                  bot.busy !== null
                }
                className={cn(
                  'inline-flex h-9 items-center gap-2 rounded-full border border-[var(--settings-btn-primary-border)] bg-[var(--settings-btn-primary-bg)] px-5 text-12 font-medium text-[var(--settings-btn-primary-text)] hover:bg-[var(--settings-btn-primary-hover-bg)]',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                {bot.busy === 'save' && (
                  // Spinner rotation on HTML wrapper per DESIGN.md §14.4; SVG stays static.
                  <span className="inline-flex animate-spinner motion-reduce:animate-none"><Loader2 size={14} /></span>
                )}
                {t('settings.dingtalkBot.connect')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ImChannelSettingsCard>
  );
}
