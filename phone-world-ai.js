import { generatePhoneWorldCompletion } from './rag-client.js';
import { preparePhoneStoryContext } from './phone-context.js';
import {
    appendPhoneMessage,
    createPhoneRoundId,
    getPhoneChatId,
} from './phone-store.js';
import { cleanPhoneText as text } from './phone-utils.js';
import {
    applyPhoneWeiboBatch,
    buildPhoneWeiboAiRequest,
    isPhoneWeiboAiReady,
    parsePhoneWeiboAiBatch,
} from './phone-weibo-ai.js';
import { normalizePhoneCommunityState } from './phone-community.js';
import { normalizePhoneLiveState } from './phone-live.js';

const COMMUNITY_LIMIT = 30;
const LIVE_OFFICIAL_LIMIT = 5;
const LIVE_PRIVATE_LIMIT = 10;
const WORLD_MODULES = Object.freeze(['weibo', 'community', 'live', 'messages']);
const DAILY_WORLD_MODULES = Object.freeze(['weibo', 'community', 'live']);
const DECISION_MODULE = 'decision';
const MESSAGE_MEDIUM = '(?:消息|信息|短信|私信|微信|群聊消息|聊天消息)';
const MESSAGE_EVIDENCE_PATTERN = new RegExp([
    `(?:发来|发出|发送|收到|收到了|回复了?|回了).{0,16}${MESSAGE_MEDIUM}`,
    `${MESSAGE_MEDIUM}.{0,24}(?:发来|发出|发送|收到|收到了|回复了?|回了|弹出|跳出|送达)` ,
    `(?:给|向).{1,20}发(?:了|去|出|送)?${MESSAGE_MEDIUM}`,
    `(?:用|通过)(?:手机|短信|私信|微信).{0,30}(?:发给|发送|回复)` ,
    `手机.{0,12}(?:响|亮|震).{0,30}${MESSAGE_MEDIUM}.{0,16}(?:显示|写着|说|叫|让)`,
].join('|'), 'u');
const MESSAGE_ROUTE_PATTERNS = Object.freeze([
    new RegExp(`([^，。；！？\n]{1,32})(?:给|向)([^，。；！？\n]{1,24})发(?:了|去|出|送)?${MESSAGE_MEDIUM}`, 'u'),
    new RegExp(`([^，。；！？\n]{1,32})(?:发|发送|回复)(?:了)?${MESSAGE_MEDIUM}(?:给|向)([^，。；！？\n]{1,24})`, 'u'),
    new RegExp(`([^，。；！？\n]{1,32})(?:用|通过)(?:手机|短信|私信|微信).{0,12}发给([^，。；！？\n]{1,24})`, 'u'),
]);
const PUBLIC_MODULE_EVIDENCE = Object.freeze({
    weibo: /微博|博文|热搜|超话|转评|评论区|点赞|发(?:了)?(?:一|了)?条动态/u,
    community: /论坛|楼主|CP榜|同人|产粮|嗑点|扒帖|网上.{0,12}(帖子|讨论帖)|社区(?!服务|中心|居委|居民|街道)(?:.{0,8}(?:帖子|讨论|发帖|回帖))?/u,
    live: /直播|开播|直播间|主播|弹幕|连麦/u,
});
const WORLD_MODULE_TOKEN_BUDGETS = Object.freeze({
    weibo: 10_000,
    community: 15_000,
    live: 10_000,
    messages: 3_500,
});

let lifecycleBound = false;
let updateQueue = Promise.resolve();
const worldUpdateInFlight = new Map();
const worldUpdateControllers = new Map();

function clone(value) {
    if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function makeId(prefix) {
    const value = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    return `${prefix}-${value}`;
}

function hashText(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function announceWorldGeneration(worldGeneration) {
    globalThis.dispatchEvent?.(new CustomEvent('memory-augment-phone-world-status', {
        detail: clone(worldGeneration ?? {}),
    }));
}

function selectedSwipeIndex(message = {}) {
    const swipes = Array.isArray(message.swipes) ? message.swipes : [];
    const value = Math.trunc(Number(message.swipe_id));
    return value >= 0 && value < swipes.length ? value : 0;
}

function storyText(message = {}) {
    const index = selectedSwipeIndex(message);
    return text(message?.swipes?.[index] ?? message?.mes ?? message?.content, 30_000);
}

export function buildPhoneStoryTurnText(context = {}, messageId = -1) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const assistantIndex = Math.trunc(Number(messageId));
    const assistant = chat[assistantIndex];
    if (!assistant || assistant.is_user) return '';
    let userText = '';
    for (let index = assistantIndex - 1; index >= 0; index--) {
        const candidate = chat[index];
        if (!candidate) continue;
        if (candidate.is_user) {
            userText = storyText(candidate);
            break;
        }
        if (!candidate.is_system) break;
    }
    const assistantText = storyText(assistant);
    return [
        userText ? `【玩家本轮输入】\n${userText}` : '',
        assistantText ? `【AI本轮正文】\n${assistantText}` : '',
    ].filter(Boolean).join('\n\n');
}

function phoneWorldSourceKey(context, messageId, message) {
    const latestStory = buildPhoneStoryTurnText(context, messageId) || storyText(message);
    return `${getPhoneChatId(context)}:${messageId}:${selectedSwipeIndex(message)}:${hashText(latestStory)}:phone-world`;
}

function isCurrentPhoneWorldSource(context, messageId, sourceKey) {
    const message = context?.chat?.[Number(messageId)];
    return Boolean(message && !message.is_user && storyText(message)
        && phoneWorldSourceKey(context, messageId, message) === sourceKey);
}

export function isPhoneWorldStoryUpdateInFlight(sourceKey = '') {
    const key = text(sourceKey, 500);
    return key ? worldUpdateInFlight.has(key) : worldUpdateInFlight.size > 0;
}

function abortSupersededPhoneWorldUpdates(context, messageId, options = {}) {
    const numericId = Number(messageId);
    const message = context?.chat?.[numericId];
    const currentKey = message && !message.is_user && storyText(message)
        ? phoneWorldSourceKey(context, numericId, message)
        : '';
    const chatPrefix = `${getPhoneChatId(context)}:`;
    for (const [key, controller] of worldUpdateControllers) {
        const parts = key.split(':');
        const keyMessageId = Number(parts.at(-4));
        const sameChat = key.startsWith(chatPrefix);
        const shouldAbort = options.fromMessageId === true
            ? sameChat && keyMessageId >= numericId
            : sameChat && keyMessageId === numericId && key !== currentKey;
        if (shouldAbort) controller.abort();
    }
}

function scanJsonObjects(raw) {
    const source = String(raw ?? '').replace(/^```(?:json|jsonl)?\s*/i, '').replace(/\s*```$/i, '');
    const objects = [];
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
            continue;
        }
        if (character === '"') {
            quoted = true;
            continue;
        }
        if (character === '{') {
            if (depth === 0) start = index;
            depth++;
        } else if (character === '}' && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                objects.push(source.slice(start, index + 1));
                start = -1;
            }
        }
    }
    return objects;
}

