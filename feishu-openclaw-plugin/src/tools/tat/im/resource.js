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
import { buildRandomTempFilePath } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { json, createToolContext, formatLarkError, } from "../../oapi/helpers";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
// ===========================================================================
// Shared constants
// ===========================================================================
/** 文件扩展名 → 飞书上传 file_type */
const EXT_TO_FILE_TYPE = {
    ".opus": "opus",
    ".mp4": "mp4",
    ".pdf": "pdf",
    ".doc": "doc",
    ".docx": "doc",
    ".xls": "xls",
    ".xlsx": "xls",
    ".ppt": "ppt",
    ".pptx": "ppt",
};
/** MIME type → 文件扩展名（下载时使用） */
const MIME_TO_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "video/mp4": ".mp4",
    "video/mpeg": ".mpeg",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/zip": ".zip",
    "application/x-rar-compressed": ".rar",
    "text/plain": ".txt",
    "application/json": ".json",
};
// ===========================================================================
// Shared helpers
// ===========================================================================
function inferFileType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return EXT_TO_FILE_TYPE[ext] ?? "stream";
}
/**
 * 从二进制响应中提取 Buffer、Content-Type。
 * SDK 的二进制响应可能有 getReadableStream()，也可能直接是 Buffer 等格式。
 */
async function extractBuffer(res) {
    let chunks;
    if (typeof res.getReadableStream === "function") {
        const stream = res.getReadableStream();
        chunks = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
    }
    else if (Buffer.isBuffer(res)) {
        chunks = [res];
    }
    else if (Buffer.isBuffer(res?.data)) {
        chunks = [res.data];
    }
    else {
        throw new Error("无法从响应中提取二进制数据");
    }
    const buffer = Buffer.concat(chunks);
    const contentType = res.headers?.["content-type"] ?? "";
    return { buffer, contentType };
}
/**
 * 将 buffer 保存到临时文件，返回路径。
 */
