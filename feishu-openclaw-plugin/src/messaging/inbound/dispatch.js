/**
 * Agent dispatch for inbound Feishu messages.
 *
 * Builds the agent envelope, prepends chat history context, and
 * dispatches through the appropriate reply path (system command
 * vs. normal streaming/static flow).
 */
import { buildPendingHistoryContextFromMap, clearHistoryEntriesIfEnabled, } from "openclaw/plugin-sdk";
import { LarkClient } from "../../core/lark-client.js";
import { trace } from "../../core/trace.js";
import { createFeishuReplyDispatcher } from "../../card/reply-dispatcher.js";
import { sendMessageFeishu } from "../outbound/send.js";
import { mentionedBot, nonBotMentions } from "./mention.js";
import { buildQueueKey, registerActiveDispatcher, unregisterActiveDispatcher, } from "../../channel/chat-queue.js";
import { isLikelyAbortText } from "../../channel/abort-detect.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Provide a safe RuntimeEnv fallback when the caller did not supply one.
 * Replaces the previous unsafe `runtime as RuntimeEnv` casts.
 */
function ensureRuntime(runtime) {
    if (runtime)
        return runtime;
    return {
        log: console.log,
        error: console.error,
        exit: (code) => process.exit(code),
    };
}
/**
 * Derive all shared values needed by downstream helpers:
 * logging, addressing, route resolution, and system event emission.
 */
function buildDispatchContext(params) {
    const { ctx, account, cfg } = params;
    const runtime = ensureRuntime(params.runtime);
    const log = runtime.log;
    const error = runtime.error;
    const isGroup = ctx.chatType === "group";
    const core = LarkClient.runtime;
    const feishuFrom = `feishu:${ctx.senderId}`;
    const feishuTo = isGroup
        ? `chat:${ctx.chatId}`
        : `user:${ctx.senderId}`;
    const envelopeFrom = isGroup
        ? `${ctx.chatId}:${ctx.senderId}`
        : ctx.senderId;
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    // ---- Route resolution ----
    const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "feishu",
        accountId: account.accountId,
        peer: {
            kind: isGroup ? "group" : "direct",
            id: isGroup ? ctx.chatId : ctx.senderId,
        },
    });
    // ---- System event ----
    const sender = ctx.senderName
        ? `${ctx.senderName} (${ctx.senderId})`
        : ctx.senderId;
    const location = isGroup ? `group ${ctx.chatId}` : "DM";
    const tags = [];
    tags.push(`msg:${ctx.messageId}`);
    if (ctx.parentId)
        tags.push(`reply_to:${ctx.parentId}`);
    if (ctx.contentType !== "text")
        tags.push(ctx.contentType);
    if (ctx.mentions.some((m) => m.isBot))
        tags.push("@bot");
    if (ctx.resources.length > 0) {
        tags.push(`${ctx.resources.length} attachment(s)`);
    }
    const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
    core.system.enqueueSystemEvent(`Feishu[${account.accountId}] ${location} | ${sender}${tagStr}`, {
        sessionKey: route.sessionKey,
        contextKey: `feishu:message:${ctx.chatId}:${ctx.messageId}`,
    });
    return {
        ctx,
        cfg,
        account,
        runtime,
        log,
        error,
        core,
        isGroup,
        feishuFrom,
        feishuTo,
        envelopeFrom,
        envelopeOptions,
        route,
        commandAuthorized: params.commandAuthorized,
    };
}
/**
 * Build a `[System: ...]` mention annotation when the message @-mentions
 * non-bot users.  Returns `undefined` when there are no user mentions.
 *
 * Sender identity / chat metadata are handled by the SDK's own
 * `buildInboundUserContextPrefix` (via SenderId, SenderName, ReplyToBody,
 * InboundHistory, etc.), so we only inject the mention data that the SDK
 * does not natively support.
 */
function buildMentionAnnotation(ctx) {
    const mentions = nonBotMentions(ctx);
    if (mentions.length === 0)
        return undefined;
    const mentionDetails = mentions
        .map((t) => `${t.name} (open_id: ${t.openId})`)
        .join(", ");
    return `[System: This message @mentions the following users: ${mentionDetails}. Use these open_ids when performing actions involving these users.]`;
}
/**
 * Pure function: build the annotated message body with optional quote,
 * speaker prefix, and mention annotation (for the envelope Body).
 *
 * Note: message_id and reply_to are now conveyed via system-event tags
 * (msg:om_xxx, reply_to:om_yyy) instead of inline annotations, keeping
 * the body cleaner and avoiding misleading heuristics for non-text
 * message types (merge_forward, interactive cards, etc.).
 */