export function parsePhoneWorldRecords(raw) {
    const records = new Map();
    const errors = [];
    let decision = null;
    const inferModule = (value, fallback = '') => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
        if (Array.isArray(value.posts) || Array.isArray(value.hotTopics)) return 'weibo';
        if (Array.isArray(value.forumThreads) || Array.isArray(value.cpRankings) || Array.isArray(value.fanWorks)) return 'community';
        if (Array.isArray(value.official) || Array.isArray(value.private)) return 'live';
        if (Array.isArray(value.conversations) || Object.hasOwn(value, 'evidenceQuote')) return 'messages';
        return WORLD_MODULES.includes(fallback) ? fallback : '';
    };
    const accept = (value, fallbackModule = '') => {
        if (Array.isArray(value)) {
            value.forEach((item, index) => accept(item, WORLD_MODULES[index]));
            return;
        }
        if (!value || typeof value !== 'object') return;
        const module = text(value.module, 40);
        if (module === DECISION_MODULE && value.data && typeof value.data === 'object') {
            decision ??= value.data;
            return;
        }
        if (WORLD_MODULES.includes(module) && value.data) {
            if (!records.has(module)) records.set(module, value.data);
            return;
        }
        if (Array.isArray(value.modules)) {
            value.modules.forEach((item, index) => accept(item, WORLD_MODULES[index]));
            return;
        }
        let directModuleFound = false;
        if (!decision && value.decision && typeof value.decision === 'object') {
            decision = value.decision.data && typeof value.decision.data === 'object'
                ? value.decision.data
                : value.decision;
            directModuleFound = true;
        }
        for (const name of WORLD_MODULES) {
            if (records.has(name) || !value[name] || typeof value[name] !== 'object') continue;
            records.set(name, value[name].data && typeof value[name].data === 'object'
                ? value[name].data
                : value[name]);
            directModuleFound = true;
        }
        if (directModuleFound) return;
        const inferred = inferModule(value, fallbackModule);
        if (inferred && !records.has(inferred)) records.set(inferred, value);
    };
    const source = String(raw ?? '').trim().replace(/^```(?:json|jsonl)?\s*/i, '').replace(/\s*```$/i, '');
    let wholeResponseError = null;
    try {
        accept(JSON.parse(source));
    } catch (error) {
        wholeResponseError = error;
    }
    const candidates = scanJsonObjects(source);
    candidates.forEach((candidate, index) => {
        try {
            accept(JSON.parse(candidate), candidates.length > 1 ? WORLD_MODULES[index] : '');
        } catch (error) {
            errors.push(error);
        }
    });
    if (records.size === 0 && errors.length === 0 && wholeResponseError) errors.push(wholeResponseError);
    if (records.size === 0 && !decision) {
        const detail = errors[0]?.message ? `：${errors[0].message}` : '';
        throw new Error(`手机世界 API 没有返回可用的模块记录${detail}`);
    }
    return { records, errors, decision };
}

export function selectDailyPhoneWorldModule(random = Math.random) {
    const value = Number(random?.());
    const index = Number.isFinite(value)
        ? Math.min(DAILY_WORLD_MODULES.length - 1, Math.max(0, Math.floor(value * DAILY_WORLD_MODULES.length)))
        : 0;
    return DAILY_WORLD_MODULES[index];
}

function routeIncludesPlayer(value, playerName) {
    const player = text(playerName, 80);
    if (!player) return false;
    const explicitRoutes = MESSAGE_ROUTE_PATTERNS
        .map(pattern => value.match(pattern))
        .filter(Boolean);
    if (explicitRoutes.length > 0) {
        return explicitRoutes.some(match => [match[1], match[2]].some(participant => participant.includes(player)));
    }
    if (value.includes(player) || /(?:我|你|本人).{0,24}(?:消息|信息|短信|私信|微信|发来|收到|回复)/u.test(value)) {
        return true;
    }
    // “姐姐发来消息”这类叙事默认省略的是当前视角玩家；明确写出双方的第三方通讯已在上面排除。
    return /(?:发来|回复了?).{0,16}(?:消息|信息|短信|私信|微信)/u.test(value);
}

export function detectPhoneWorldPlotModules(story, options = {}) {
    const source = text(story, 60_000);
    const messageEvidence = Array.isArray(options.messageEvidence)
        ? options.messageEvidence
        : extractPhoneMessageEvidence(source, options.playerName);
    return WORLD_MODULES.filter(module => module === 'messages'
        ? messageEvidence.length > 0
        : PUBLIC_MODULE_EVIDENCE[module]?.test(source) === true);
}

export function extractPhoneMessageEvidence(story, playerName = '') {
    const source = text(story, 60_000);
    if (!source || !text(playerName, 80)) return [];
    return source.split(/[\n。！？；]+/u)
        .map(value => text(value, 800))
        .filter(value => value && MESSAGE_EVIDENCE_PATTERN.test(value) && routeIncludesPlayer(value, playerName))
        .slice(0, 8);
}

export function inferPhonePublicWorldFrame(context = {}) {
    const character = context?.characters?.[context?.characterId] ?? {};
    const data = character?.data ?? {};
    const source = [
        character?.description,
        data?.description,
        character?.scenario,
        data?.scenario,
        data?.creator_notes,
        character?.creator_notes,
    ].map(value => text(value, 12_000)).filter(Boolean).join('\n');
    const frames = [];
    if (/(古代|王朝|皇帝|宫廷|江湖|武侠|修仙|宗门|仙门|灵力|灵气)/u.test(source)) frames.push('古代、东方幻想或仙侠社会');
    if (/(魔法|精灵|龙族|骑士|神殿|王国|教会|巫师)/u.test(source)) frames.push('架空奇幻社会');
    if (/(未来|星舰|宇宙|赛博|机甲|人工智能|星际)/u.test(source)) frames.push('未来科技或星际社会');
    if (/(娱乐圈|演员|艺人|偶像|经纪人|剧组|导演|明星)/u.test(source)) frames.push('存在成熟大众传媒与文娱行业');
    if (/(校园|学校|大学|学院|学生|社团)/u.test(source)) frames.push('存在校园生活与青年社群');
    if (frames.length === 0) frames.push('现代或近现代的日常社会');
    return [
        `公开世界类型：${[...new Set(frames)].join('；')}。`,
        '这只是由插件归纳出的无名背景框架，不含任何主角、角色、私人行动或秘密。只能据此决定时代感与公共平台风格。',
    ].join('\n');
}

