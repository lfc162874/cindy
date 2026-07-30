import type { ImUiTextPack } from '../shared/types';
import { ui as wechatUi } from '../wechat/uiText';

/**
 * DingTalk's first milestone is text-only. Card copy remains in the structural
 * contract but cannot be reached because the adapter disables rich commands.
 */
export const ui = {
  ...wechatUi,
  slash: {
    ...wechatUi.slash,
    help: `🤖 钉钉单聊目前支持：

/new         开个新会话（清掉当前上下文）
/help        查看帮助

任务运行中可以发送 \`!stop\`，中止当前任务并清空排队消息。

直接发文字就可以开始聊天。`,
    unknownCommand: (cmd: string) =>
      `钉钉简单聊天暂不支持 \`${cmd}\`。目前可用：/new、/help、!stop`,
    detachedBySlash: '当前钉钉版本暂不支持远程接管。',
    detachedByRevoke: 'desktop 已收回远程接管。',
    notAttached: '当前钉钉版本暂不支持远程接管。',
  },
  agent: {
    ...wechatUi.agent,
    authMissing: (details) => {
      const provider = details.providerLabel ?? details.providerId ?? '当前供应商';
      const reason =
        details.missing === 'gateway-key'
          ? '需要先配置 Cindy AI Key'
          : details.missing === 'provider-key'
            ? '还没有配置该供应商的 API Key'
            : details.missing === 'provider-disconnected'
              ? '未连接或连接已失效'
              : `需要先登录 ${details.agentKind} 凭证`;
      return `⚠️ 当前钉钉会话使用供应商「${provider}」（${details.model}），${reason}。\n请在 desktop 的 Settings → 模型供应商中修复认证；新会话配置变更后请发送 \`/new\`。`;
    },
    unsupportedOnly: (entries) =>
      `🙏 钉钉简单聊天目前只支持文字消息。\n未处理：${entries.map((entry) => entry.label).join('、')}`,
    unsupportedNotice: (entries) =>
      `ℹ️ 钉钉简单聊天暂未处理：${entries.map((entry) => entry.label).join('、')}。其余文字继续处理。`,
  },
} satisfies ImUiTextPack;