function buildMessageBody(ctx, quotedContent) {
    let messageBody = ctx.content;
    if (quotedContent) {
        messageBody = `[Replying to: "${quotedContent}"]\n\n${ctx.content}`;
    }
    const speaker = ctx.senderName ?? ctx.senderId;
    messageBody = `${speaker}: ${messageBody}`;
    const mentionAnnotation = buildMentionAnnotation(ctx);
    if (mentionAnnotation) {
        messageBody += `\n\n${mentionAnnotation}`;
    }
    return messageBody;
}
/**
 * Build the BodyForAgent value: the clean message content plus an
 * optional mention annotation.
 *
 * SDK >= 2026.2.10 changed the BodyForAgent fallback chain from
 * `BodyForAgent ?? Body` to `BodyForAgent ?? CommandBody ?? RawBody ?? Body`,
 * so annotations embedded only in Body never reach the AI.  Setting
 * BodyForAgent explicitly ensures the mention annotation survives.
 *
 * Sender identity, reply context, and chat history are NOT duplicated
 * here — they are injected by the SDK's `buildInboundUserContextPrefix`
 * via the standard fields (SenderId, SenderName, ReplyToBody,
 * InboundHistory) that we pass in buildInboundPayload.
 *
 * Note: media file paths are substituted into `ctx.content` upstream
 * (handler.ts → substituteMediaPaths) before this function is called.
 * The SDK's `detectAndLoadPromptImages` will discover image paths from
 * the text and inject them as multimodal content blocks.
 */
function buildBodyForAgent(ctx) {
    const mentionAnnotation = buildMentionAnnotation(ctx);
    if (mentionAnnotation) {
        return `${ctx.content}\n\n${mentionAnnotation}`;
    }
    return ctx.content;
}
/**
 * Unified call to `finalizeInboundContext`, eliminating the duplicated
 * field-mapping between permission notification and main message paths.
 */
function buildInboundPayload(dc, opts) {
    return dc.core.channel.reply.finalizeInboundContext({
        // extraFields first — fixed fields below always take precedence
        ...opts.extraFields,
        Body: opts.body,
        BodyForAgent: opts.bodyForAgent,
        RawBody: opts.rawBody,
        CommandBody: opts.commandBody,
        From: dc.feishuFrom,
        To: dc.feishuTo,
        SessionKey: dc.route.sessionKey,
        AccountId: dc.route.accountId,
        ChatType: dc.isGroup ? "group" : "direct",
        GroupSubject: dc.isGroup ? dc.ctx.chatId : undefined,
        SenderName: opts.senderName,
        SenderId: opts.senderId,
        Provider: "feishu",
        Surface: "feishu",
        MessageSid: opts.messageSid,
        ReplyToBody: opts.replyToBody,
        InboundHistory: opts.inboundHistory,
        Timestamp: Date.now(),
        WasMentioned: opts.wasMentioned,
        CommandAuthorized: dc.commandAuthorized,
        OriginatingChannel: "feishu",
        OriginatingTo: dc.feishuTo,
    });
}
/**
 * Format the agent envelope and prepend group chat history if applicable.
 * Returns the combined body and the history key (undefined for DMs).
 */
function buildEnvelopeWithHistory(dc, messageBody, chatHistories, historyLimit) {
    const body = dc.core.channel.reply.formatAgentEnvelope({
        channel: "Feishu",
        from: dc.envelopeFrom,
        timestamp: new Date(),
        envelope: dc.envelopeOptions,
        body: messageBody,
    });
    let combinedBody = body;
    const historyKey = dc.isGroup ? dc.ctx.chatId : undefined;
    if (dc.isGroup && historyKey && chatHistories) {
        combinedBody = buildPendingHistoryContextFromMap({
            historyMap: chatHistories,
            historyKey,
            limit: historyLimit,
            currentMessage: combinedBody,
            formatEntry: (entry) => dc.core.channel.reply.formatAgentEnvelope({
                channel: "Feishu",
                from: `${dc.ctx.chatId}:${entry.sender}`,
                timestamp: entry.timestamp,
                body: entry.body,
                envelope: dc.envelopeOptions,
            }),
        });
    }
    return { combinedBody, historyKey };
}
/**
 * Dispatch a permission-error notification to the agent so it can
 * inform the user about the missing Feishu API scope.
 */
