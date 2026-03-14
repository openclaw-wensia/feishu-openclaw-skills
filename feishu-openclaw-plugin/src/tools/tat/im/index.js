/**
 * IM 工具集
 * 统一导出所有即时通讯相关工具的注册函数
 */
import { registerFeishuImMessageReactionTool, registerFeishuImMessageRecallTool } from "./message-ops.js";
import { registerFeishuImBotImageTool, registerFeishuImBotUploadTool } from "./resource.js";
/**
 * 注册所有 IM 工具
 */
export function registerFeishuImTools(api) {
    registerFeishuImMessageReactionTool(api);
    api.logger.info?.("feishu_im: Registered feishu_im_message_reaction");
    registerFeishuImBotImageTool(api);
    api.logger.info?.("feishu_im: Registered feishu_im_bot_image");
    registerFeishuImMessageRecallTool(api);
    api.logger.info?.("feishu_im: Registered feishu_im_message_recall");
    registerFeishuImBotUploadTool(api);
    api.logger.info?.("feishu_im: Registered feishu_im_bot_upload");
}
//# sourceMappingURL=index.js.map