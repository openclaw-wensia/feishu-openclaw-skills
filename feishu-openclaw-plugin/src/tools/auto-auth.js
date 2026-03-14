/**
 * auto-auth.ts — 工具层自动授权处理。
 *
 * 当 OAPI 工具遇到授权问题时，直接在工具层处理，不再让 AI 判断：
 *
 * - UserAuthRequiredError (appScopeVerified=true)
 *   → 直接调用 executeAuthorize 发起 OAuth Device Flow 卡片
 *
 * - UserScopeInsufficientError
 *   → 直接调用 executeAuthorize（使用 missingScopes）
 *
 * - AppScopeMissingError
 *   → 发送应用权限引导卡片；用户点击"我已完成"后：
 *     1. 更新卡片为处理中状态
 *     2. invalidateAppScopeCache
 *     3. 发送中间合成消息告知 AI（"应用权限已确认，正在发起用户授权..."）
 *     4. 调用 executeAuthorize 发起 OAuth Device Flow
 *
 * - 其他情况（AppScopeCheckFailedError、appScopeVerified=false 等）
 *   → 回退到原 handleInvokeError（不触发自动授权）
 *
 * 降级策略（保守）：以下情况均回退到 handleInvokeError：
 * - 无 TraceContext（非消息场景）
 * - 无 senderOpenId（无法确定授权对象）
 * - 账号未配置（!acct.configured）
 * - 任何步骤抛出异常
 */
import { getTraceContext, trace } from "../core/trace.js";
import { getLarkAccount } from "../core/accounts.js";
import { UserAuthRequiredError, UserScopeInsufficientError, AppScopeMissingError, } from "../core/tool-client.js";
import { invalidateAppScopeCache, getAppGrantedScopes, isAppScopeSatisfied } from "../core/app-scope-checker.js";
import { LarkClient } from "../core/lark-client.js";
import { createCardEntity, sendCardByCardId, updateCardKitCard, } from "../card/cardkit.js";
import { executeAuthorize } from "./oauth.js";
import { formatLarkError } from "./oapi/helpers.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(obj) {
    return {
        content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
        details: obj,
    };
}
/** 生成飞书应用内打开的 URL（侧边栏模式，与 oauth.ts 保持一致）。 */
function toInAppWebUrl(targetUrl) {
    const encoded = encodeURIComponent(targetUrl);
    const lkMeta = encodeURIComponent(JSON.stringify({
        "page-meta": { showNavBar: "false", showBottomNavBar: "false" },
    }));
    return ("https://applink.feishu.cn/client/web_url/open" +
        `?mode=sidebar-semi&max_width=800&reload=false&url=${encoded}&lk_meta=${lkMeta}`);
}
const pendingAppAuthFlows = new Map();
/**
 * 去重索引：dedupKey → operationId。
 *
 * 防止并发工具调用（parallel tool calls）时重复发送内容相同的应用授权卡片。
 * key = chatId + "\0" + sorted(missingScopes).join(",")
 */
const dedupIndex = new Map();
/** TTL：15 分钟后自动清理，防止内存泄漏。 */
const PENDING_FLOW_TTL_MS = 15 * 60 * 1000;
/** 计算去重 key（chatId + 有序 scopes）。 */
function makeDedupKey(chatId, scopes) {
    return chatId + "\0" + [...scopes].sort().join(",");
}
// ---------------------------------------------------------------------------
// Card builders — CardKit v2 格式
// ---------------------------------------------------------------------------
/**
 * 构建应用权限引导卡片。
 *
 * 蓝色 header，列出缺失的 scope，提供权限管理链接和"我已完成，继续授权"按钮。
 */