export function getPhoneWorldOutputTokenBudget(modules = []) {
    const selected = [...new Set((Array.isArray(modules) ? modules : [])
        .map(item => text(item, 40)).filter(item => WORLD_MODULES.includes(item)))];
    const total = selected.reduce((sum, module) => sum + WORLD_MODULE_TOKEN_BUDGETS[module], 0);
    return Math.max(4_096, Math.min(32_000, total || 4_096));
}

function summarizeDirectory(settings = {}) {
    return (settings.phone?.weibo?.roleAccounts ?? []).map(account => ({
        id: account.id,
        nickname: account.nickname,
        bio: account.bio,
        identity: account.identity,
    }));
}

function summarizeCurrentState(settings = {}) {
    const community = normalizePhoneCommunityState(settings);
    const live = normalizePhoneLiveState(settings);
    const weibo = settings.phone?.weibo ?? {};
    return {
        weibo: {
            posts: (weibo.posts ?? []).slice(0, 30).map(item => `${item.author}｜${text(item.content, 180)}`),
            hotTopics: (weibo.hotTopics ?? []).slice(0, 20).map(item => `${item.title}｜${item.heat}`),
        },
        community: {
            forum: community.forumThreads.slice(0, 12).map(item => `${item.title}｜${item.excerpt}`),
            cp: community.cpRankings.slice(0, 15).map(item => `${item.name}｜${item.pairing}｜${item.weekly}`),
            fanworks: community.fanWorks.slice(0, 12).map(item => `${item.cpName}｜${item.title}`),
        },
        live: live.streams.slice(0, 15).map(item => `${item.type}｜${item.host}｜${item.title}｜${item.summary}`),
    };
}

function buildSelectedModulePromptLines(request) {
    const selected = new Set(request.selectedModules ?? []);
    const lines = [];
    if (selected.has('weibo')) lines.push(
        '【微博模块】',
        'data 必须使用结构：{"posts":[{"id":"唯一ID","authorType":"npc|role","authorId":"角色账号ID或空","author":"公开昵称","badge":"身份标签","tone":"rose","kind":"original","content":"正文","topics":[],"customTopics":[],"imageDescription":"可空","location":"可空","mentions":[],"source":null,"createdAt":0,"metrics":{"reposts":0,"comments":0,"likes":0},"storyEvidence":"角色帖的正文逐字依据，否则为空","hotComments":[{"id":"唯一ID","author":"网友昵称","content":"相关热评","likes":0,"createdAt":0,"tone":"violet"}]}],"hotTopics":[{"id":"唯一ID","title":"热搜标题","postId":"本批帖子ID","heat":0,"mark":"爆|沸|热|新|"}],"reply":null,"followerDelta":0,"followerReason":""}。',
        '生成 5–8 条新首页帖子。每帖字段与既有微博一致，并恰好带 5 条高度相关的 hotComments。topics 只能填写 entertainment、film、music、variety、fashion、game、anime、sports、society、finance、technology、reading、food、travel、campus、emotion、pets 这些分类 ID；中文话题词必须放入 customTopics，禁止输出 undefined。热搜生成 3–5 条且只指向本批真实 postId，其余榜位由插件从旧帖补齐。',
        request.weiboMode === 'bootstrap'
            ? '这是该存档首次初始化：根据玩家设定给出合理的初始粉丝基线，followerDelta 必须是大于 0 的初始总量；普通人通常个位或十位，名人按设定可达百万千万。'
            : 'followerDelta 只是本轮增减量；只有玩家或角色相关公开事件才调整，普通互动小幅变化，爆款或名人事件才可明显变化。',
        '角色帖 authorType=role、authorId 使用角色账号 ID，并填写正文逐字依据 storyEvidence；无资格则用 npc 世界背景帖补足。',
        '',
    );
    if (selected.has('community')) lines.push(
        '【社区模块】',
        'data 结构：{"forumThreads":[3条],"cpRankings":[3条],"fanWorks":[3条]}。三个板块各生成恰好 3 条，每条恰好 5 条相关热评。',
        '论坛字段：id,category,tag,time,title,excerpt,body,author,views,replies,comments。内容可为匿名爆料、扒帖、角色讨论、粉圈争执或剧情分析。',
        'CP榜字段：id,rank,name,kind(directional|group|pun|allx),kindLabel,left,right,pairing,members,target,series,trend(new|up|down|same),change,heat,weekly,comments。榜名是 CP 名，不是作品名。series 必须填写具体的已有或新编虚构作品名，禁止留空、写“未注明作品”“未知作品”或其他占位词；背景板作品可以自由编造。',
        '左右逆序是两对不同 CP，绝不能合并 tag。普通左右名、关系型“xx组”、姓名谐音梗和 all× 要自然混排；“xx组”按关系命名，不是在左右名后机械加“组”，并明确所属作品。同一成员组合在本批只能出现一次，也不得换名字、换作品名后重复当前榜里已有的同一对；若正文没有适合的 CP 素材，就新建别的虚构作品和人物组合。weekly 必须是本周嗑点的文字描述，绝不能填数字。',
        '同人字段：id,type(article|art|video|au|discussion),typeLabel,title,creator,cpName,pairing,series,characters,tags,time,likes,comments,summary,preview,commentsList。',
        '同人区每条必须带 tags，至少含作品名、两位角色名和唯一 CP 名。逆家不得共用 CP tag；一对 CP 只给一个 CP 名。图、剪辑、视频只写文字描述；同人文 preview 约一百字后自然省略。',
        '',
    );
    if (selected.has('live')) lines.push(
        '【直播模块】',
        'data 结构：{"official":[1条],"private":[1条]}，两边各恰好 1 个新直播间。',
        '直播字段：id,type(official|private),host,title,category,viewers,summary,segment,scenes,barrages,chats。barrages 必须是 8–16 个 {author:"观众昵称",content:"弹幕文字"} 对象；chats 必须是 5 个 {author:"观众昵称",content:"聊天文字"} 对象，禁止把文字再包进更深层对象。每个直播 4–8 个 scenes、8–16 条 barrages、5 条 chats。',
        'scene 为 {kind:narration|dialogue,segment,speaker,speakerRole,text}。官方直播大场景旁白更多，夹主持、采访或节目内容；私人直播主播说话更多，夹少量旁白。不要立绘、不要左右站位。',
        '',
    );
    if (selected.has('messages')) lines.push(
        '【通讯模块】',
        'data 结构：{"evidenceQuote":"从插件提供的通讯证据中原样选一条","conversations":[{"conversationId":"现有会话ID","messages":[{"sender":"发送者","fromUser":false,"type":"text|voice|image|redpacket|group_redpacket|location|sticker","content":"内容","duration":1,"amount":0,"recipient":"","count":0,"stickerName":""}]}]}。',
        '只能写入现有会话 ID；未建立联系人或群聊时宁可不选择 messages。每个会话可以生成 1–8 条围绕正文核心意思的自然连续消息，允许低风险补全，不得改变正文事实。',
        '',
    );
    return lines;
}