async function dispatchPermissionNotification(dc, permissionError, replyToMessageId) {
    const grantUrl = permissionError.grantUrl ?? "";
    const permissionNotifyBody = `[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: ${grantUrl}]`;
    const permBody = dc.core.channel.reply.formatAgentEnvelope({
        channel: "Feishu",
        from: dc.envelopeFrom,
        timestamp: new Date(),
        envelope: dc.envelopeOptions,
        body: permissionNotifyBody,
    });
    const permCtx = buildInboundPayload(dc, {
        body: permBody,
        bodyForAgent: permissionNotifyBody,
        rawBody: permissionNotifyBody,
        commandBody: permissionNotifyBody,
        senderName: "system",
        senderId: "system",
        messageSid: `${dc.ctx.messageId}:permission-error`,
        wasMentioned: false,
    });
    const { dispatcher: permDispatcher, replyOptions: permReplyOptions, markDispatchIdle: markPermIdle, markFullyComplete: markPermComplete, } = createFeishuReplyDispatcher({
        cfg: dc.cfg,
        agentId: dc.route.agentId,
        runtime: dc.runtime,
        chatId: dc.ctx.chatId,
        replyToMessageId: replyToMessageId ?? dc.ctx.messageId,
        accountId: dc.account.accountId,
        chatType: dc.ctx.chatType,
    });
    dc.log(`feishu[${dc.account.accountId}]: dispatching permission error notification to agent`);
    await dc.core.channel.reply.dispatchReplyFromConfig({
        ctx: permCtx,
        cfg: dc.cfg,
        dispatcher: permDispatcher,
        replyOptions: permReplyOptions,
    });
    markPermComplete();
    markPermIdle();
}
/**
 * Dispatch a system command (/help, /reset, etc.) via plain-text delivery.
 * No streaming card, no "Processing..." state.
 *
 * When `suppressReply` is true the agent still runs (e.g. reads workspace
 * files) but its text output is not forwarded to Feishu.  This is used for
 * bare /new and /reset commands: the SDK already sends a "✅ New session
 * started" notice via its own route, so the AI greeting would be redundant.
 */
async function dispatchSystemCommand(dc, ctxPayload, suppressReply = false) {
    let delivered = false;
    dc.log(`feishu[${dc.account.accountId}]: detected system command, using plain-text dispatch${suppressReply ? " (reply suppressed)" : ""}`);
    trace.info(`system command detected, plain-text dispatch${suppressReply ? ", reply suppressed" : ""}`);
    await dc.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: dc.cfg,
        dispatcherOptions: {
            deliver: async (payload) => {
                if (suppressReply)
                    return;
                const text = payload.text?.trim() ?? "";
                if (!text)
                    return;
                await sendMessageFeishu({
                    cfg: dc.cfg,
                    to: dc.ctx.chatId,
                    text,
                    replyToMessageId: dc.ctx.messageId,
                    accountId: dc.account.accountId,
                });
                delivered = true;
            },
            onSkip: (_payload, info) => {
                if (info.reason !== "silent") {
                    dc.log(`feishu[${dc.account.accountId}]: command reply skipped (reason=${info.reason})`);
                }
            },
            onError: (err, info) => {
                dc.error(`feishu[${dc.account.accountId}]: command ${info.kind} reply failed: ${String(err)}`);
            },
        },
        replyOptions: {},
    });
    dc.log(`feishu[${dc.account.accountId}]: system command dispatched (delivered=${delivered})`);
    trace.info(`system command dispatched (delivered=${delivered}, elapsed=${trace.elapsed()}ms)`);
}
/**
 * Dispatch a normal (non-command) message via the streaming card flow.
 * Cleans up consumed history entries after dispatch completes.
 *
 * Note: history cleanup is intentionally placed here and NOT in the
 * system-command path — command handlers don't consume history context,
 * so the entries should be preserved for the next normal message.
 */
