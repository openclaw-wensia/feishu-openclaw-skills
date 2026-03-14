/**
 * Message fetching for the Feishu/Lark channel plugin.
 */
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
/**
 * Normalised information about a Feishu message, returned by
 * {@link getMessageFeishu}.
 */
export type FeishuMessageInfo = {
    /** Unique Feishu message ID. */
    messageId: string;
    /** Chat ID where the message lives. */
    chatId: string;
    /** Open ID of the sender (if available). */
    senderId?: string;
    /** Display name of the sender (resolved from user-name cache). */
    senderName?: string;
    /** The parsed text / content of the message. */
    content: string;
    /** Feishu content type indicator (text, post, image, interactive, ...). */
    contentType: string;
    /** Unix-millisecond timestamp of when the message was created. */
    createTime?: number;
};
/**
 * Retrieve a single message by its ID from the Feishu IM API.
 *
 * Returns a normalised {@link FeishuMessageInfo} object, or `null` if the
 * message cannot be found or the API returns an error.
 *
 * @param params.cfg       - Plugin configuration with Feishu credentials.
 * @param params.messageId - The message ID to fetch.
 * @param params.accountId - Optional account identifier for multi-account setups.
 */
export declare function getMessageFeishu(params: {
    cfg: ClawdbotConfig;
    messageId: string;
    accountId?: string;
    /** When true, merge_forward content is recursively expanded via API. */
    expandForward?: boolean;
}): Promise<FeishuMessageInfo | null>;
//# sourceMappingURL=fetch.d.ts.map