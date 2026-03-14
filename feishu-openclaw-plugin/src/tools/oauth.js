/**
 * feishu_oauth tool — User OAuth authorisation management.
 *
 * Actions:
 *   - authorize : Initiate Device Flow, send QR card, poll for token.
 *   - status    : Check whether the current user has a valid UAT.
 *   - revoke    : Remove the current user's stored UAT.
 *
 * Security:
 *   - **Does not** accept a `user_open_id` parameter.  The target user is
 *     always the message sender, obtained from the TraceContext.
 *   - Token values are never included in the return payload (AI cannot see
 *     them).
 */
import { Type } from "@sinclair/typebox";
import QRCode from "qrcode";
import { getLarkAccount, } from "../core/accounts.js";
import { LarkClient } from "../core/lark-client.js";
import { getAppGrantedScopes } from "../core/app-scope-checker.js";
import { getTraceContext, withTrace, trace } from "../core/trace.js";
import { handleFeishuMessage } from "../messaging/inbound/handler.js";
import { formatLarkError } from "../core/api-error.js";
import { enqueueFeishuChatTask } from "../channel/chat-queue.js";
import { requestDeviceAuthorization, pollDeviceToken, } from "../core/device-flow.js";
import { getStoredToken, setStoredToken, tokenStatus, } from "../core/token-store.js";
import { revokeUAT } from "../core/uat-client.js";
import { uploadImageFeishu } from "../messaging/outbound/media.js";
import { createCardEntity, sendCardByCardId, updateCardKitCard, } from "../card/cardkit.js";
// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const FeishuOAuthSchema = Type.Object({
    action: Type.Union([
        // Type.Literal("authorize"),  // 已由 auto-auth 自动处理，不再对外暴露
        Type.Literal("revoke"),
    ], {
        description: "revoke: 撤销当前用户的授权",
    }),
}, {
    description: "飞书用户授权管理工具。" +
        "【注意】授权流程由系统自动发起，不要主动调用此工具触发授权！" +
        "此工具仅用于撤销授权（revoke）。" +
        "不需要传入 user_open_id，系统自动识别当前用户。"
});
const pendingFlows = new Map();
// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------
function buildAuthCard(params) {
    const { verificationUriComplete, expiresMin, scope, isBatchAuth, totalAppScopes, alreadyGranted, batchInfo, filteredScopes, appId, showBatchAuthHint } = params;
    const inAppUrl = toInAppWebUrl(verificationUriComplete);
    const multiUrl = {
        url: inAppUrl,
        pc_url: inAppUrl,
        android_url: inAppUrl,
        ios_url: inAppUrl,
    };
    // 将 scope 转成可读说明
    const scopeDesc = formatScopeDescription(scope, isBatchAuth, totalAppScopes, alreadyGranted, batchInfo, filteredScopes, appId);
    const elements = [
        // 淡黄色背景标题区
        // {
        //   tag: "column_set",
        //   flex_mode: "none",
        //   background_style: "light-yellow-bg",
        //   columns: [
        //     {
        //       tag: "column",
        //       width: "weighted",
        //       weight: 1,
        //       vertical_align: "center",
        //       padding: "8px 12px",
        //       elements: [
        //         {
        //           tag: "div",
        //           icon: {
        //             tag: "standard_icon",
        //             token: "visible-lock_filled",
        //             color: "orange",
        //           },
        //           text: {
        //             tag: "plain_text",
        //             content: "🔐 需要您的授权才能继续",
        //             text_size: "heading",
        //           },
        //         },
        //       ],
        //     },
        //   ],
        // },
        // 授权说明
        {
            tag: "markdown",
            content: scopeDesc,
            text_size: "normal",
        },
        // 授权按钮（small，靠右）
        {
            tag: "column_set",
            flex_mode: "none",
            horizontal_align: "right",
            columns: [
                {
                    tag: "column",
                    width: "auto",
                    elements: [
                        {
                            tag: "button",
                            text: { tag: "plain_text", content: "前往授权" },
                            type: "primary",
                            size: "medium",
                            multi_url: multiUrl,
                        },
                    ],
                },
            ],
        },
        // 失效时间提醒
        {
            tag: "markdown",
            content: `<font color='grey'>授权链接将在 ${expiresMin} 分钟后失效，届时需重新发起</font>`,
            text_size: "notation",
        },
        // 批量授权提示（仅 auto-auth 流程展示）
        ...(showBatchAuthHint ? [{
                tag: "markdown",
                content: "<font color='grey'>💡如果你希望一次性授予所有插件所需要的权限，可以告诉我「授予所有用户权限」，我会协助你完成。</font>",
                text_size: "notation",
            }] : []),
    ];
    return {
        schema: "2.0",
        config: {
            wide_screen_mode: false,
            style: {
                color: {
                    "light-yellow-bg": {
                        light_mode: "rgba(255, 214, 102, 0.12)",
                        dark_mode: "rgba(255, 214, 102, 0.08)",
                    },
                },
            },
        },
        header: {
            title: {
                tag: "plain_text",
                content: "需要您的授权才能继续"
            },
            subtitle: {
                "tag": "plain_text",
                "content": "",
            },
            template: "blue",
            padding: "12px 12px 12px 12px",
            icon: {
                tag: "standard_icon",
                token: "lock-chat_filled"
            },
        },
        body: { elements },
    };
}
/** scope 字符串 → 可读描述 */
function formatScopeDescription(scope, isBatchAuth, totalAppScopes, alreadyGranted, batchInfo, filteredScopes, appId) {
    const scopes = scope?.split(/\s+/).filter(Boolean);
    if (isBatchAuth && scopes && scopes.length > 0) {
        let message = `应用需要授权 **${scopes.length}** 个用户权限（共 ${totalAppScopes} 个，已授权 ${alreadyGranted} 个）。`;
        // 如果超过 5 个 scope，只显示前 3 个，然后用"..."表示
        if (scopes.length > 5) {
            const previewScopes = scopes.slice(0, 3).join("\n");
            message += `\n\n**将要授权的权限**：\n${previewScopes}\n...\n`;
        }
        else {
            const scopeList = scopes.map((s, idx) => `${idx + 1}. ${s}`).join("\n");
            message += `\n\n**将要授权的权限列表**：\n${scopeList}\n`;
        }
        // 添加分批提示信息
        if (batchInfo) {
            message += `\n\n${batchInfo}`;
        }
        // // 添加过滤 scope 提示
        // if (filteredScopes && filteredScopes.length > 0) {
        //   message += `\n\n⚠️ **以下 ${filteredScopes.length} 个权限因应用未开通而被跳过**：\n`;
        //   message += filteredScopes.map((s, idx) => `${idx + 1}. ${s}`).join("\n");
        //   if (appId) {
        //     message += `\n\n需要管理员在[开放平台](https://open.feishu.cn/app/${appId}/security)开通这些权限后才能授权。`;
        //   }
        // }
        return message;
    }
    const desc = "授权后，应用将能够以您的身份执行相关操作。";
    if (!scopes?.length)
        return desc;
    let message = desc + "\n\n所需权限：\n" + scopes.map((s) => `- ${s}`).join("\n");
    // // 添加过滤 scope 提示（非批量授权场景）
    // if (filteredScopes && filteredScopes.length > 0) {
    //   message += `\n\n⚠️ **以下 ${filteredScopes.length} 个权限因应用未开通而被跳过**：\n`;
    //   message += filteredScopes.map((s) => `- ${s}`).join("\n");
    //   if (appId) {
    //     message += `\n\n需要管理员在[开放平台](https://open.feishu.cn/app/${appId}/security)开通这些权限后才能授权。`;
    //   }
    // }
    return message;
}
function toInAppWebUrl(targetUrl) {
    const encoded = encodeURIComponent(targetUrl);
    const lkMeta = encodeURIComponent(JSON.stringify({
        "page-meta": {
            showNavBar: "false",
            showBottomNavBar: "false",
        },
    }));
    return ("https://applink.feishu.cn/client/web_url/open" +
        `?mode=sidebar-semi&max_width=800&reload=false&url=${encoded}&lk_meta=${lkMeta}`);
}
function buildAuthSuccessCard() {
    return {
        schema: "2.0",
        config: {
            wide_screen_mode: false,
            style: {
                color: {
                    "light-green-bg": {
                        light_mode: "rgba(52, 199, 89, 0.12)",
                        dark_mode: "rgba(52, 199, 89, 0.08)",
                    },
                },
            },
        },
        header: {
            title: {
                tag: "plain_text",
                content: "授权成功"
            },
            subtitle: {
                "tag": "plain_text",
                "content": "",
            },
            template: "green",
            padding: "12px 12px 12px 12px",
            icon: {
                tag: "standard_icon",
                token: "yes_filled"
            },
        },
        body: {
            elements: [
                // {
                //   tag: "column_set",
                //   flex_mode: "none",
                //   background_style: "light-green-bg",
                //   columns: [
                //     {
                //       tag: "column",
                //       width: "weighted",
                //       weight: 1,
                //       vertical_align: "center",
                //       padding: "8px 12px",
                //       elements: [
                //         {
                //           tag: "div",
                //           icon: {
                //             tag: "standard_icon",
                //             token: "succeed_filled",
                //             color: "green",
                //           },
                //           text: {
                //             tag: "plain_text",
                //             content: "授权成功 | 已完成身份授权",
                //             text_size: "heading",
                //           },
                //         },
                //       ],
                //     },
                //   ],
                // },
                {
                    tag: "markdown",
                    content: "您的飞书账号已成功授权，正在为您继续执行操作。\n\n" +
                        "<font color='grey'>如需撤销授权，可随时告诉我。</font>",
                },
            ],
        },
    };
}
function buildAuthFailedCard(reason) {
    return {
        schema: "2.0",
        config: {
            wide_screen_mode: false,
            style: {
                color: {
                    "light-grey-bg": {
                        light_mode: "rgba(142, 142, 147, 0.12)",
                        dark_mode: "rgba(142, 142, 147, 0.08)",
                    },
                },
            },
        },
        header: {
            title: {
                tag: "plain_text",
                content: "授权未完成"
            },
            subtitle: {
                "tag": "plain_text",
                "content": "",
            },
            template: "yellow",
            padding: "12px 12px 12px 12px",
            icon: {
                tag: "standard_icon",
                token: "warning_filled"
            },
        },
        body: {
            elements: [
                // {
                //   tag: "column_set",
                //   flex_mode: "none",
                //   background_style: "light-grey-bg",
                //   columns: [
                //     {
                //       tag: "column",
                //       width: "weighted",
                //       weight: 1,
                //       vertical_align: "center",
                //       padding: "8px 12px",
                //       elements: [
                //         {
                //           tag: "div",
                //           icon: {
                //             tag: "standard_icon",
                //             token: "warning_filled",
                //             color: "grey",
                //           },
                //           text: {
                //             tag: "plain_text",
                //             content: "授权未完成",
                //             text_size: "heading",
                //           },
                //         },
                //         {
                //           tag: "markdown",
                //           content: reason,
                //           text_size: "notation",
                //         },
                //       ],
                //     },
                //   ],
                // },
                {
                    tag: "markdown",
                    content: "授权链接已过期，请重新发起授权。",
                    // text_size: "notation",
                },
            ],
        },
    };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(obj) {
    return {
        content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
        details: obj,
    };
}
// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
export function registerFeishuOAuthTool(api) {
    if (!api.config)
        return;
    const cfg = api.config;
    api.registerTool({
        name: "feishu_oauth",
        label: "Feishu OAuth",
        description: "飞书用户授权（OAuth）管理工具。" +
            "【注意】授权流程由系统自动发起，不要主动调用此工具触发授权！" +
            "此工具仅用于 revoke（撤销当前用户的授权）。" +
            "不需要传入 user_open_id，系统自动从消息上下文获取当前用户。" +
            "【Token 过期处理】当返回 token_expired 错误时，调用 revoke 撤销后，系统会自动重新发起授权流程。",
        parameters: FeishuOAuthSchema,
        async execute(_toolCallId, params) {
            let p = params;
            // Resolve identity from trace context (set in monitor.ts).
            const traceCtx = getTraceContext();
            const senderOpenId = traceCtx?.senderOpenId;
            if (!senderOpenId) {
                return json({
                    error: "无法获取当前用户身份（senderOpenId），请在飞书对话中使用此工具。",
                });
            }
            // Use the accountId from TraceContext to resolve the correct account
            // (important for multi-account setups like prod + boe).
            const acct = getLarkAccount(cfg, traceCtx.accountId);
            if (!acct.configured) {
                return json({
                    error: `账号 ${traceCtx.accountId} 缺少 appId 或 appSecret 配置`,
                });
            }
            const account = acct; // Now we know it's ConfiguredLarkAccount
            try {
                switch (p.action) {
                    // ---------------------------------------------------------------
                    // AUTHORIZE — 已由 auto-auth 自动处理，此分支不再对外暴露
                    // ---------------------------------------------------------------
                    // case "authorize": {
                    //   return await executeAuthorize({
                    //     account,
                    //     senderOpenId,
                    //     scope: p.scope || "",
                    //     isBatchAuth: false,
                    //     cfg,
                    //     traceCtx,
                    //   });
                    // }
                    // ---------------------------------------------------------------
                    // STATUS
                    // ---------------------------------------------------------------
                    // case "status": {
                    //   const status = await getUATStatus(account.appId, senderOpenId);
                    //   return json({
                    //     authorized: status.authorized,
                    //     scope: status.scope,
                    //     token_status: status.tokenStatus,
                    //     granted_at: status.grantedAt
                    //       ? new Date(status.grantedAt).toISOString()
                    //       : undefined,
                    //     expires_at: status.expiresAt
                    //       ? new Date(status.expiresAt).toISOString()
                    //       : undefined,
                    //   });
                    // }
                    // ---------------------------------------------------------------
                    // REVOKE
                    // ---------------------------------------------------------------
                    case "revoke": {
                        await revokeUAT(account.appId, senderOpenId);
                        return json({ success: true, message: "用户授权已撤销。" });
                    }
                    default:
                        return json({ error: `未知操作: ${p.action}` });
                }
            }
            catch (err) {
                trace.error(`oauth: ${p.action} failed: ${err}`);
                return json({ error: formatLarkError(err) });
            }
        },
    }, { name: "feishu_oauth" });
    api.logger.info?.("feishu_oauth: Registered feishu_oauth tool");
}
/**
 * 执行 OAuth 授权流程（Device Flow）
 * 可被 feishu_oauth 和 feishu_oauth_batch_auth 共享调用
 */
export async function executeAuthorize(params) {
    const { account, senderOpenId, scope, isBatchAuth, totalAppScopes, alreadyGranted, batchInfo, skipSyntheticMessage, showBatchAuthHint, forceAuth, onAuthComplete, cfg, traceCtx } = params;
    const { appId, appSecret, brand, accountId } = account;
    // 1. Check if user already authorised + scope coverage.
    // forceAuth=true 时跳过缓存检查，直接发起新 Device Flow。
    // 用于 AppScopeMissing 场景：应用权限刚被移除再补回，本地 UAT 缓存的 scope 状态不可信。
    const existing = forceAuth ? null : await getStoredToken(appId, senderOpenId);
    if (existing && tokenStatus(existing) !== "expired") {
        // 如果请求了特定 scope，检查是否已覆盖
        if (scope) {
            const requestedScopes = scope.split(/\s+/).filter(Boolean);
            const grantedScopes = new Set((existing.scope ?? "").split(/\s+/).filter(Boolean));
            const missingScopes = requestedScopes.filter((s) => !grantedScopes.has(s));
            if (missingScopes.length > 0) {
                // scope 不足 → 继续走 Device Flow（飞书 OAuth 是增量授权）
                trace.info(`oauth: existing token missing scopes [${missingScopes.join(", ")}], starting incremental auth`);
                // 不 revoke 旧 token，直接用缺失的 scope 发起新 Device Flow
                // 飞书会累积授权，新 token 包含旧 + 新 scope
                // 继续执行下面的 Device Flow 逻辑
            }
            else {
                if (onAuthComplete) {
                    try {
                        await onAuthComplete();
                    }
                    catch (e) {
                        trace.warn(`oauth: onAuthComplete failed: ${e}`);
                    }
                }
                return json({
                    success: true,
                    message: "用户已授权，scope 已覆盖。",
                    authorized: true,
                    scope: existing.scope,
                });
            }
        }
        else {
            if (onAuthComplete) {
                try {
                    await onAuthComplete();
                }
                catch (e) {
                    trace.warn(`oauth: onAuthComplete failed: ${e}`);
                }
            }
            return json({
                success: true,
                message: "用户已授权，无需重复授权。",
                authorized: true,
                scope: existing.scope,
            });
        }
    }
    // 2. Guard against duplicate in-flight flows for this user.
    const flowKey = `${appId}:${senderOpenId}`;
    if (pendingFlows.has(flowKey)) {
        const oldFlow = pendingFlows.get(flowKey);
        // 1. 中止旧轮询
        oldFlow.controller.abort();
        // 2. 更新旧卡片为"授权未完成"（复用现有卡片）
        try {
            await updateCardKitCard({
                cfg,
                cardId: oldFlow.cardId,
                card: buildAuthFailedCard(""), // 复用现有卡片，reason 参数被忽略
                sequence: oldFlow.sequence + 1,
                accountId,
            });
        }
        catch (err) {
            trace.warn(`oauth: failed to update cancelled card: ${err}`);
        }
        // 3. 立即删除记录（避免 race condition）
        pendingFlows.delete(flowKey);
        // 4. 记录日志
        trace.info(`oauth: cancelled previous authorization flow for user=${senderOpenId}, app=${appId}, cardId=${oldFlow.cardId}`);
        // 5. 继续执行新流程（不 return，让后续代码继续运行）
    }
    // 2.5 应用 scope 预检：过滤掉应用未开通的 scope
    let filteredScope = scope;
    let unavailableScopes = [];
    if (scope) {
        try {
            const sdk = LarkClient.fromAccount(account).sdk;
            const requestedScopes = scope.split(/\s+/).filter(Boolean);
            const appScopes = await getAppGrantedScopes(sdk, appId, "user");
            const availableScopes = requestedScopes.filter(s => appScopes.includes(s));
            unavailableScopes = requestedScopes.filter(s => !appScopes.includes(s));
            if (unavailableScopes.length > 0) {
                trace.info(`oauth: App has not granted scopes [${unavailableScopes.join(", ")}], filtering them out`);
                if (availableScopes.length === 0) {
                    // 所有 scope 都未开通，直接返回错误
                    const permissionUrl = `https://open.feishu.cn/app/${appId}/permission`;
                    return json({
                        error: "app_scopes_not_granted",
                        message: `应用未开通任何请求的用户权限，无法发起授权。请先在开放平台开通以下权限：\n${unavailableScopes.map(s => `- ${s}`).join('\n')}\n\n权限管理地址：${permissionUrl}`,
                        unavailable_scopes: unavailableScopes,
                        app_permission_url: permissionUrl,
                    });
                }
                // 部分 scope 未开通，只授权已开通的 scope
                filteredScope = availableScopes.join(" ");
                trace.info(`oauth: Proceeding with available scopes [${availableScopes.join(", ")}]`);
            }
        }
        catch (err) {
            // 如果 scope 检查失败，记录日志但继续执行（降级处理）
            trace.warn(`oauth: Failed to check app scopes, proceeding anyway: ${err}`);
        }
    }
    // 3. Request device authorisation.
    const deviceAuth = await requestDeviceAuthorization({
        appId,
        appSecret,
        brand,
        scope: filteredScope,
    });
    // 4. Generate QR code PNG and upload (best-effort).
    let imageKey;
    try {
        const qrBuffer = await QRCode.toBuffer(deviceAuth.verificationUriComplete, { type: "png", width: 140, margin: 2, errorCorrectionLevel: "M" });
        const uploaded = await uploadImageFeishu({
            cfg,
            image: qrBuffer,
            imageType: "message",
            accountId,
        });
        imageKey = uploaded.imageKey;
    }
    catch (e) {
        trace.warn(`oauth: QR image upload failed, sending card without QR: ${e}`);
    }
    // 5. Build and send authorisation card.
    const authCard = buildAuthCard({
        imageKey,
        verificationUriComplete: deviceAuth.verificationUriComplete,
        expiresMin: Math.round(deviceAuth.expiresIn / 60),
        scope: filteredScope, // 使用过滤后的 scope
        isBatchAuth,
        totalAppScopes,
        alreadyGranted,
        batchInfo,
        filteredScopes: unavailableScopes.length > 0 ? unavailableScopes : undefined,
        appId,
        showBatchAuthHint,
    });
    const cardId = await createCardEntity({
        cfg,
        card: authCard,
        accountId,
    });
    if (!cardId) {
        return json({ error: "创建授权卡片失败" });
    }
    const chatId = traceCtx?.chatId;
    if (!chatId) {
        return json({ error: "无法确定发送目标" });
    }
    await sendCardByCardId({
        cfg,
        to: chatId,
        cardId,
        replyToMessageId: traceCtx?.messageId?.startsWith("om_") ? traceCtx.messageId : undefined,
        accountId,
    });
    // 7. Start background polling.
    const abortController = new AbortController();
    // Sequence counter for card updates (starts at 1 after create).
    let seq = 1;
    pendingFlows.set(flowKey, {
        controller: abortController,
        cardId,
        sequence: seq,
    });
    let pendingFlowDelete = false;
    // Fire-and-forget – polling happens asynchronously.
    pollDeviceToken({
        appId,
        appSecret,
        brand,
        deviceCode: deviceAuth.deviceCode,
        interval: deviceAuth.interval,
        expiresIn: deviceAuth.expiresIn,
        signal: abortController.signal,
    })
        .then(async (result) => {
        if (result.ok) {
            // Save token to Keychain.
            const now = Date.now();
            const storedToken = {
                userOpenId: senderOpenId,
                appId,
                accessToken: result.token.accessToken,
                refreshToken: result.token.refreshToken,
                expiresAt: now + result.token.expiresIn * 1000,
                refreshExpiresAt: now + result.token.refreshExpiresIn * 1000,
                scope: result.token.scope,
                grantedAt: now,
            };
            await setStoredToken(storedToken);
            // 1. Update card → success immediately so user sees
            //    visual confirmation right away.
            try {
                await updateCardKitCard({
                    cfg,
                    cardId,
                    card: buildAuthSuccessCard(),
                    sequence: ++seq,
                    accountId,
                });
            }
            catch (e) {
                trace.warn(`oauth: failed to update card to success: ${e}`);
            }
            // 删除 pending flow
            pendingFlows.delete(flowKey);
            pendingFlowDelete = true;
            // 2. Send synthetic message to notify AI that auth is
            //    complete, so it can automatically retry the operation.
            //    Skip when called from onboarding (no AI context to retry).
            // 调用 onAuthComplete 回调（用于 onboarding 批量授权链式触发）
            if (onAuthComplete) {
                try {
                    await onAuthComplete();
                }
                catch (e) {
                    trace.warn(`oauth: onAuthComplete failed: ${e}`);
                }
            }
            if (skipSyntheticMessage) {
                trace.info("oauth: skipSyntheticMessage=true, skipping synthetic message");
            }
            else
                try {
                    // Use a unique message_id for MessageSid (avoids SDK dedup),
                    // but pass the real message ID as replyToMessageId so that
                    // typing indicators, reply-to threading, and delivery work.
                    const syntheticMsgId = `${traceCtx.messageId}:auth-complete`;
                    const syntheticEvent = {
                        sender: {
                            sender_id: { open_id: senderOpenId },
                        },
                        message: {
                            message_id: syntheticMsgId,
                            chat_id: chatId,
                            chat_type: traceCtx.chatType ?? "p2p",
                            message_type: "text",
                            content: JSON.stringify({
                                text: "我已完成飞书账号授权，请继续执行之前的操作。",
                            }),
                        },
                    };
                    // Provide a minimal runtime so reply-dispatcher
                    // does not crash on `params.runtime.log?.()`.
                    const syntheticRuntime = {
                        log: (msg) => trace.info(msg),
                        error: (msg) => trace.error(msg),
                    };
                    const { status, promise } = enqueueFeishuChatTask({
                        accountId,
                        chatId,
                        task: async () => {
                            await withTrace({
                                messageId: syntheticMsgId,
                                chatId,
                                accountId,
                                startTime: Date.now(),
                                senderOpenId,
                                httpHeaders: traceCtx.httpHeaders,
                                chatType: traceCtx.chatType,
                            }, () => handleFeishuMessage({
                                cfg,
                                event: syntheticEvent,
                                accountId,
                                forceMention: true,
                                runtime: syntheticRuntime,
                                replyToMessageId: traceCtx.messageId,
                            }));
                        },
                    });
                    trace.info(`oauth: synthetic message queued (${status})`);
                    await promise;
                    trace.info("oauth: synthetic message dispatched after successful auth");
                }
                catch (e) {
                    trace.warn(`oauth: failed to send synthetic message after auth: ${e}`);
                }
        }
        else {
            // Update card → failure.
            try {
                await updateCardKitCard({
                    cfg,
                    cardId,
                    card: buildAuthFailedCard(result.message),
                    sequence: ++seq,
                    accountId,
                });
            }
            catch (e) {
                trace.warn(`oauth: failed to update card to failure: ${e}`);
            }
            // 删除 pending flow
            pendingFlows.delete(flowKey);
            pendingFlowDelete = true;
        }
    })
        .catch((err) => {
        trace.error(`oauth: polling error: ${err}`);
    }).finally(() => {
        if (!pendingFlowDelete) {
            // 3. 如果没有删除 pending flow，则删除¬
            pendingFlows.delete(flowKey);
        }
    });
    const scopeCount = filteredScope.split(/\s+/).filter(Boolean).length;
    let message = isBatchAuth
        ? `已发送批量授权请求卡片，共需授权 ${scopeCount} 个权限。请在卡片中完成授权。`
        : "已发送授权请求卡片，请用户在卡片中扫码或点击链接完成授权。授权完成后请重新执行之前的操作。";
    if (batchInfo) {
        message += batchInfo;
    }
    // 如果有被过滤的 scope，添加提示信息
    if (unavailableScopes.length > 0) {
        const permissionUrl = `https://open.feishu.cn/app/${appId}/permission`;
        message += `\n\n⚠️ **注意**：以下权限因应用未开通而被跳过，如需使用请先在开放平台开通：\n${unavailableScopes.map(s => `- ${s}`).join('\n')}\n\n权限管理地址：${permissionUrl}`;
    }
    return json({
        success: true,
        message,
        awaiting_authorization: true,
        filtered_scopes: unavailableScopes.length > 0 ? unavailableScopes : undefined,
        app_permission_url: unavailableScopes.length > 0 ? `https://open.feishu.cn/app/${appId}/permission` : undefined,
    });
}
//# sourceMappingURL=oauth.js.map