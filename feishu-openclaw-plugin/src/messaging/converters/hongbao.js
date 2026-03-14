/**
 * Converter for "hongbao" (red packet) message type.
 */
import { safeParse } from "./utils.js";
export const convertHongbao = (raw) => {
    const parsed = safeParse(raw);
    const text = parsed?.text;
    const textAttr = text ? ` text="${text}"` : "";
    return {
        content: `<hongbao${textAttr}/>`,
        resources: [],
    };
};
//# sourceMappingURL=hongbao.js.map