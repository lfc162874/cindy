import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupportedLocale } from '../../../../shared/locale.js';

const localeState = vi.hoisted(() => ({ locale: 'zh-CN' as SupportedLocale }));

vi.mock('../../../i18n', () => ({
  getResolvedMainLocale: () => localeState.locale,
}));

import { ui } from '../uiText';

function setLocale(locale: SupportedLocale): void {
  localeState.locale = locale;
}

describe('DingTalk localized chat copy', () => {
  beforeEach(() => setLocale('zh-CN'));

  it.each([
    ['zh-CN', '钉钉单聊目前支持'],
    ['en', 'DingTalk direct messages currently support'],
    ['ja', 'DingTalk のダイレクトメッセージ'],
    ['ko', 'DingTalk 다이렉트 메시지'],
  ] as const)('uses the %s catalog for help replies', (locale, expected) => {
    setLocale(locale);
    expect(ui.slash.help).toContain(expected);
  });

  it('resolves string getters after a runtime locale change', () => {
    setLocale('en');
    expect(ui.slash.new).toContain('New conversation');

    setLocale('ja');
    expect(ui.slash.new).toContain('新しい会話');
  });

  it('localizes dynamic auth and unsupported-message replies', () => {
    setLocale('en');
    expect(
      ui.agent.authMissing?.({
        agentKind: 'codex',
        model: 'gpt-test',
        providerId: 'provider-id',
        providerLabel: 'Provider',
        missing: 'provider-key',
      }),
    ).toContain('does not have an API key configured');
    expect(
      ui.agent.unsupportedOnly([{ type: 'image', label: 'image' }]),
    ).toContain('text messages only');

    setLocale('ko');
    expect(ui.agent.queuedNotice(2)).toContain('현재 위치: 2');
  });

  it('keeps placeholder replacement literal', () => {
    setLocale('en');
    expect(ui.agent.runtimeError('$& {{error}}')).toContain('$& {{error}}');
  });
});