function buildWorldPrompt(request) {
    const sharedContext = [
        request.storyContext.storyFoundation,
        request.storyContext.activatedWorldInfo,
        request.storyContext.retrievedContext,
        request.storyContext.storyStatus,
        request.storyContext.characterDevelopment,
        request.storyContext.mapContext,
    ].filter(Boolean).join('\n\n').slice(0, 70_000);
    return [
        '根据玩家本轮输入与紧接着生成的 AI 正文，有选择地更新同一部虚构故事里的手机世界。四个功能共用下面的设定和信息边界，但本轮绝不能为了填满四个功能而全部生成。',
        '只输出 JSONL：每行一个完整 JSON 对象，不要 Markdown，不要解释。第一行必须是 decision，后面只输出本轮固定模块；未选模块连空结构也不要输出。',
        'decision 外壳：{"module":"decision","data":{"mode":"plot|daily","modules":["weibo|community|live|messages"]}}。内容模块外壳：{"module":"weibo","data":{...}}（替换模块名与 data）。每行必须能单独 JSON.parse，禁止跨行共用括号或逗号。',
        '',
        `【本轮固定模式】mode=${request.generationMode}；modules=${JSON.stringify(request.selectedModules)}。decision 必须逐字照此填写，不得自行增删或换模块。`,
        '【模式判定规则】',
        'A. 剧情模式 plot：只要本轮两楼中的任意一楼明确出现以下某类手机／公共平台内容就成立，并且只选择有直接依据的模块；出现几个选几个。messages=明确收发消息；weibo=明确出现微博、博文、热搜、转评赞或微博上的主角／角色信息；community=明确出现论坛、社区帖子、CP榜、同人内容或其中的主角／角色信息；live=明确出现开播、直播间、直播节目或直播中的主角／角色信息。普通线下剧情不能拿来充当平台内容。',
        'B. 单纯发生了适合传播的线下事件，不算平台依据。正文写旅行、吃饭、约会、争执、工作、地点或物品，不代表网友知道，也不允许据此生成相似主题的微博、社区或直播。',
        `C. 日常模式 daily：若四个模块都没有上述明确依据，modules 必须且只能是 ["${request.dailyModule}"]。这是插件随机指定的唯一背景模块；不得选择 messages，也不得自行换模块。`,
        'D. 日常模式内容必须与最新正文脱钩。不得借用本楼出现的地点、活动、职业、关系、物品或关键词换皮创作；从既有世界设定、玩家兴趣、当前公共内容之外的新虚构人物／作品／行业动态中独立生成，模拟世界自行运转。',
        'E. 剧情模式不追加随机背景模块；日常模式不生成任何剧情关联内容。',
        '',
        '【共同硬规则】',
        '1. 玩家本轮输入与 AI 本轮正文共同构成本轮新增事实；前者不能因为没有在后者中复述就被忽略。只按上面的模式判定更新，不得把“可能适合公开讨论”当作已经在平台出现。',
        '1a. 微博、社区和直播是独立运转的公共生态，不是主角专属应援墙。日常模式必须与主角和本轮正文无关。',
        '1b. “当前公共内容摘要”是查重清单，不是让你仿写的题库。新内容不得照抄已有标题，也不得重复已有 CP 的同一成员组合、同人梗或直播主题。',
        '2. 正文不是给大众看的全知档案。路人、网友、媒体、粉丝和普通工作人员只知道正文明确写成“已经公开、已经发布、已经播出、已经被拍到或已经在平台出现”的信息；模型知道不等于角色知道，更不等于大众知道。',
        '2a. 私下行程、临时去向、未公开缺席、室内行动、私人谈话、计划、关系、身体状况、公司内部处理和角色心里知道的事一律保密。不得用“网友发现了”“路人偶遇”“内部人士爆料”“有人猜到”绕过证据，也不得把私人事实换皮成恰好相似的热搜、帖子或弹幕。',
        '2b. 公司、公关、团队或角色有能力遮掩的异常，默认大众不知道；例如老板私下离开或缺席，正文没有明确写出对外曝光，就不能产生任何相关讨论。只有正文明确写出的公开口径可以成为公共平台事实。',
        '2c. 目击、传闻和猜测也必须由正文明确写明它已经发生在公共信息场中；不能由你自行创造一个目击者或爆料者。即便明确存在，仍须标清其未经证实，不能写成实锤。',
        '3. 数量、热度、点赞、转发、在线人数要符合人物身份和事件规模，不得整齐复制。所有评论和弹幕都必须紧贴各自内容。',
        '4. 已创建角色账号只是“可能刷到”的前提，不是自动发帖许可。只有本轮两楼明确写出该角色本人发帖／开播，或明确给出已经对外公开且适合由其账号回应的内容时，才允许生成角色账号内容；角色的私人动作、处境、缺席或行程绝不能自动变成角色发帖。仅提到名字不够。',
        `5. messages 最严格：这是玩家“${request.playerName || '（未取得玩家名）'}”本人的手机，只能记录玩家发给别人的消息，或别人发给玩家的消息。角色与第三人、两个 NPC、群体内部彼此之间的通讯，即使正文明确写出，也绝不能进入这台手机。详细写出内容，或只概括“姐姐发消息叫玩家下来吃饭”，都足以生成；没有明确发送行为或玩家不是收发一方，就不能生成 messages。`,
        '6. 插件已经从正文中锁定了允许生成的通讯证据。messages.evidenceQuote 从“插件锁定的通讯证据”中原样选一条；它只负责帮助你理解发送行为、方向和核心意思，不要求生成消息逐字照抄证据。正文写明玩家发给联系人时标记 fromUser=true；联系人发给玩家则为 false。电话通话、当面说话和单纯“传来声音”不属于聊天消息。',
        '6a. 正文不可能逐字记录完整聊天。必须在已有事实范围内把概述扩成自然通讯：可以补全语气、称呼、上下文衔接，以及不会改变剧情走向的紧邻回应。例如“姐姐给妹妹发消息说下来吃饭”应自然扩成“饭好了，快下来，菜要凉了”等完整表达，必要时可接“知道了，这就来”；严禁只机械输出“下来吃饭”四个字。',
        '6b. 扩写不能新增会影响线下剧情的秘密、决定、约定、冲突、行程、人物认知或强烈情绪，也不能让未建立的联系人出现。拿不准的细节保持日常、低风险，不改变正文结果。',
        '',
        ...buildSelectedModulePromptLines(request),
        request.selectedModules.includes('messages')
            ? `【插件锁定的通讯证据】\n${JSON.stringify(request.messageEvidence)}`
            : '',
        `【本轮两楼剧情（玩家输入 + AI 正文；只用于核对明确证据，它们本身绝不是公开信息）】\n${request.storyText}`,
        `【共同故事与世界设定（只用于保持世界观；其中的私人设定不得公开）】\n${sharedContext || '（无额外设定）'}`,
        `【现有手机会话】\n${JSON.stringify(request.conversations)}`,
        `【当前聊天身份】\n${JSON.stringify(request.messageProfile)}`,
        `【已创建角色公共账号】\n${JSON.stringify(request.roleAccounts)}`,
        `【玩家公开资料】\n${JSON.stringify(request.profile)}`,
        `【玩家兴趣】\n${JSON.stringify(request.interests)}`,
        `【当前公共内容摘要】\n${JSON.stringify(request.currentState)}`,
        `【当前时间戳】${request.now}`,
    ].join('\n');
}

