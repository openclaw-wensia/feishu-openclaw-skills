/**
 * Reply dispatcher factory for the Feishu/Lark channel plugin.
 *
 * Creates a reply dispatcher that integrates typing-indicator reactions,
 * markdown card rendering, and text chunking to deliver
 * agent responses back to the user.
 */
import { type ClawdbotConfig, type RuntimeEnv } from "openclaw/plugin-sdk";
export type CreateFeishuReplyDispatcherParams = {
    cfg: ClawdbotConfig;
    agentId: string;
    runtime: RuntimeEnv;
    chatId: string;
    replyToMessageId?: string;
    /** Account ID for multi-account support. */
    accountId?: string;
    /** Chat type for scene-aware reply mode selection. */
    chatType?: "p2p" | "group";
};
export declare function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams): any;
//# sourceMappingURL=reply-dispatcher.d.ts.map