function buildAppScopeMissingCard(params) {
    const { missingScopes, appId, operationId } = params;
    const authUrl = appId
        ? `https://open.feishu.cn/app/${appId}/auth?q=${encodeURIComponent(missingScopes.join(","))}&op_from=feishu-openclaw&token_type=user`
        : "https://open.feishu.cn/";
    const inAppUrl = toInAppWebUrl(authUrl);
    const multiUrl = { url: inAppUrl, pc_url: inAppUrl, android_url: inAppUrl, ios_url: inAppUrl };
    const scopeList = missingScopes.map((s) => `• ${s}`).join("\n");
    return {
        schema: "2.0",
        config: { wide_screen_mode: true },
        header: {
            title: { tag: "plain_text", content: "🔐 需要申请权限才能继续" },
            template: "orange",
        },
        body: {
            elements: [
                {
                    tag: "markdown",
                    content: "调用前，请你先申请以下**所有**权限：",
                    text_size: "normal",
                },
                {
                    tag: "column_set",
                    flex_mode: "none",
                    background_style: "grey",
                    horizontal_spacing: "default",
                    columns: [
                        {
                            tag: "column",
                            width: "weighted",
                            weight: 1,
                            vertical_align: "center",
                            elements: [{ tag: "markdown", content: scopeList }],
                        },
                    ],
                },
                { tag: "hr" },
                {
                    tag: "column_set",
                    flex_mode: "none",
                    horizontal_spacing: "default",
                    columns: [
                        {
                            tag: "column",
                            width: "weighted",
                            weight: 3,
                            vertical_align: "center",
                            elements: [{ tag: "markdown", content: "**第一步：申请所有权限**" }],
                        },
                        {
                            tag: "column",
                            width: "weighted",
                            weight: 1,
                            vertical_align: "center",
                            elements: [
                                {
                                    tag: "button",
                                    text: { tag: "plain_text", content: "去申请" },
                                    type: "primary",
                                    multi_url: multiUrl,
                                },
                            ],
                        },
                    ],
                },
                {
                    tag: "column_set",
                    flex_mode: "none",
                    horizontal_spacing: "default",
                    columns: [
                        {
                            tag: "column",
                            width: "weighted",
                            weight: 3,
                            vertical_align: "center",
                            elements: [{ tag: "markdown", content: "**第二步：创建版本并审核通过**" }],
                        },
                        {
                            tag: "column",
                            width: "weighted",
                            weight: 1,
                            vertical_align: "center",
                            elements: [
                                {
                                    tag: "button",
                                    text: { tag: "plain_text", content: "已完成" },
                                    type: "default",
                                    value: { action: "app_auth_done", operation_id: operationId },
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    };
}
/**
 * 构建应用权限引导卡片的"处理中"状态（用户点击按钮后更新）。
 */
function buildAppAuthProgressCard() {
    return {
        schema: "2.0",
        config: { wide_screen_mode: false },
        header: {
            title: { tag: "plain_text", content: "授权成功" },
            subtitle: { tag: "plain_text", content: "" },
            template: "green",
            padding: "12px 12px 12px 12px",
            icon: { tag: "standard_icon", token: "yes_filled" },
        },
        body: {
            elements: [
                {
                    tag: "markdown",
                    content: "您的应用权限已开通，正在为您发起用户授权",
                    text_size: "normal",
                },
            ],
        },
    };
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * 发送应用权限引导卡片，并将 flow 存入 pendingAppAuthFlows。
 * 返回工具结果（告知 AI 等待用户操作）。
 */
async function sendAppScopeCard(params) {
    const { account, missingScopes, appId, scopeNeedType, tokenType, cfg, traceCtx } = params;
    const { accountId, chatId } = traceCtx;
    // ---- 去重：避免并发工具调用时发出多张内容相同的卡片 ----
    const dedup = makeDedupKey(chatId, missingScopes);
    const existingOpId = dedupIndex.get(dedup);
    if (existingOpId && pendingAppAuthFlows.has(existingOpId)) {
        trace.info(`auto-auth: dedup – app-scope card already pending for chatId=${chatId}, ` +
            `scopes=[${missingScopes.join(", ")}], skipping duplicate send`);
        return json({
            awaiting_app_authorization: true,
            message: "已向用户发送授权引导卡片，等待用户完成授权操作。" +
                "请告知用户：按照卡片提示完成授权，完成后系统将自动重试之前的操作。" +
                "请等待用户完成卡片操作，不要建议其他替代方案。",
            missing_scopes: missingScopes,
        });
    }
    const operationId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const card = buildAppScopeMissingCard({ missingScopes, appId, operationId });
    // 创建 CardKit 卡片实体
    const cardId = await createCardEntity({ cfg, card, accountId });
    if (!cardId) {
        trace.warn("auto-auth: createCardEntity failed for app-scope card, falling back");
        return json({
            error: "app_scope_missing",
            missing_scopes: missingScopes,
            message: `应用缺少以下权限：${missingScopes.join(", ")}，` +
                `请管理员在开放平台开通后重试。` +
                (appId ? `\n权限管理：https://open.feishu.cn/app/${appId}/permission` : ""),
        });
    }
    // 发送到当前会话
    const replyToMsgId = traceCtx.messageId?.startsWith("om_")
        ? traceCtx.messageId
        : undefined;
    await sendCardByCardId({ cfg, to: chatId, cardId, replyToMessageId: replyToMsgId, accountId });
    // 存入 pending map，15 分钟 TTL
    const flow = {
        appId: appId ?? account.appId,
        accountId,
        cardId,
        sequence: 0,
        requiredScopes: missingScopes,
        scopeNeedType,
        tokenType,
        cfg,
        traceCtx,
        dedupKey: dedup,
    };
    pendingAppAuthFlows.set(operationId, flow);
    dedupIndex.set(dedup, operationId);
    setTimeout(() => {
        pendingAppAuthFlows.delete(operationId);
        dedupIndex.delete(dedup);
    }, PENDING_FLOW_TTL_MS);
    trace.info(`auto-auth: app-scope card sent, operationId=${operationId}, scopes=[${missingScopes.join(", ")}]`);
    return json({
        awaiting_app_authorization: true,
        message: "已向用户发送授权引导卡片，等待用户完成授权操作。" +
            "请告知用户：按照卡片提示完成授权，完成后系统将自动重试之前的操作。" +
            "请等待用户完成卡片操作，不要建议其他替代方案。",
        missing_scopes: missingScopes,
    });
}
// ---------------------------------------------------------------------------
// Card action handler (exported for monitor.ts)
// ---------------------------------------------------------------------------
/**
 * 处理 card.action.trigger 回调事件（由 monitor.ts 调用）。
 *
 * 当用户点击应用权限引导卡片的"我已完成，继续授权"按钮时：
 * 1. 更新卡片为"处理中"状态
 * 2. 清除应用 scope 缓存
 * 3. 发送中间合成消息告知 AI
 * 4. 发起 OAuth Device Flow
 *
 * 注意：函数体内的主要逻辑通过 setImmediate + fire-and-forget 异步执行，
 * 确保 Feishu card.action.trigger 回调在 3 秒内返回。
 */
export async function handleCardAction(data, cfg, accountId) {
    let action;
    let operationId;
    let senderOpenId;
    try {
        const event = data;
        action = event.action?.value?.action;
        operationId = event.action?.value?.operation_id;
        senderOpenId = event.operator?.open_id;
    }
    catch {
        return;
    }
    if (action !== "app_auth_done" || !operationId)
        return;
    const flow = pendingAppAuthFlows.get(operationId);
    if (!flow) {
        trace.warn(`auto-auth: card action ${operationId} not found (expired or already handled)`);
        return;
    }
    trace.info(`auto-auth: app_auth_done clicked by ${senderOpenId}, operationId=${operationId}`);
    // scope 校验在同步路径完成（3 秒内返回 toast response）
    invalidateAppScopeCache(flow.appId);
    const acct = getLarkAccount(flow.cfg, flow.accountId);
    if (!acct.configured) {
        trace.warn(`auto-auth: account ${flow.accountId} not configured, skipping OAuth`);
        return;
    }
    const sdk = LarkClient.fromAccount(acct).sdk;
    let grantedScopes = [];
    try {
        // 使用与原始 AppScopeMissingError 相同的 tokenType，保证校验逻辑完全一致
        grantedScopes = await getAppGrantedScopes(sdk, flow.appId, flow.tokenType);
    }
    catch (err) {
        trace.warn(`auto-auth: failed to re-check app scopes: ${err}, proceeding anyway`);
    }
    // 使用共享函数 isAppScopeSatisfied，与 tool-client invoke() 逻辑完全一致：
    //   - scopeNeedType "all" → 全部必须有
    //   - 默认"one" → 交集非空即可
    //   - grantedScopes 为空 → 视为满足（API 失败退回服务端判断）
    if (!isAppScopeSatisfied(grantedScopes, flow.requiredScopes, flow.scopeNeedType)) {
        trace.warn(`auto-auth: app scopes still missing after user confirmation: [${flow.requiredScopes.join(", ")}]`);
        return {
            toast: {
                type: "error",
                content: "权限尚未开通，请确认已申请并审核通过后再试",
            },
        };
    }
    trace.info(`auto-auth: app scopes verified, proceeding with OAuth`);
    // 校验通过才删除，防止用户在权限通过前多次点击无法重试
    pendingAppAuthFlows.delete(operationId);
    dedupIndex.delete(flow.dedupKey);
    // scope 通过，后台异步执行卡片更新 + OAuth
    setImmediate(async () => {
        try {
            // 更新卡片为成功状态
            try {
                await updateCardKitCard({
                    cfg,
                    cardId: flow.cardId,
                    card: buildAppAuthProgressCard(),
                    sequence: flow.sequence + 1,
                    accountId,
                });
            }
            catch (err) {
                trace.warn(`auto-auth: failed to update app-scope card to progress: ${err}`);
            }
            // 3. 发起 OAuth Device Flow（完成后 executeAuthorize 会自动发合成消息触发 AI 重试）
            if (!flow.traceCtx.senderOpenId) {
                trace.warn("auto-auth: no senderOpenId in traceCtx, skipping OAuth");
                return;
            }
            await executeAuthorize({
                account: acct,
                senderOpenId: flow.traceCtx.senderOpenId,
                scope: flow.requiredScopes.join(" "),
                showBatchAuthHint: true,
                forceAuth: true, // 应用权限刚经历移除→补回，不信任本地 UAT 缓存
                cfg: flow.cfg,
                traceCtx: flow.traceCtx,
            });
        }
        catch (err) {
            trace.error(`auto-auth: handleCardAction background task failed: ${err}`);
        }
    });
}
// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
/**
 * 统一处理 `client.invoke()` 抛出的错误，支持自动发起 OAuth 授权。
 *
 * 替代 `handleInvokeError`，在工具层直接处理授权问题：
 * - 用户授权类错误 → 直接 executeAuthorize（发 Device Flow 卡片）
 * - 应用权限缺失 → 发送引导卡片，用户确认后自动接力 OAuth
 * - 其他错误 → 回退到 handleInvokeError 的标准处理
 *
 * @param err - invoke() 或其他逻辑抛出的错误
 * @param cfg - OpenClaw 配置对象（从工具注册函数的闭包中获取）
 */
export async function handleInvokeErrorWithAutoAuth(err, cfg) {
    const traceCtx = getTraceContext();
    if (traceCtx) {
        const senderOpenId = traceCtx.senderOpenId;
        // --- Path 1：用户授权类错误 → 直接发起 OAuth ---
        if (senderOpenId) {
            // 1a. 用户未授权或 token scope 不足（且 app scope 已验证）
            if (err instanceof UserAuthRequiredError && err.appScopeVerified) {
                const scope = err.requiredScopes.join(" ");
                try {
                    const acct = getLarkAccount(cfg, traceCtx.accountId);
                    if (acct.configured) {
                        trace.info(`auto-auth: UserAuthRequiredError → auto-executeAuthorize, scope=[${scope}]`);
                        return await executeAuthorize({
                            account: acct,
                            senderOpenId,
                            scope,
                            showBatchAuthHint: true,
                            cfg,
                            traceCtx,
                        });
                    }
                }
                catch (autoAuthErr) {
                    trace.warn(`auto-auth: executeAuthorize failed: ${autoAuthErr}, falling back`);
                }
            }
            // 1b. 用户 token 存在但 scope 不足（服务端 99991679）
            if (err instanceof UserScopeInsufficientError) {
                const scope = err.missingScopes.join(" ");
                try {
                    const acct = getLarkAccount(cfg, traceCtx.accountId);
                    if (acct.configured) {
                        trace.info(`auto-auth: UserScopeInsufficientError → auto-executeAuthorize, scope=[${scope}]`);
                        return await executeAuthorize({
                            account: acct,
                            senderOpenId,
                            scope,
                            showBatchAuthHint: true,
                            cfg,
                            traceCtx,
                        });
                    }
                }
                catch (autoAuthErr) {
                    trace.warn(`auto-auth: executeAuthorize failed: ${autoAuthErr}, falling back`);
                }
            }
        }
        // --- Path 2：应用权限缺失 → 发送引导卡片 ---
        if (err instanceof AppScopeMissingError && traceCtx.chatId) {
            try {
                const acct = getLarkAccount(cfg, traceCtx.accountId);
                if (acct.configured) {
                    trace.info(`auto-auth: AppScopeMissingError → sending app-scope card, ` +
                        `scopes=[${err.missingScopes.join(", ")}]`);
                    return await sendAppScopeCard({
                        account: acct,
                        missingScopes: err.missingScopes,
                        appId: err.appId,
                        scopeNeedType: err.scopeNeedType,
                        tokenType: err.tokenType,
                        cfg,
                        traceCtx,
                    });
                }
            }
            catch (cardErr) {
                trace.warn(`auto-auth: sendAppScopeCard failed: ${cardErr}, falling back`);
            }
        }
    }
    return json({
        error: formatLarkError(err),
    });
}
//# sourceMappingURL=auto-auth.js.map