function buildWorldRecoveryPrompt(request, missingModules) {
    const focused = { ...request, selectedModules: missingModules };
    return [
        '【格式补救】上一次回复没有交出下面这些必需内容模块。重新生成缺失模块；不得只返回 decision，不得解释、道歉或复述任务。',
        `必须补全：${JSON.stringify(missingModules)}。每个模块都要使用 {"module":"模块名","data":{...}} 单行 JSON 外壳。`,
        buildWorldPrompt(focused),
    ].join('\n\n');
}

function collectPartialItems(value, expected, label, warnings) {
    const items = (Array.isArray(value) ? value : [])
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .slice(0, expected);
    if (items.length !== expected) warnings.push(`${label}返回了 ${items.length} 条，已保留可用内容。`);
    return items;
}

function notePartialComments(items, field, label, warnings) {
    items.forEach((item, index) => {
        const count = Array.isArray(item?.[field]) ? item[field].length : 0;
        if (count !== 5) warnings.push(`第 ${index + 1} 条${label}返回了 ${count} 条热评，已保留可用评论。`);
    });
}

function applyCommunityModule(settings, data, sourceKey, now) {
    const state = normalizePhoneCommunityState(settings);
    const warnings = [];
    const forum = collectPartialItems(data?.forumThreads, 3, '论坛更新', warnings);
    const cp = collectPartialItems(data?.cpRankings, 3, 'CP榜更新', warnings);
    const fanworks = collectPartialItems(data?.fanWorks, 3, '同人区更新', warnings);
    notePartialComments(forum, 'comments', '论坛', warnings);
    notePartialComments(cp, 'comments', 'CP榜', warnings);
    notePartialComments(fanworks, 'commentsList', '同人', warnings);
    const occupiedIds = new Set([
        ...state.forumThreads.map(item => item.id),
        ...state.cpRankings.map(item => item.id),
        ...state.fanWorks.map(item => item.id),
    ]);
    const stamp = (items, prefix) => items.map((item, index) => {
        let id = text(item?.id, 120) || `${prefix}-${now}-${index + 1}`;
        if (occupiedIds.has(id)) id = makeId(prefix);
        occupiedIds.add(id);
        return {
            ...item,
            id,
            generatedAt: now - index,
            generationSourceKey: sourceKey,
        };
    });
    settings.phone.community = {
        ...state,
        forumThreads: [...stamp(forum, 'forum'), ...state.forumThreads].slice(0, COMMUNITY_LIMIT),
        cpRankings: [...stamp(cp, 'cp'), ...state.cpRankings].slice(0, COMMUNITY_LIMIT),
        fanWorks: [...stamp(fanworks, 'fanwork'), ...state.fanWorks].slice(0, COMMUNITY_LIMIT),
    };
    const normalized = normalizePhoneCommunityState(settings);
    normalized.cpRankings.sort((left, right) => Number(left.rank || 999) - Number(right.rank || 999));
    normalized.cpRankings.forEach((item, index) => { item.rank = index + 1; });
    return {
        communityForum: normalized.forumThreads.filter(item => item.generationSourceKey === sourceKey).map(item => item.id),
        communityCp: normalized.cpRankings.filter(item => item.generationSourceKey === sourceKey).map(item => item.id),
        communityFanwork: normalized.fanWorks.filter(item => item.generationSourceKey === sourceKey).map(item => item.id),
        warnings,
    };
}

function applyLiveModule(settings, data, sourceKey, now) {
    const state = normalizePhoneLiveState(settings);
    const warnings = [];
    const official = collectPartialItems(data?.official, 1, '官方直播更新', warnings);
    const privateStreams = collectPartialItems(data?.private, 1, '私人直播更新', warnings);
    const occupiedIds = new Set(state.streams.map(item => item.id));
    const generated = [...official.map(item => ({ ...item, type: 'official' })), ...privateStreams.map(item => ({ ...item, type: 'private' }))]
        .map((item, index) => {
            const sceneCount = Array.isArray(item.scenes) ? item.scenes.length : 0;
            const barrageCount = Array.isArray(item.barrages) ? item.barrages.length : 0;
            if (sceneCount < 4) warnings.push(`“${text(item.title, 80) || `第 ${index + 1} 场直播`}”只有 ${sceneCount} 个画面阶段。`);
            if (barrageCount < 8) warnings.push(`“${text(item.title, 80) || `第 ${index + 1} 场直播`}”只有 ${barrageCount} 条弹幕。`);
            let id = text(item.id, 120) || `live-${now}-${index + 1}`;
            if (occupiedIds.has(id)) id = makeId('live');
            occupiedIds.add(id);
            return {
                ...item,
                id,
                generatedAt: now - index,
                generationSourceKey: sourceKey,
            };
        });
    const combined = [...generated, ...state.streams];
    settings.phone.live = {
        ...state,
        streams: [
            ...combined.filter(item => item.type === 'official').slice(0, LIVE_OFFICIAL_LIMIT),
            ...combined.filter(item => item.type === 'private').slice(0, LIVE_PRIVATE_LIMIT),
        ],
    };
    const normalized = normalizePhoneLiveState(settings);
    return {
        live: normalized.streams.filter(item => item.generationSourceKey === sourceKey).map(item => item.id),
        warnings,
    };
}

function applyMessagesModule(store, data, messageEvidence, sourceKey) {
    const conversations = Array.isArray(data?.conversations) ? data.conversations : [];
    if (conversations.length === 0) return { messages: [] };
    if (!Array.isArray(messageEvidence) || messageEvidence.length === 0) {
        throw new Error('插件没有在正文中找到明确的聊天消息发送证据。');
    }
    const appended = [];
    for (const value of conversations) {
        const conversation = store.conversations.find(item => item.id === text(value?.conversationId, 120));
        if (!conversation) continue;
        const roundId = createPhoneRoundId();
        for (const message of (Array.isArray(value?.messages) ? value.messages : []).slice(0, 8)) {
            const requestedSender = text(message?.sender, 80);
            const fromUser = message?.fromUser === true
                || message?.direction === 'outgoing'
                || requestedSender === text(store.profile?.nickname, 80);
            const saved = appendPhoneMessage(store, conversation.id, {
                ...message,
                id: makeId('story-phone-message'),
                sender: fromUser ? text(store.profile?.nickname, 80) || '我' : requestedSender || conversation.name,
                roundId,
                fromUser,
                queued: false,
                storyPending: false,
                timestamp: Date.now() + appended.length,
                generationSourceKey: sourceKey,
            });
            if (saved) appended.push(saved.id);
        }
    }
    return { messages: appended };
}

