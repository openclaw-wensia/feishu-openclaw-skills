/**
 * feishu_get_user tool -- 获取用户信息
 *
 * 支持两种模式:
 * 1. 不传 user_id: 获取当前用户自己的信息 (sdk.authen.userInfo.get)
 * 2. 传 user_id: 获取指定用户的信息 (sdk.contact.v3.user.get)
 */
import { Type } from "@sinclair/typebox";
import { json, createToolContext, assertLarkOk, handleInvokeErrorWithAutoAuth, } from "../helpers.js";
// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const GetUserSchema = Type.Object({
    user_id: Type.Optional(Type.String({
        description: "用户 ID（格式如 ou_xxx）。若不传入，则获取当前用户自己的信息",
    })),
    user_id_type: Type.Optional(Type.Union([
        Type.Literal("open_id"),
        Type.Literal("union_id"),
        Type.Literal("user_id"),
    ])),
});
// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
export function registerGetUserTool(api) {
    if (!api.config)
        return;
    const cfg = api.config;
    const { toolClient, log } = createToolContext(api, "feishu_get_user");
    api.registerTool({
        name: "feishu_get_user",
        label: "Feishu: Get User Info",
        description: "获取用户信息。不传 user_id 时获取当前用户自己的信息；传 user_id 时获取指定用户的信息。" +
            "返回用户姓名、头像、邮箱、手机号、部门等信息。",
        parameters: GetUserSchema,
        async execute(_toolCallId, params) {
            const p = params;
            try {
                const client = toolClient();
                // 模式 1: 获取当前用户自己的信息
                if (!p.user_id) {
                    log.info("get_user: fetching current user info");
                    const res = await client.invoke("feishu_get_user.default", (sdk, opts) => sdk.authen.userInfo.get({}, opts), { as: "user" });
                    assertLarkOk(res);
                    log.info("get_user: current user fetched successfully");
                    return json({
                        user: res.data,
                    });
                }
                // 模式 2: 获取指定用户的信息
                log.info(`get_user: fetching user ${p.user_id}`);
                const userIdType = p.user_id_type || "open_id";
                const res = await client.invoke("feishu_get_user.default", (sdk, opts) => sdk.contact.v3.user.get({
                    path: { user_id: p.user_id },
                    params: {
                        user_id_type: userIdType,
                    },
                }, opts), { as: "user" });
                assertLarkOk(res);
                log.info(`get_user: user ${p.user_id} fetched successfully`);
                return json({
                    user: res.data?.user,
                });
            }
            catch (err) {
                return await handleInvokeErrorWithAutoAuth(err, cfg);
            }
        },
    }, { name: "feishu_get_user" });
    api.logger.info?.("feishu_get_user: Registered feishu_get_user tool");
}
//# sourceMappingURL=get-user.js.map