async function dispatchNormalMessage(dc, ctxPayload, chatHistories, historyKey, historyLimit, replyToMessageId, skillFilter) {
    // Abort messages should never create streaming cards — dispatch via the
    // plain-text system-command path so the SDK's abort handler can reply
    // without touching CardKit.
    if (isLikelyAbortText(dc.ctx.content?.trim() ?? "")) {
        dc.log(`feishu[${dc.account.accountId}]: abort message detected, using plain-text dispatch`);
        trace.info("abort message detected, using plain-text dispatch");
        await dispatchSystemCommand(dc, ctxPayload);
        return;
    }
    const { dispatcher, replyOptions, markDispatchIdle, markFullyComplete, abortCard } = createFeishuReplyDispatcher({
        cfg: dc.cfg,
        agentId: dc.route.agentId,
        runtime: dc.runtime,
        chatId: dc.ctx.chatId,
        replyToMessageId: replyToMessageId ?? dc.ctx.messageId,
        accountId: dc.account.accountId,
        chatType: dc.ctx.chatType,
    });
    // Create an AbortController so the abort fast-path can cancel the
    // underlying LLM request (not just the streaming card UI).
    const abortController = new AbortController();
    // Register the active dispatcher so the monitor abort fast-path can
    // terminate the streaming card before this task completes.
    const queueKey = buildQueueKey(dc.account.accountId, dc.ctx.chatId);
    registerActiveDispatcher(queueKey, { abortCard, abortController });
    dc.log(`feishu[${dc.account.accountId}]: dispatching to agent (session=${dc.route.sessionKey})`);
    trace.info(`dispatching to agent (session=${dc.route.sessionKey})`);
    try {
        const { queuedFinal, counts } = await dc.core.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg: dc.cfg,
            dispatcher,
            replyOptions: {
                ...replyOptions,
                abortSignal: abortController.signal,
                ...(skillFilter ? { skillFilter } : {}),
            },
        });
        markFullyComplete();
        markDispatchIdle();
        // Clean up consumed history entries
        if (dc.isGroup && historyKey && chatHistories) {
            clearHistoryEntriesIfEnabled({
                historyMap: chatHistories,
                historyKey,
                limit: historyLimit,
            });
        }
        dc.log(`feishu[${dc.account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`);
        trace.info(`dispatch complete (replies=${counts.final}, elapsed=${trace.elapsed()}ms)`);
    }
    finally {
        unregisterActiveDispatcher(queueKey);
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function dispatchToAgent(params) {
    // 1. Derive shared context (including route resolution + system event)
    const dc = buildDispatchContext(params);
    // 2. Build annotated message body
    const messageBody = buildMessageBody(params.ctx, params.quotedContent);
    // 3. Permission-error notification (optional side-effect).
    //    Isolated so a failure here does not block the main message dispatch.
    if (params.permissionError) {
        try {
            await dispatchPermissionNotification(dc, params.permissionError, params.replyToMessageId);
        }
        catch (err) {
            dc.error(`feishu[${dc.account.accountId}]: permission notification failed, continuing: ${String(err)}`);
        }
    }
    // 4. Build main envelope (with group chat history)
    const { combinedBody, historyKey } = buildEnvelopeWithHistory(dc, messageBody, params.chatHistories, params.historyLimit);
    // 5. Build BodyForAgent with mention annotation (if any).
    //    SDK >= 2026.2.10 no longer falls back to Body for BodyForAgent,
    //    so we must set it explicitly to preserve the annotation.
    const bodyForAgent = buildBodyForAgent(params.ctx);
    // 6. Build InboundHistory for SDK metadata injection (>= 2026.2.10).
    //    The SDK's buildInboundUserContextPrefix renders these as structured
    //    JSON blocks; earlier SDK versions simply ignore unknown fields.
    const inboundHistory = dc.isGroup && params.chatHistories && params.historyLimit > 0
        ? (params.chatHistories.get(dc.ctx.chatId) ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp ?? Date.now(),
        }))
        : undefined;
    // 7. Build inbound context payload
    const isBareNewOrReset = /^\/(?:new|reset)\s*$/i.test((params.ctx.content ?? "").trim());
    const groupSystemPrompt = dc.isGroup
        ? params.groupConfig?.systemPrompt?.trim()
            || params.defaultGroupConfig?.systemPrompt?.trim()
            || undefined
        : undefined;
    const ctxPayload = buildInboundPayload(dc, {
        body: combinedBody,
        bodyForAgent,
        rawBody: params.ctx.content,
        commandBody: params.ctx.content,
        senderName: params.ctx.senderName ?? params.ctx.senderId,
        senderId: params.ctx.senderId,
        messageSid: params.ctx.messageId,
        wasMentioned: mentionedBot(params.ctx),
        replyToBody: params.quotedContent,
        inboundHistory,
        extraFields: {
            ...params.mediaPayload,
            ...(groupSystemPrompt ? { GroupSystemPrompt: groupSystemPrompt } : {}),
        },
    });
    // 8. Dispatch: system command vs. normal message
    const isCommand = dc.core.channel.commands.isControlCommandMessage(params.ctx.content, params.cfg);
    // Resolve per-group skill filter (per-group > default "*")
    const skillFilter = dc.isGroup
        ? params.groupConfig?.skills ?? params.defaultGroupConfig?.skills
        : undefined;
    if (isCommand) {
        await dispatchSystemCommand(dc, ctxPayload, isBareNewOrReset);
    }
    else {
        // Normal message dispatch; history cleanup happens inside.
        // System commands intentionally skip history cleanup — command handlers
        // don't consume history context, so entries are preserved for the next
        // normal message.
        await dispatchNormalMessage(dc, ctxPayload, params.chatHistories, historyKey, params.historyLimit, params.replyToMessageId, skillFilter);
    }
}
//# sourceMappingURL=dispatch.js.map