function removeWeiboItems(state, messageId) {
    const batches = (state.generationBatches ?? []).filter(batch => String(batch.messageId) === String(messageId));
    const postIds = new Set(batches.flatMap(batch => batch.postIds ?? []));
    const topicIds = new Set(batches.flatMap(batch => batch.hotTopicIds ?? []));
    const followerDelta = batches.reduce((sum, batch) => sum + (Number(batch.followerDelta) || 0), 0);
    state.posts = (state.posts ?? []).filter(post => !postIds.has(post.id));
    state.feedPostIds = (state.feedPostIds ?? []).filter(id => !postIds.has(id));
    state.hotTopics = (state.hotTopics ?? []).filter(topic => !topicIds.has(topic.id) && !postIds.has(topic.postId));
    state.commentReplies = (state.commentReplies ?? []).filter(reply => !postIds.has(reply.postId));
    state.likedPostIds = (state.likedPostIds ?? []).filter(id => !postIds.has(id));
    state.generationBatches = (state.generationBatches ?? []).filter(batch => String(batch.messageId) !== String(messageId));
    state.followerCount = Math.max(0, Number(state.followerCount || 0) - followerDelta);
}

function removeTrackedItems(store, settings, batch) {
    const ids = batch?.items ?? {};
    const community = normalizePhoneCommunityState(settings);
    const remove = values => new Set(Array.isArray(values) ? values : []);
    const forum = remove(ids.communityForum);
    const cp = remove(ids.communityCp);
    const fanwork = remove(ids.communityFanwork);
    community.forumThreads = community.forumThreads.filter(item => !forum.has(item.id));
    community.cpRankings = community.cpRankings.filter(item => !cp.has(item.id));
    community.fanWorks = community.fanWorks.filter(item => !fanwork.has(item.id));
    const live = normalizePhoneLiveState(settings);
    const liveIds = remove(ids.live);
    live.streams = live.streams.filter(item => !liveIds.has(item.id));
    const messageIds = remove(ids.messages);
    for (const conversation of store.conversations) {
        conversation.messages = conversation.messages.filter(message => !messageIds.has(message.id));
        const remainingRounds = new Set(conversation.messages.map(message => message.roundId));
        conversation.rounds = (conversation.rounds ?? []).filter(round => remainingRounds.has(round.id));
    }
    removeWeiboItems(settings.phone.weibo ?? {}, batch.messageId);
}

export function removePhoneWorldStoryBatch(store, settings, messageId) {
    const batches = (store.storyBatches ?? []).filter(batch => String(batch.messageId) === String(messageId));
    batches.forEach(batch => removeTrackedItems(store, settings, batch));
    store.storyBatches = (store.storyBatches ?? []).filter(batch => String(batch.messageId) !== String(messageId));
    return batches.length;
}

