import type { SupportedLocale } from '../../../shared/locale.js';

export interface DingTalkUiTextCatalog {
  slash: {
    newConversation: string;
    help: string;
    unknownCommand: string;
    remoteControlUnsupported: string;
    remoteControlRevoked: string;
  };
  agent: {
    completedNoText: string;
    runtimeError: string;
    sendInternalError: string;
    apiKeyMissing: string;
    providerFallback: string;
    authReason: {
      gatewayKey: string;
      providerKey: string;
      providerDisconnected: string;
      agentCredential: string;
    };
    authMissing: string;
    controlInProgress: string;
    credentialBusy: string;
    queuedNotice: string;
    stopDone: string;
    stopDoneWithQueue: string;
    stopIdle: string;
    scheduledTaskHeader: string;
    scheduledTaskHeaderNamed: string;
    unsupportedOnly: string;
    unsupportedNotice: string;
    listSeparator: string;
  };
}

/**
 * Main-process-only chat copy for the DingTalk transport. Renderer settings
 * continue to use common.json; these strings are selected at send time so a
 * runtime language change is reflected without reconnecting the bot.
 */
export const DINGTALK_UI_TEXT_CATALOG = {
  'zh-CN': {
    slash: {
      newConversation: '✅ 已开启新会话，当前上下文已清空。',
      help: `🤖 钉钉单聊目前支持：

/new         开个新会话（清掉当前上下文）
/help        查看帮助

任务运行中可以发送 \`!stop\`，中止当前任务并清空排队消息。

直接发文字就可以开始聊天。`,
      unknownCommand: '钉钉简单聊天暂不支持 `{{command}}`。目前可用：/new、/help、!stop',
      remoteControlUnsupported: '当前钉钉版本暂不支持远程接管。',
      remoteControlRevoked: '桌面端已收回远程接管。',
    },
    agent: {
      completedNoText: '✅ 任务已完成，但没有生成可发送的文字回复。',
      runtimeError: '❌ 任务执行失败：{{error}}',
      sendInternalError: '❌ 消息发送失败：{{error}}',
      apiKeyMissing: '⚠️ 当前没有可用的模型凭证。请在桌面端 Settings → 模型供应商中完成配置，然后发送 `/new`。',
      providerFallback: '当前供应商',
      authReason: {
        gatewayKey: '需要先配置 Cindy AI Key',
        providerKey: '还没有配置该供应商的 API Key',
        providerDisconnected: '未连接或连接已失效',
        agentCredential: '需要先登录 {{agentKind}} 凭证',
      },
      authMissing: '⚠️ 当前钉钉会话使用供应商「{{provider}}」（{{model}}），{{reason}}。\n请在桌面端 Settings → 模型供应商中修复认证；新会话配置变更后请发送 `/new`。',
      controlInProgress: '当前会话正在由桌面端接管，请先结束接管再从钉钉继续。',
      credentialBusy: '另一个任务正在更新共享模型凭证，本条消息会排队并在完成后自动继续。',
      queuedNotice: '⏳ 任务已排队，当前位置：{{position}}。',
      stopDone: '🛑 已中止当前任务。',
      stopDoneWithQueue: '🛑 已中止当前任务，并清空 {{count}} 条排队消息。',
      stopIdle: '当前没有正在运行或排队的任务。',
      scheduledTaskHeader: '⏰ 自动任务',
      scheduledTaskHeaderNamed: '⏰ 自动任务：{{name}}',
      unsupportedOnly: '🙏 钉钉简单聊天目前只支持文字消息。\n未处理：{{entries}}',
      unsupportedNotice: 'ℹ️ 钉钉简单聊天暂未处理：{{entries}}。其余文字继续处理。',
      listSeparator: '、',
    },
  },
  en: {
    slash: {
      newConversation: '✅ New conversation started. The previous context was cleared.',
      help: `🤖 DingTalk direct messages currently support:

/new         Start a new conversation (clear the current context)
/help        Show help

While a task is running, send \`!stop\` to stop it and clear queued messages.

Send any text message to start chatting.`,
      unknownCommand: 'DingTalk text chat does not support `{{command}}` yet. Available: /new, /help, !stop',
      remoteControlUnsupported: 'Remote takeover is not supported in the current DingTalk version.',
      remoteControlRevoked: 'Desktop has ended remote takeover.',
    },
    agent: {
      completedNoText: '✅ The task completed, but it produced no text reply to send.',
      runtimeError: '❌ Task failed: {{error}}',
      sendInternalError: '❌ Message delivery failed: {{error}}',
      apiKeyMissing: '⚠️ No usable model credentials are configured. Open Desktop Settings → Providers, then send `/new`.',
      providerFallback: 'current provider',
      authReason: {
        gatewayKey: 'a Cindy AI key must be configured first',
        providerKey: 'this provider does not have an API key configured',
        providerDisconnected: 'the provider is disconnected or its connection expired',
        agentCredential: '{{agentKind}} credentials are required',
      },
      authMissing: '⚠️ This DingTalk chat uses provider “{{provider}}” ({{model}}), but {{reason}}.\nFix authentication in Desktop Settings → Providers. After changing new-conversation settings, send `/new`.',
      controlInProgress: 'This conversation is currently controlled from Desktop. End takeover before continuing from DingTalk.',
      credentialBusy: 'Another task is updating shared model credentials. This message is queued and will continue automatically.',
      queuedNotice: '⏳ Task queued. Current position: {{position}}.',
      stopDone: '🛑 The current task was stopped.',
      stopDoneWithQueue: '🛑 The current task was stopped and {{count}} queued message(s) were cleared.',
      stopIdle: 'There is no running or queued task to stop.',
      scheduledTaskHeader: '⏰ Automation',
      scheduledTaskHeaderNamed: '⏰ Automation: {{name}}',
      unsupportedOnly: '🙏 DingTalk text chat currently supports text messages only.\nNot processed: {{entries}}',
      unsupportedNotice: 'ℹ️ DingTalk text chat did not process: {{entries}}. The remaining text will continue.',
      listSeparator: ', ',
    },
  },
  ja: {
    slash: {
      newConversation: '✅ 新しい会話を開始し、以前のコンテキストを消去しました。',
      help: `🤖 DingTalk のダイレクトメッセージで現在利用できる操作：

/new         新しい会話を開始（現在のコンテキストを消去）
/help        ヘルプを表示

タスクの実行中に \`!stop\` を送ると、タスクを停止して待機中のメッセージを消去します。

テキストを送信すると会話を開始できます。`,
      unknownCommand: 'DingTalk のテキストチャットでは `{{command}}` はまだ利用できません。利用可能：/new、/help、!stop',
      remoteControlUnsupported: '現在の DingTalk バージョンではリモート引き継ぎを利用できません。',
      remoteControlRevoked: 'デスクトップ側でリモート引き継ぎを終了しました。',
    },
    agent: {
      completedNoText: '✅ タスクは完了しましたが、送信できるテキスト応答は生成されませんでした。',
      runtimeError: '❌ タスクの実行に失敗しました：{{error}}',
      sendInternalError: '❌ メッセージの送信に失敗しました：{{error}}',
      apiKeyMissing: '⚠️ 利用可能なモデル認証情報がありません。デスクトップ版の Settings → モデルプロバイダーで設定し、`/new` を送信してください。',
      providerFallback: '現在のプロバイダー',
      authReason: {
        gatewayKey: '先に Cindy AI Key を設定する必要があります',
        providerKey: 'このプロバイダーの API Key が設定されていません',
        providerDisconnected: '未接続、または接続の有効期限が切れています',
        agentCredential: '{{agentKind}} の認証情報が必要です',
      },
      authMissing: '⚠️ この DingTalk 会話はプロバイダー「{{provider}}」（{{model}}）を使用していますが、{{reason}}。\nデスクトップ版の Settings → モデルプロバイダーで認証を修復してください。新規会話の設定を変更した後は `/new` を送信してください。',
      controlInProgress: 'この会話はデスクトップ側で操作中です。DingTalk から続ける前に引き継ぎを終了してください。',
      credentialBusy: '別のタスクが共有モデル認証情報を更新しています。このメッセージは待機し、完了後に自動で続行します。',
      queuedNotice: '⏳ タスクを待機列に追加しました。現在の位置：{{position}}。',
      stopDone: '🛑 現在のタスクを停止しました。',
      stopDoneWithQueue: '🛑 現在のタスクを停止し、待機中のメッセージ {{count}} 件を消去しました。',
      stopIdle: '実行中または待機中のタスクはありません。',
      scheduledTaskHeader: '⏰ 自動タスク',
      scheduledTaskHeaderNamed: '⏰ 自動タスク：{{name}}',
      unsupportedOnly: '🙏 DingTalk のテキストチャットは現在テキストメッセージのみ対応しています。\n未処理：{{entries}}',
      unsupportedNotice: 'ℹ️ DingTalk のテキストチャットでは次の内容を処理できませんでした：{{entries}}。残りのテキストは続けて処理します。',
      listSeparator: '、',
    },
  },
  ko: {
    slash: {
      newConversation: '✅ 새 대화를 시작하고 이전 컨텍스트를 지웠습니다.',
      help: `🤖 DingTalk 다이렉트 메시지에서 현재 사용할 수 있는 기능:

/new         새 대화 시작(현재 컨텍스트 지우기)
/help        도움말 보기

작업 실행 중 \`!stop\`을 보내면 작업을 중지하고 대기 중인 메시지를 지웁니다.

텍스트를 보내면 대화를 시작할 수 있습니다.`,
      unknownCommand: 'DingTalk 텍스트 채팅에서는 `{{command}}`을(를) 아직 지원하지 않습니다. 사용 가능: /new, /help, !stop',
      remoteControlUnsupported: '현재 DingTalk 버전에서는 원격 인계를 지원하지 않습니다.',
      remoteControlRevoked: '데스크톱에서 원격 인계를 종료했습니다.',
    },
    agent: {
      completedNoText: '✅ 작업이 완료되었지만 보낼 수 있는 텍스트 응답이 생성되지 않았습니다.',
      runtimeError: '❌ 작업 실행 실패: {{error}}',
      sendInternalError: '❌ 메시지 전송 실패: {{error}}',
      apiKeyMissing: '⚠️ 사용할 수 있는 모델 인증 정보가 없습니다. 데스크톱 Settings → 모델 공급자에서 설정한 뒤 `/new`를 보내세요.',
      providerFallback: '현재 공급자',
      authReason: {
        gatewayKey: '먼저 Cindy AI Key를 설정해야 합니다',
        providerKey: '이 공급자의 API Key가 설정되지 않았습니다',
        providerDisconnected: '연결되지 않았거나 연결이 만료되었습니다',
        agentCredential: '{{agentKind}} 인증 정보가 필요합니다',
      },
      authMissing: '⚠️ 이 DingTalk 대화는 공급자 “{{provider}}”({{model}})를 사용하지만 {{reason}}.\n데스크톱 Settings → 모델 공급자에서 인증을 복구하세요. 새 대화 설정을 바꾼 뒤에는 `/new`를 보내세요.',
      controlInProgress: '이 대화는 데스크톱에서 제어 중입니다. DingTalk에서 계속하기 전에 인계를 종료하세요.',
      credentialBusy: '다른 작업이 공유 모델 인증 정보를 업데이트하고 있습니다. 이 메시지는 대기열에 들어가며 완료 후 자동으로 계속됩니다.',
      queuedNotice: '⏳ 작업이 대기열에 추가되었습니다. 현재 위치: {{position}}.',
      stopDone: '🛑 현재 작업을 중지했습니다.',
      stopDoneWithQueue: '🛑 현재 작업을 중지하고 대기 중인 메시지 {{count}}개를 지웠습니다.',
      stopIdle: '실행 중이거나 대기 중인 작업이 없습니다.',
      scheduledTaskHeader: '⏰ 자동 작업',
      scheduledTaskHeaderNamed: '⏰ 자동 작업: {{name}}',
      unsupportedOnly: '🙏 DingTalk 텍스트 채팅은 현재 텍스트 메시지만 지원합니다.\n처리하지 못한 항목: {{entries}}',
      unsupportedNotice: 'ℹ️ DingTalk 텍스트 채팅에서 다음 항목을 처리하지 못했습니다: {{entries}}. 나머지 텍스트는 계속 처리합니다.',
      listSeparator: ', ',
    },
  },
} satisfies Record<SupportedLocale, DingTalkUiTextCatalog>;
