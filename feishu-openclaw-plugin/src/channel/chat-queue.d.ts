/**
 * Shared per-chat task queue.
 *
 * Ensures tasks targeting the same account+chat are executed serially.
 * Used by both websocket inbound messages and synthetic message paths.
 */
type QueueStatus = "queued" | "immediate";
export type ActiveDispatcherEntry = {
    abortCard: () => Promise<void>;
    abortController?: AbortController;
};
export declare function buildQueueKey(accountId: string, chatId: string): string;
export declare function registerActiveDispatcher(key: string, entry: ActiveDispatcherEntry): void;
export declare function unregisterActiveDispatcher(key: string): void;
export declare function getActiveDispatcher(key: string): ActiveDispatcherEntry | undefined;
/** Check whether the queue has an active task for the given key. */
export declare function hasActiveTask(key: string): boolean;
export declare function enqueueFeishuChatTask(params: {
    accountId: string;
    chatId: string;
    task: () => Promise<void>;
}): {
    status: QueueStatus;
    promise: Promise<void>;
};
export {};
//# sourceMappingURL=chat-queue.d.ts.map