async function performPhoneWorldStoryUpdate(phoneSession, context, messageId, options = {}) {
    if (!phoneSession || !isPhoneWeiboAiReady(phoneSession.settings)) throw new Error('请先配置弹幕/手机共用的 API。');
    const store = await phoneSession.ensure();
    const settings = phoneSession.settings;
    const message = context?.chat?.[Number(messageId)];
    if (!message || message.is_user) return { skipped: true };
    const assistantStory = storyText(message);
    if (!assistantStory) return { skipped: true };
    const latestStory = buildPhoneStoryTurnText(context, messageId) || assistantStory;
    const swipeIndex = selectedSwipeIndex(message);
    const chatId = getPhoneChatId(context);
    const sourceKey = phoneWorldSourceKey(context, messageId, message);
    if (options.force !== true && store.storyBatches?.some(batch => batch.sourceKey === sourceKey)) {
        return { duplicate: true };
    }

    const startedAt = Date.now();
    store.worldGeneration = {
        status: 'generating',
        messageId: String(messageId),
        swipeIndex,
        sourceKey,
        modules: [],
        warnings: [],
        lastError: '',
        startedAt,
        completedAt: 0,
        dismissed: false,
    };
    try {
    removePhoneWorldStoryBatch(store, settings, messageId);
    await phoneSession.save();
    announceWorldGeneration(store.worldGeneration);

    const playerName = text(context?.name1, 80);
    const messageEvidence = extractPhoneMessageEvidence(latestStory, playerName);
    const plotModules = detectPhoneWorldPlotModules(latestStory, { playerName, messageEvidence });
    const generationMode = plotModules.length > 0 ? 'plot' : 'daily';
    const dailyModule = selectDailyPhoneWorldModule(options.random);
    const selectedModules = plotModules.length > 0 ? plotModules : [dailyModule];
    const recentStory = generationMode === 'plot'
        ? (Array.isArray(context.chat) ? context.chat : []).slice(-6)
            .map(item => text(item?.mes, 5000)).filter(Boolean)
        : [];
    const snapshot = {
        conversation: { id: 'phone-world', name: '手机公共世界', type: 'group' },
        messages: [],
        messageRecords: [],
        activeMemory: store.onlineMemory?.events ?? [],
    };
    const preparedContext = generationMode === 'plot'
        ? await preparePhoneStoryContext({
            settings,
            context,
            snapshot,
            store,
            recentStory,
            includePhoneMemory: false,
        }, options.contextClients ?? {})
        : {
            storyFoundation: inferPhonePublicWorldFrame(context),
            retrievedContext: '',
            activatedWorldInfo: '',
            phoneMemoryContext: '',
            storyStatus: '',
            characterDevelopment: '',
            mapContext: '',
        };
    const weiboRequest = buildPhoneWeiboAiRequest(settings, context, {
        mode: settings.phone?.weibo?.initialized ? 'story' : 'bootstrap',
        messageId: String(messageId),
        swipeIndex,
        sourceKey,
        storyText: latestStory,
    });
    const request = {
        storyText: generationMode === 'plot'
            ? latestStory
            : '（本轮没有明确的公开平台事件。不得从最新私人正文或历史私人剧情取材。）',
        storyContext: preparedContext,
        conversations: generationMode === 'plot' ? store.conversations.map(conversation => ({
            id: conversation.id,
            type: conversation.type,
            name: conversation.name,
            members: conversation.members,
            identity: conversation.identity,
            memberIdentities: conversation.memberIdentities,
        })) : [],
        roleAccounts: generationMode === 'plot' ? summarizeDirectory(settings) : [],
        profile: generationMode === 'plot' ? weiboRequest.profile : {},
        interests: weiboRequest.interests,
        currentState: summarizeCurrentState(settings),
        messageProfile: generationMode === 'plot' ? settings.phone?.profile ?? store.profile : {},
        weiboMode: weiboRequest.mode,
        dailyModule,
        now: Date.now(),
        generationMode,
        selectedModules,
        messageEvidence,
        playerName,
    };
    const generate = options.generate ?? generatePhoneWorldCompletion;
    const response = await generate({
        barrage: settings.apis.barrage,
        maxTokens: getPhoneWorldOutputTokenBudget(request.selectedModules),
        prompt: buildWorldPrompt(request),
    }, { signal: options.signal });
    let parsed;
    let initialParseError = null;
    try {
        parsed = parsePhoneWorldRecords(response?.content);
    } catch (error) {
        initialParseError = error;
        parsed = { records: new Map(), errors: [], decision: null };
    }
    const recoveryWarnings = [];
    let missingModules = selectedModules.filter(module => !parsed.records.has(module));
    if (missingModules.length > 0) {
        try {
            const recoveryResponse = await generate({
                barrage: settings.apis.barrage,
                maxTokens: getPhoneWorldOutputTokenBudget(missingModules),
                prompt: buildWorldRecoveryPrompt(request, missingModules),
            }, { signal: options.signal });
            const recovered = parsePhoneWorldRecords(recoveryResponse?.content);
            for (const module of missingModules) {
                if (recovered.records.has(module)) parsed.records.set(module, recovered.records.get(module));
            }
            parsed.decision ??= recovered.decision;
            parsed.errors.push(...recovered.errors);
            missingModules = selectedModules.filter(module => !parsed.records.has(module));
            if (missingModules.length === 0) recoveryWarnings.push('首次返回缺少内容模块，已自动补全。');
        } catch (error) {
            if (parsed.records.size === 0) {
                const original = initialParseError?.message || '手机世界 API 没有返回可用的模块记录';
                throw new Error(`${original}；自动补救仍失败：${error.message}`);
            }
            recoveryWarnings.push(`缺失模块自动补救失败：${error.message}`);
        }
    }
    if (!isCurrentPhoneWorldSource(context, messageId, sourceKey)) {
        return { stale: true, reason: 'superseded-story-candidate' };
    }
    const appliedModules = [];
    const items = {};
    const moduleErrors = [];
    const moduleWarnings = [
        ...recoveryWarnings,
        ...parsed.errors.map(error => `外层记录已跳过：${error.message}`),
    ];
    const decisionMode = parsed.decision?.mode === 'plot' ? 'plot'
        : parsed.decision?.mode === 'daily' ? 'daily' : '';
    const reportedModules = [...new Set((Array.isArray(parsed.decision?.modules) ? parsed.decision.modules : [])
        .map(item => text(item, 40)).filter(item => WORLD_MODULES.includes(item)))];
    if (decisionMode !== request.generationMode
        || JSON.stringify(reportedModules) !== JSON.stringify(selectedModules)) {
        moduleWarnings.push('返回的模式判定与正文证据不一致，已按插件判定过滤。');
    }
    for (const module of [...parsed.records.keys()]) {
        if (!selectedModules.includes(module)) {
            parsed.records.delete(module);
            moduleWarnings.push(`已忽略未被模式判定选中的 ${module} 模块。`);
        }
    }
    for (const module of selectedModules) {
        if (!parsed.records.has(module)) moduleWarnings.push(`本轮选中的 ${module} 模块没有返回内容。`);
    }

    const weiboData = parsed.records.get('weibo');
    if (weiboData) {
        try {
            const partialRequest = { ...weiboRequest, allowPartial: true };
            const batch = parsePhoneWeiboAiBatch(JSON.stringify(weiboData), partialRequest);
            const existingPostIds = new Set((settings.phone.weibo?.posts ?? []).map(post => post.id));
            const conflictingPostIds = new Set(batch.posts.filter(post => existingPostIds.has(post.id)).map(post => post.id));
            if (conflictingPostIds.size > 0) {
                batch.posts = batch.posts.filter(post => !conflictingPostIds.has(post.id));
                batch.hotTopics = batch.hotTopics.filter(topic => !conflictingPostIds.has(topic.postId));
                batch.validationWarnings.push(`有 ${conflictingPostIds.size} 条微博 ID 与旧内容重复，已单独跳过。`);
            }
            applyPhoneWeiboBatch(settings.phone.weibo, batch, weiboRequest);
            items.weibo = batch.posts.map(post => post.id);
            moduleWarnings.push(...batch.validationWarnings.map(message => `weibo：${message}`));
            if (items.weibo.length > 0) appliedModules.push('weibo');
            else moduleWarnings.push('weibo：没有生成可保存的新帖子。');
        } catch (error) {
            moduleErrors.push({ module: 'weibo', error });
        }
    }
    const communityData = parsed.records.get('community');
    if (communityData) {
        try {
            const { warnings, ...communityItems } = applyCommunityModule(settings, communityData, sourceKey, request.now);
            Object.assign(items, communityItems);
            moduleWarnings.push(...warnings.map(message => `community：${message}`));
            const communityCount = Object.values(communityItems).reduce((total, values) => total + values.length, 0);
            if (communityCount > 0) appliedModules.push('community');
            else moduleWarnings.push('community：没有生成可保存的新内容。');
        } catch (error) {
            moduleErrors.push({ module: 'community', error });
        }
    }
    const liveData = parsed.records.get('live');
    if (liveData) {
        try {
            const { warnings, ...liveItems } = applyLiveModule(settings, liveData, sourceKey, request.now);
            Object.assign(items, liveItems);
            moduleWarnings.push(...warnings.map(message => `live：${message}`));
            if (liveItems.live.length > 0) appliedModules.push('live');
            else moduleWarnings.push('live：没有生成可保存的新直播。');
        } catch (error) {
            moduleErrors.push({ module: 'live', error });
        }
    }
    const messageData = parsed.records.get('messages');
    if (messageData) {
        try {
            const messageItems = applyMessagesModule(store, messageData, request.messageEvidence, sourceKey);
            Object.assign(items, messageItems);
            if (messageItems.messages.length > 0) appliedModules.push('messages');
            else moduleWarnings.push('messages：没有找到可写入的现有会话。');
        } catch (error) {
            moduleErrors.push({ module: 'messages', error });
        }
    }
    if (appliedModules.length === 0) {
        const details = [
            ...moduleErrors.map(item => `${item.module}: ${item.error.message}`),
            ...moduleWarnings,
        ].join('；');
        throw new Error(`手机世界更新没有可保存的模块${details ? `（${details}）` : ''}`);
    }
    store.storyBatches.push({
        sourceKey,
        messageId: String(messageId),
        swipeIndex,
        modules: appliedModules,
        items,
        createdAt: request.now,
    });
    store.worldGeneration = {
        status: moduleErrors.length > 0 || moduleWarnings.length > 0 ? 'partial' : 'ready',
        messageId: String(messageId),
        swipeIndex,
        sourceKey,
        modules: appliedModules,
        warnings: [
            ...moduleWarnings,
            ...moduleErrors.map(item => `${item.module}：${item.error.message}`),
        ],
        lastError: '',
        startedAt,
        completedAt: Date.now(),
        dismissed: false,
    };
    await phoneSession.save();
    announceWorldGeneration(store.worldGeneration);
    if (moduleErrors.length > 0) {
        console.warn('[Memory Augment] 手机世界部分模块未通过校验，其他模块已独立保存。', moduleErrors);
    }
    globalThis.dispatchEvent?.(new CustomEvent('memory-augment-phone-world-updated', {
        detail: { messageId, swipeIndex, modules: appliedModules },
    }));
    if (appliedModules.includes('weibo')) {
        globalThis.dispatchEvent?.(new CustomEvent('memory-augment-weibo-updated', {
            detail: { mode: 'story', messageId, swipeIndex },
        }));
    }
    return { modules: appliedModules, moduleErrors, moduleWarnings };
    } catch (error) {
        if (options.signal?.aborted) return { stale: true, reason: 'superseded-story-candidate' };
        store.worldGeneration = {
            status: 'error',
            messageId: String(messageId),
            swipeIndex,
            sourceKey,
            modules: [],
            warnings: [],
            lastError: text(error?.message ?? error, 1000),
            startedAt,
            completedAt: Date.now(),
            dismissed: false,
        };
        try {
            await phoneSession.save();
            announceWorldGeneration(store.worldGeneration);
        } catch (saveError) {
            console.warn('[Memory Augment] 手机世界失败状态保存失败。', saveError);
        }
        throw error;
    }
}

