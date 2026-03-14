/**
 * feishu_im_bot_upload / feishu_im_bot_image 工具
 *
 * 统一管理飞书 IM 资源的上传与下载：
 *   - upload_image: 上传图片 → image_key
 *   - upload_file:  上传文件 → file_key
 *   - download:     下载消息中的图片/文件资源到本地
 *
 * 飞书 API:
 *   - 上传图片: POST /open-apis/im/v1/images  — 返回 image_key
 *   - 上传文件: POST /open-apis/im/v1/files   — 返回 file_key
 *   - 下载资源: GET  /open-apis/im/v1/messages/:message_id/resources/:file_key
 * 权限: im:resource
 * 凭证: tenant_access_token
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
export declare function registerFeishuImBotUploadTool(api: OpenClawPluginApi): void;
export declare function registerFeishuImBotImageTool(api: OpenClawPluginApi): void;
//# sourceMappingURL=resource.d.ts.map