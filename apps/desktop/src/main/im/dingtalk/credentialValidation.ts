/**
 * DingTalk 的 Client ID 与 Owner Staff ID 会参与会话标识和工作目录拼接。
 * 这里先限制为单一路径安全字符集，避免 Renderer 通过 IPC 注入路径分隔符、
 * 点段或控制字符；Client Secret 不会进入这些路径，因此继续只校验长度。
 */
const SAFE_DINGTALK_ID = /^[A-Za-z0-9_-]+$/;

export function isSafeDingTalkId(value: string): boolean {
  return SAFE_DINGTALK_ID.test(value);
}
