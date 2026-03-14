/**
 * Fallback converter for unsupported message types.
 */
export const convertUnknown = (raw, _ctx) => {
    // Attempt to return something meaningful from the raw content
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.text === "string")
            return { content: parsed.text, resources: [] };
    }
    catch {
        // ignore
    }
    return { content: `[unsupported message]`, resources: [] };
};
//# sourceMappingURL=unknown.js.map