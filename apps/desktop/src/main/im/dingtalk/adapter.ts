import fs from 'node:fs';

import type { DingTalkIM } from '@cindy/im';

import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { ui } from './uiText';

function ensureWorkingDir(clientId: string): string {
  const dir = ownerScopedImUserDataPath('im-working-dir', `dingtalk-${clientId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildDingTalkAdapter(
  dingtalkIm: DingTalkIM,
  config: ImOrchestratorConfig,
): ImChannelAdapter {
  return {
    channel: 'dingtalk',
    im: dingtalkIm,
    output: {
      kind: 'chunked-text',
      im: dingtalkIm,
      commitFinal: (output) => dingtalkIm.commitFinal(output),
    },
    config,
    ui,
    sessions: {
      source: 'dingtalk',
      sessionIdFor: (clientId, userId) => `dingtalk_${clientId}_${userId}`,
      defaultTitle: (userId) => `钉钉 · ${userId.slice(-6)}`,
      generatedTitlePrefix: '钉钉 · ',
      workspaceKind: 'dialogue',
      ensureWorkingDir,
      extraInsertColumns: (clientId, userId) => ({
        imBotContextId: clientId,
        imUserId: userId,
      }),
    },
    processingEmoji: '',
    supportsRichCommands: false,
    buildVendorOptions: (userId) => ({ source: 'dingtalk', dingtalkUserId: userId }),
  };
}