export function requestPhoneWorldStoryUpdate(phoneSession, context, messageId, options = {}) {
    const message = context?.chat?.[Number(messageId)];
    const latestStory = storyText(message);
    if (!phoneSession || !message || message.is_user || !latestStory) {
        return performPhoneWorldStoryUpdate(phoneSession, context, messageId, options);
    }
    const sourceKey = phoneWorldSourceKey(context, messageId, message);
    if (worldUpdateInFlight.has(sourceKey)) return worldUpdateInFlight.get(sourceKey);
    abortSupersededPhoneWorldUpdates(context, messageId);
    const controller = new AbortController();
    const task = performPhoneWorldStoryUpdate(phoneSession, context, messageId, {
        ...options,
        signal: controller.signal,
    }).finally(() => {
        worldUpdateInFlight.delete(sourceKey);
        worldUpdateControllers.delete(sourceKey);
    });
    worldUpdateInFlight.set(sourceKey, task);
    worldUpdateControllers.set(sourceKey, controller);
    return task;
}

export function initializePhoneWorldLifecycle(phoneSession, context = globalThis.SillyTavern?.getContext?.()) {
    if (lifecycleBound || !context?.eventSource) return false;
    const eventTypes = { ...(context.event_types ?? {}), ...(context.eventTypes ?? {}) };
    const rendered = eventTypes.CHARACTER_MESSAGE_RENDERED;
    if (!rendered) return false;
    let generationActive = false;
    let generationStopped = false;
    let initialCount = Array.isArray(context.chat) ? context.chat.length : 0;
    const enqueue = messageId => {
        const liveContext = globalThis.SillyTavern?.getContext?.() ?? context;
        abortSupersededPhoneWorldUpdates(liveContext, messageId);
        updateQueue = updateQueue.catch(() => undefined).then(async () => {
            const current = globalThis.SillyTavern?.getContext?.() ?? context;
            try {
                await requestPhoneWorldStoryUpdate(phoneSession, current, messageId);
            } catch (error) {
                console.warn('[Memory Augment] 手机世界正文更新失败，已保留其他存档内容。', error);
            }
        });
    };
    if (eventTypes.GENERATION_STARTED) context.eventSource.on(eventTypes.GENERATION_STARTED, () => {
        generationActive = true;
        generationStopped = false;
    });
    if (eventTypes.GENERATION_STOPPED) context.eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        generationActive = false;
        generationStopped = true;
    });
    if (eventTypes.GENERATION_ENDED) context.eventSource.on(eventTypes.GENERATION_ENDED, () => {
        generationActive = false;
        if (generationStopped) {
            generationStopped = false;
            return;
        }
        const current = globalThis.SillyTavern?.getContext?.() ?? context;
        enqueue(Math.max(0, (current.chat?.length ?? 1) - 1));
    });
    context.eventSource.on(rendered, messageId => {
        if (!generationActive && Number(messageId) < initialCount) return;
        generationActive = false;
        generationStopped = false;
        enqueue(messageId);
    });
    const cleanDeleted = async messageId => {
        try {
            const current = globalThis.SillyTavern?.getContext?.() ?? context;
            abortSupersededPhoneWorldUpdates(current, messageId, { fromMessageId: true });
            const store = await phoneSession.ensure();
            const deletedFrom = Math.max(0, Math.trunc(Number(messageId) || 0));
            const staleMessageIds = [...new Set((store.storyBatches ?? [])
                .map(batch => batch.messageId)
                .filter(id => Number(id) >= deletedFrom))];
            const removed = staleMessageIds.reduce((total, id) => (
                total + removePhoneWorldStoryBatch(store, phoneSession.settings, id)
            ), 0);
            if (removed > 0) {
                await phoneSession.save();
                const modules = [...WORLD_MODULES];
                globalThis.dispatchEvent?.(new CustomEvent('memory-augment-phone-world-updated', { detail: { messageId, modules } }));
                globalThis.dispatchEvent?.(new CustomEvent('memory-augment-weibo-updated', { detail: { messageId } }));
            }
        } catch (error) {
            console.warn('[Memory Augment] 删除正文时清理手机世界批次失败。', error);
        }
    };
    if (eventTypes.MESSAGE_DELETED) context.eventSource.on(eventTypes.MESSAGE_DELETED, messageId => void cleanDeleted(messageId));
    if (eventTypes.MESSAGE_SWIPED) context.eventSource.on(eventTypes.MESSAGE_SWIPED, messageId => enqueue(messageId));
    if (eventTypes.MESSAGE_EDITED) context.eventSource.on(eventTypes.MESSAGE_EDITED, messageId => enqueue(messageId));
    if (eventTypes.MESSAGE_UPDATED) context.eventSource.on(eventTypes.MESSAGE_UPDATED, messageId => enqueue(messageId));
    if (eventTypes.CHAT_CHANGED) context.eventSource.on(eventTypes.CHAT_CHANGED, () => {
        for (const controller of worldUpdateControllers.values()) controller.abort();
        generationActive = false;
        generationStopped = false;
        phoneSession.invalidate();
        const current = globalThis.SillyTavern?.getContext?.() ?? context;
        initialCount = Array.isArray(current.chat) ? current.chat.length : 0;
    });
    lifecycleBound = true;
    return true;
}