async function saveToTempFile(buffer, contentType, prefix) {
    const mimeType = contentType ? contentType.split(";")[0].trim() : "";
    const mimeExt = mimeType ? MIME_TO_EXT[mimeType] : undefined;
    const filePath = buildRandomTempFilePath({
        prefix,
        extension: mimeExt,
    });
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, buffer);
    return filePath;
}
// ===========================================================================
// Upload tool — feishu_im_bot_upload
// ===========================================================================
const FeishuImBotUploadSchema = Type.Union([
    Type.Object({
        action: Type.Literal("upload_image"),
        file_path: Type.String({ description: "本地图片文件路径" }),
        image_type: Type.Optional(Type.Union([Type.Literal("message"), Type.Literal("avatar")], {
            description: "图片类型，默认 message",
        })),
    }),
    Type.Object({
        action: Type.Literal("upload_file"),
        file_path: Type.String({ description: "本地文件路径" }),
        file_type: Type.Optional(Type.Union([
            Type.Literal("opus"),
            Type.Literal("mp4"),
            Type.Literal("pdf"),
            Type.Literal("doc"),
            Type.Literal("xls"),
            Type.Literal("ppt"),
            Type.Literal("stream"),
        ], { description: "文件类型，默认根据扩展名推断，未知则用 stream" })),
        file_name: Type.Optional(Type.String({ description: "文件名（默认从路径提取）" })),
        duration: Type.Optional(Type.Integer({ description: "音视频时长（毫秒）" })),
    }),
]);
export function registerFeishuImBotUploadTool(api) {
    if (!api.config)
        return;
    const { getClient, log } = createToolContext(api, "feishu_im_bot_upload");
    api.registerTool({
        name: "feishu_im_bot_upload",
        label: "Feishu IM Bot Upload",
        description: "【以机器人身份】上传图片或文件到飞书平台，获取 image_key / file_key，供后续发送消息使用。" +
            "\n\nActions:" +
            "\n- upload_image: 上传图片（≤10MB），返回 image_key" +
            "\n- upload_file: 上传文件（≤30MB），返回 file_key",
        parameters: FeishuImBotUploadSchema,
        async execute(_toolCallId, params) {
            const p = params;
            try {
                const client = getClient();
                switch (p.action) {
                    case "upload_image": {
                        const imageType = p.image_type ?? "message";
                        log.info(`upload_image: file_path="${p.file_path}", image_type="${imageType}"`);
                        const res = await client.im.image.create({
                            data: {
                                image_type: imageType,
                                image: fs.createReadStream(p.file_path),
                            },
                        });
                        const imageKey = res?.data?.image_key ??
                            res?.image_key ??
                            null;
                        log.info(`upload_image: image_key=${imageKey ?? "unknown"}`);
                        return json({
                            image_key: imageKey,
                            file_path: p.file_path,
                            image_type: imageType,
                        });
                    }
                    case "upload_file": {
                        const fileName = p.file_name ?? path.basename(p.file_path);
                        const fileType = p.file_type ?? inferFileType(p.file_path);
                        log.info(`upload_file: file_path="${p.file_path}", file_type="${fileType}", file_name="${fileName}"`);
                        const res = await client.im.file.create({
                            data: {
                                file_type: fileType,
                                file_name: fileName,
                                file: fs.createReadStream(p.file_path),
                                ...(p.duration != null
                                    ? { duration: p.duration }
                                    : {}),
                            },
                        });
                        const fileKey = res?.data?.file_key ?? res?.file_key ?? null;
                        log.info(`upload_file: file_key=${fileKey ?? "unknown"}`);
                        return json({
                            file_key: fileKey,
                            file_path: p.file_path,
                            file_type: fileType,
                            file_name: fileName,
                        });
                    }
                }
            }
            catch (err) {
                log.error(`Error: ${formatLarkError(err)}`);
                return json({ error: formatLarkError(err) });
            }
        },
    }, { name: "feishu_im_bot_upload" });
    api.logger.info?.("feishu_im_bot_upload: Registered feishu_im_bot_upload tool");
}
// ===========================================================================
// Download tool — feishu_im_bot_image
// ===========================================================================
const FeishuImBotImageSchema = Type.Object({
    message_id: Type.String({
        description: "消息 ID（om_xxx 格式），引用消息可从上下文中的 [message_id=om_xxx] 提取",
    }),
    file_key: Type.String({
        description: "资源 Key，图片消息的 image_key（img_xxx）或文件消息的 file_key（file_xxx）",
    }),
    type: Type.Union([Type.Literal("image"), Type.Literal("file")], {
        description: "资源类型：image（图片消息中的图片）、file（文件/音频/视频消息中的文件）",
    }),
});
export function registerFeishuImBotImageTool(api) {
    if (!api.config)
        return;
    const { getClient, log } = createToolContext(api, "feishu_im_bot_image");
    api.registerTool({
        name: "feishu_im_bot_image",
        label: "Feishu: IM Bot Image Download",
        description: "【以机器人身份】下载飞书 IM 消息中的图片或文件资源到本地。" +
            "\n\n适用场景：用户直接发送给机器人的消息、用户引用的消息、机器人收到的群聊消息中的图片/文件。" +
            "即当前对话上下文中出现的 message_id 和 image_key/file_key，应使用本工具下载。" +
            "\n引用消息的 message_id 可从上下文中的 [message_id=om_xxx] 提取，无需向用户询问。" +
            "\n\n文件自动保存到 /tmp/openclaw/ 下，返回值中的 saved_path 为实际保存路径。",
        parameters: FeishuImBotImageSchema,
        async execute(_toolCallId, params) {
            const p = params;
            try {
                const client = getClient();
                log.info(`download: message_id="${p.message_id}", file_key="${p.file_key}", type="${p.type}"`);
                const res = await client.im.messageResource.get({
                    path: {
                        message_id: p.message_id,
                        file_key: p.file_key,
                    },
                    params: { type: p.type },
                });
                const { buffer, contentType } = await extractBuffer(res);
                log.info(`download: ${buffer.length} bytes, content-type=${contentType}`);
                const savedPath = await saveToTempFile(buffer, contentType, "bot-resource");
                log.info(`download: saved to ${savedPath}`);
                return json({
                    message_id: p.message_id,
                    file_key: p.file_key,
                    type: p.type,
                    size_bytes: buffer.length,
                    content_type: contentType,
                    saved_path: savedPath,
                });
            }
            catch (err) {
                log.error(`Error: ${formatLarkError(err)}`);
                return json({ error: formatLarkError(err) });
            }
        },
    }, { name: "feishu_im_bot_image" });
    api.logger.info?.("feishu_im_bot_image: Registered feishu_im_bot_image tool");
}
//# sourceMappingURL=resource.js.map