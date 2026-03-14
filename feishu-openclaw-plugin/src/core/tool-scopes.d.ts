/**
 * Tool Scopes 配置
 *
 * 定义所有工具动作所需的飞书权限映射。
 *
 * ## 维护方式
 *
 * ⚠️ 此文件采用**手动维护**，新增或修改工具时需同步更新。
 *
 * ### 新增工具动作
 *
 * 1. 在 `ToolActionKey` 类型中添加新键：
 *    ```typescript
 *    export type ToolActionKey =
 *      | "feishu_calendar_event.create"
 *      | "feishu_new_tool.action"  // 新增
 *    ```
 *
 * 2. 在 `TOOL_SCOPES` 对象中添加对应配置：
 *    ```typescript
 *    export const TOOL_SCOPES: ToolScopeMapping = {
 *      "feishu_new_tool.action": [
 *        "required:scope:here"
 *      ],
 *    };
 *    ```
 *
 * 3. 运行 TypeScript 类型检查验证一致性：
 *    ```bash
 *    cd openclaw/feishu && npx tsc --noEmit
 *    ```
 *
 * ### 如何确定所需 Scope
 *
 * 1. **查阅飞书开放平台 API 文档**：https://open.feishu.cn/document
 * 2. **使用 feishu-oapi-search skill**：在 Claude Code 中搜索 API 文档
 * 3. **参考类似工具**：查看功能相近的工具的 scope 配置
 * 4. **实际测试**：观察 API 调用的错误码（99991672=应用缺权限，99991679=用户缺授权）
 *
 * 最后更新: 2026-03-03
 */
/**
 * 所有可用的工具动作键
 *
 * 格式：{tool_name}.{action_name}
 *
 * 示例：
 * - "feishu_calendar_event.create"
 * - "feishu_bitable_app_table_record.update"
 *
 * 总计：114 个工具动作
 */
export type ToolActionKey = "feishu_bitable_app.copy" | "feishu_bitable_app.create" | "feishu_bitable_app.get" | "feishu_bitable_app.list" | "feishu_bitable_app.patch" | "feishu_bitable_app_table.batch_create" | "feishu_bitable_app_table.batch_delete" | "feishu_bitable_app_table.create" | "feishu_bitable_app_table.delete" | "feishu_bitable_app_table.list" | "feishu_bitable_app_table.patch" | "feishu_bitable_app_table_field.create" | "feishu_bitable_app_table_field.delete" | "feishu_bitable_app_table_field.list" | "feishu_bitable_app_table_field.update" | "feishu_bitable_app_table_record.batch_create" | "feishu_bitable_app_table_record.batch_delete" | "feishu_bitable_app_table_record.batch_update" | "feishu_bitable_app_table_record.create" | "feishu_bitable_app_table_record.delete" | "feishu_bitable_app_table_record.list" | "feishu_bitable_app_table_record.update" | "feishu_bitable_app_table_view.create" | "feishu_bitable_app_table_view.delete" | "feishu_bitable_app_table_view.get" | "feishu_bitable_app_table_view.list" | "feishu_bitable_app_table_view.patch" | "feishu_calendar_calendar.get" | "feishu_calendar_calendar.list" | "feishu_calendar_calendar.primary" | "feishu_calendar_event.create" | "feishu_calendar_event.delete" | "feishu_calendar_event.get" | "feishu_calendar_event.instance_view" | "feishu_calendar_event.instances" | "feishu_calendar_event.list" | "feishu_calendar_event.patch" | "feishu_calendar_event.reply" | "feishu_calendar_event.search" | "feishu_calendar_event_attendee.batch_delete" | "feishu_calendar_event_attendee.create" | "feishu_calendar_event_attendee.list" | "feishu_calendar_freebusy.list" | "feishu_chat.get" | "feishu_chat.search" | "feishu_chat_members.default" | "feishu_create_doc.default" | "feishu_doc_comments.create" | "feishu_doc_comments.list" | "feishu_doc_comments.patch" | "feishu_drive_fetch_media.default" | "feishu_drive_file.copy" | "feishu_drive_file.delete" | "feishu_drive_file.download" | "feishu_drive_file.get_meta" | "feishu_drive_file.list" | "feishu_drive_file.move" | "feishu_drive_file.upload" | "feishu_fetch_doc.default" | "feishu_get_user.default" | "feishu_im_user_fetch_resource.default" | "feishu_im_user_get_messages.default" | "feishu_im_user_message.reply" | "feishu_im_user_message.send" | "feishu_im_user_search_messages.default" | "feishu_search_doc_wiki.search" | "feishu_search_user.default" | "feishu_task_comment.create" | "feishu_task_comment.get" | "feishu_task_comment.list" | "feishu_task_subtask.create" | "feishu_task_subtask.list" | "feishu_task_task.create" | "feishu_task_task.get" | "feishu_task_task.list" | "feishu_task_task.patch" | "feishu_task_tasklist.add_members" | "feishu_task_tasklist.create" | "feishu_task_tasklist.delete" | "feishu_task_tasklist.get" | "feishu_task_tasklist.list" | "feishu_task_tasklist.patch" | "feishu_task_tasklist.remove_members" | "feishu_task_tasklist.tasks" | "feishu_update_doc.default" | "feishu_wiki_space.create" | "feishu_wiki_space.get" | "feishu_wiki_space.list" | "feishu_wiki_space_node.copy" | "feishu_wiki_space_node.create" | "feishu_wiki_space_node.get" | "feishu_wiki_space_node.list" | "feishu_wiki_space_node.move";
/**
 * Tool Scope 映射类型
 *
 * 将每个 ToolActionKey 映射到其所需的 scope 数组
 */
export type ToolScopeMapping = Record<ToolActionKey, string[]>;
/**
 * Tool Scope 数据
 *
 * 每个工具动作所需的飞书权限列表（Required Scopes）
 *
 * ## 数据说明
 *
 * - 空数组 `[]` 表示该工具动作不需要任何权限
 * - 多个权限表示需要同时拥有所有权限（AND 关系）
 * - 所有 scope 都是 user scopes（用户级权限）
 *
 * ## 示例
 *
 * ```typescript
 * TOOL_SCOPES["feishu_calendar_event.create"]
 * // 返回: ["calendar:calendar.event:create", "calendar:calendar.event:update"]
 * ```
 *
 * @see {@link ToolActionKey} 所有可用的工具动作键
 */
export declare const TOOL_SCOPES: ToolScopeMapping;
/**
 * 工具动作总数: 114
 * 唯一 scope 总数: 66
 */
//# sourceMappingURL=tool-scopes.d.ts.map