/**
 * 飞书 IM 消息操作工具集
 *
 * - feishu_im_message_reaction: 给消息添加表情回复
 * - feishu_im_message_recall:   撤回消息
 *
 * 飞书 API:
 *   - 表情回复: POST   /open-apis/im/v1/messages/:message_id/reactions
 *   - 撤回消息: DELETE /open-apis/im/v1/messages/:message_id
 * 凭证: tenant_access_token
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
export declare function registerFeishuImMessageReactionTool(api: OpenClawPluginApi): void;
export declare function registerFeishuImMessageRecallTool(api: OpenClawPluginApi): void;
//# sourceMappingURL=message-ops.d.ts.map