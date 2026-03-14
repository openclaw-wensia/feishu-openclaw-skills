/**
 * 飞书 IM 消息操作工具集
 *
 * - feishu_im_message_reaction: 给消息添加表情回复
 * - feishu_im_message_recall:   撤回消息
 *
 * 飞书 API:
 *   - 表情回复: POST   /open-apis/im/v1/messages/:message_id/reactions
 *   - 撤回消息: DELETE /open-apis/im/v1/messages/:message_id
 * 凭证: tenant_access_token
 */
import { Type } from "@sinclair/typebox";
import { json, createToolContext, assertLarkOk, formatLarkError, } from "../../oapi/helpers";
// ===========================================================================
// Reaction tool — feishu_im_message_reaction
// ===========================================================================
const FeishuImMessageReactionSchema = Type.Union([
    Type.Object({
        action: Type.Literal("create"),
        message_id: Type.String({
            description: "要添加表情的消息 ID（message_id）",
        }),
        emoji_type: Type.String({
            description: "表情类型，可选值：OK、THUMBSUP、THANKS、MUSCLE、FINGERHEART、APPLAUSE、FISTBUMP、JIAYI、DONE、SMILE、BLUSH、LAUGH、SMIRK、LOL、FACEPALM、LOVE、WINK、PROUD、WITTY、SMART、SCOWL、THINKING、SOB、CRY、ERROR、NOSEPICK、HAUGHTY、SLAP、SPITBLOOD、TOASTED、GLANCE、DULL、INNOCENTSMILE、JOYFUL、WOW、TRICK、YEAH、ENOUGH、TEARS、EMBARRASSED、KISS、SMOOCH、DROOL、OBSESSED、MONEY、TEASE、SHOWOFF、COMFORT、CLAP、PRAISE、STRIVE、XBLUSH、SILENT、WAVE、WHAT、FROWN、SHY、DIZZY、LOOKDOWN、CHUCKLE、WAIL、CRAZY、WHIMPER、HUG、BLUBBER、WRONGED、HUSKY、SHHH、SMUG、ANGRY、HAMMER、SHOCKED、TERROR、PETRIFIED、SKULL、SWEAT、SPEECHLESS、SLEEP、DROWSY、YAWN、SICK、PUKE、BETRAYED、HEADSET、EatingFood、MeMeMe、Sigh、Typing、Lemon、Get、LGTM、OnIt、OneSecond、VRHeadset、YouAreTheBest、SALUTE、SHAKE、HIGHFIVE、UPPERLEFT、ThumbsDown、SLIGHT、TONGUE、EYESCLOSED、RoarForYou、CALF、BEAR、BULL、RAINBOWPUKE、ROSE、HEART、PARTY、LIPS、BEER、CAKE、GIFT、CUCUMBER、Drumstick、Pepper、CANDIEDHAWS、BubbleTea、Coffee、Yes、No、OKR、CheckMark、CrossMark、MinusOne、Hundred、AWESOMEN、Pin、Alarm、Loudspeaker、Trophy、Fire、BOMB、Music、XmasTree、Snowman、XmasHat、FIREWORKS、2022、REDPACKET、FORTUNE、LUCK、FIRECRACKER、StickyRiceBalls、HEARTBROKEN、POOP、StatusFlashOfInspiration、18X、CLEAVER、Soccer、Basketball、GeneralDoNotDisturb、Status_PrivateMessage、GeneralInMeetingBusy、StatusReading、StatusInFlight、GeneralBusinessTrip、GeneralWorkFromHome、StatusEnjoyLife、GeneralTravellingCar、StatusBus、GeneralSun、GeneralMoonRest、MoonRabbit、Mooncake、JubilantRabbit、TV、Movie、Pumpkin、BeamingFace、Delighted、ColdSweat、FullMoonFace、Partying、GoGoGo、ThanksFace、SaluteFace、Shrug、ClownFace、HappyDragon",
        }),
    }),
]);
export function registerFeishuImMessageReactionTool(api) {
    if (!api.config)
        return;
    const { getClient, log } = createToolContext(api, "feishu_im_message_reaction");
    api.registerTool({
        name: "feishu_im_message_reaction",
        label: "Feishu IM Message Reaction",
        description: "飞书消息表情回复工具。用于给指定消息添加表情回复。Actions: create（添加表情回复）。",
        parameters: FeishuImMessageReactionSchema,
        async execute(_toolCallId, params) {
            const p = params;
            try {
                const client = getClient();
                switch (p.action) {
                    case "create": {
                        log.info(`create: message_id=${p.message_id}, emoji_type=${p.emoji_type}`);
                        const res = await client.im.messageReaction.create({
                            path: {
                                message_id: p.message_id,
                            },
                            data: {
                                reaction_type: {
                                    emoji_type: p.emoji_type,
                                },
                            },
                        });
                        assertLarkOk(res);
                        const reactionId = res.data?.reaction_id ?? null;
                        log.info(`create: reaction_id=${reactionId ?? "unknown"}`);
                        return json({
                            reaction_id: reactionId,
                            message_id: p.message_id,
                            emoji_type: p.emoji_type,
                        });
                    }
                    default:
                        return json({ error: `未知操作: ${p.action}` });
                }
            }
            catch (err) {
                log.error(`Error: ${formatLarkError(err)}`);
                return json({
                    error: formatLarkError(err),
                });
            }
        },
    }, { name: "feishu_im_message_reaction" });
    api.logger.info?.("feishu_im_message_reaction: Registered feishu_im_message_reaction tool");
}
// ===========================================================================
// Recall tool — feishu_im_message_recall
// ===========================================================================
const FeishuImMessageRecallSchema = Type.Object({
    message_id: Type.String({
        description: "要撤回的消息 ID（om_xxx 格式）",
    }),
});
export function registerFeishuImMessageRecallTool(api) {
    if (!api.config)
        return;
    const { getClient, log } = createToolContext(api, "feishu_im_message_recall");
    api.registerTool({
        name: "feishu_im_message_recall",
        label: "Feishu IM Message Recall",
        description: "【以机器人身份】撤回飞书消息。" +
            '\n\n⚠️ 引用消息场景：当用户通过「引用回复」说"撤回这个"时，用户想撤回的是**被引用的那条消息**（即引用指向的消息），' +
            "而不是用户自己发的这条引用消息。请务必使用被引用消息的 message_id，不要使用用户当前消息的 message_id。" +
            "\n\n适用场景：撤回机器人之前发送的回复、通知等消息。",
        parameters: FeishuImMessageRecallSchema,
        async execute(_toolCallId, params) {
            const p = params;
            try {
                const client = getClient();
                log.info(`recall: message_id=${p.message_id}`);
                const res = await client.im.message.delete({
                    path: { message_id: p.message_id },
                });
                assertLarkOk(res);
                log.info(`recall: success, message_id=${p.message_id}`);
                return json({
                    message_id: p.message_id,
                    success: true,
                });
            }
            catch (err) {
                log.error(`Error: ${formatLarkError(err)}`);
                return json({ error: formatLarkError(err) });
            }
        },
    }, { name: "feishu_im_message_recall" });
    api.logger.info?.("feishu_im_message_recall: Registered feishu_im_message_recall tool");
}
//# sourceMappingURL=message-ops.js.map