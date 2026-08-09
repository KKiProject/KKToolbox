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

let lifecycleBound = false;
let updateQueue = Promise.resolve();

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

function selectedSwipeIndex(message = {}) {
    const swipes = Array.isArray(message.swipes) ? message.swipes : [];
    const value = Math.trunc(Number(message.swipe_id));
    return value >= 0 && value < swipes.length ? value : 0;
}

function storyText(message = {}) {
    const index = selectedSwipeIndex(message);
    return text(message?.swipes?.[index] ?? message?.mes ?? message?.content, 30_000);
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
    for (const candidate of scanJsonObjects(raw)) {
        try {
            const parsed = JSON.parse(candidate);
            const module = text(parsed?.module, 40);
            if (!WORLD_MODULES.includes(module) || !parsed?.data || records.has(module)) continue;
            records.set(module, parsed.data);
        } catch (error) {
            errors.push(error);
        }
    }
    if (records.size === 0) {
        const detail = errors[0]?.message ? `：${errors[0].message}` : '';
        throw new Error(`手机世界 API 没有返回可用的模块记录${detail}`);
    }
    return { records, errors };
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
    return {
        community: {
            forum: community.forumThreads.slice(0, 12).map(item => `${item.title}｜${item.excerpt}`),
            cp: community.cpRankings.slice(0, 15).map(item => `${item.name}｜${item.pairing}｜${item.weekly}`),
            fanworks: community.fanWorks.slice(0, 12).map(item => `${item.cpName}｜${item.title}`),
        },
        live: live.streams.slice(0, 15).map(item => `${item.type}｜${item.host}｜${item.title}｜${item.summary}`),
    };
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
        '根据最新正文更新同一部虚构故事里的手机世界。四个功能共用下面的设定、信息边界和正文，不要把它们当成彼此无关的世界。',
        '只输出 JSONL：每个模块恰好一行一个完整 JSON 对象，不要 Markdown，不要解释。某模块没有内容也必须按规则返回空结构。',
        '四行的 module 依次为 weibo、community、live、messages；每一行都必须能单独 JSON.parse，禁止跨行共用括号或逗号。',
        '',
        '【共同硬规则】',
        '1. 最新正文是本轮唯一新增事实。相关公开内容优先承接正文；没有适合公开生成的内容时，微博、社区和直播仍要用既有设定生成自然的世界背景动态。',
        '2. 路人只知道公开可见的信息。私人场景不得凭空泄露；目击、传闻、猜测必须明确标成目击、传闻或猜测，不能写成实锤。',
        '3. 数量、热度、点赞、转发、在线人数要符合人物身份和事件规模，不得整齐复制。所有评论和弹幕都必须紧贴各自内容。',
        '4. 已创建角色账号才允许以该角色账号发微博；且最新正文必须明确给出该角色动作或处境依据。仅提到名字不够。',
        '5. messages 最严格：只有最新正文明确写明某人发来／发出消息时才能生成。详细写出内容或只写“发来消息后被看了一眼”都算；没有明确发送行为就必须返回空 conversations。',
        '6. messages.evidenceQuote 必须逐字摘自最新正文并直接证明消息确实发送或到达。插件会逐字核对；禁止根据人设或剧情需要偷偷补消息。',
        '',
        '【微博模块】',
        'data 必须使用结构：{"posts":[{"id":"唯一ID","authorType":"npc|role","authorId":"角色账号ID或空","author":"公开昵称","badge":"身份标签","tone":"rose","kind":"original","content":"正文","topics":[],"customTopics":[],"imageDescription":"可空","location":"可空","mentions":[],"source":null,"createdAt":0,"metrics":{"reposts":0,"comments":0,"likes":0},"storyEvidence":"角色帖的正文逐字依据，否则为空","hotComments":[{"id":"唯一ID","author":"网友昵称","content":"相关热评","likes":0,"createdAt":0,"tone":"violet"}]}],"hotTopics":[{"id":"唯一ID","title":"热搜标题","postId":"本批帖子ID","heat":0,"mark":"爆|沸|热|新|"}],"reply":null,"followerDelta":0,"followerReason":""}。',
        '生成 5–8 条新首页帖子。每帖字段与既有微博一致，并恰好带 5 条高度相关的 hotComments。热搜只指向本批真实 postId；不要求所有新帖上榜。',
        request.weiboMode === 'bootstrap'
            ? '这是该存档首次初始化：根据玩家设定给出合理的初始粉丝基线，followerDelta 必须是大于 0 的初始总量；普通人通常个位或十位，名人按设定可达百万千万。'
            : 'followerDelta 只是本轮增减量；只有玩家或角色相关公开事件才调整，普通互动小幅变化，爆款或名人事件才可明显变化。',
        '角色帖 authorType=role、authorId 使用角色账号 ID，并填写正文逐字依据 storyEvidence；无资格则用 npc 世界背景帖补足。',
        '',
        '【社区模块】',
        'data 结构：{"forumThreads":[3条],"cpRankings":[3条],"fanWorks":[3条]}。三个板块各生成恰好 3 条，每条恰好 5 条相关热评。',
        '论坛字段：id,category,tag,time,title,excerpt,body,author,views,replies,comments。内容可为匿名爆料、扒帖、角色讨论、粉圈争执或剧情分析。',
        'CP榜字段：id,rank,name,kind(directional|group|pun|allx),kindLabel,left,right,pairing,members,target,series,trend(new|up|down|same),change,heat,weekly,comments。榜名是 CP 名，不是作品名。',
        '左右逆序是两对不同 CP，绝不能合并 tag。普通左右名、关系型“xx组”、姓名谐音梗和 all× 要自然混排；“xx组”按关系命名，不是在左右名后机械加“组”，并明确所属作品。',
        '同人字段：id,type(article|art|video|au|discussion),typeLabel,title,creator,cpName,pairing,series,characters,tags,time,likes,comments,summary,preview,commentsList。',
        '同人区每条必须带 tags，至少含作品名、两位角色名和唯一 CP 名。逆家不得共用 CP tag；一对 CP 只给一个 CP 名。图、剪辑、视频只写文字描述；同人文 preview 约一百字后自然省略。',
        '',
        '【直播模块】',
        'data 结构：{"official":[1条],"private":[1条]}，两边各恰好 1 个新直播间。',
        '直播字段：id,type(official|private),host,title,category,viewers,summary,segment,scenes,barrages,chats。每个直播 4–8 个 scenes、8–16 条 barrages、5 条 chats。',
        'scene 为 {kind:narration|dialogue,segment,speaker,speakerRole,text}。官方直播大场景旁白更多，夹主持、采访或节目内容；私人直播主播说话更多，夹少量旁白。不要立绘、不要左右站位。',
        '',
        '【通讯模块】',
        'data 结构：{"evidenceQuote":"正文逐字证据或空","conversations":[{"conversationId":"现有会话ID","messages":[{"sender":"发送者","type":"text|voice|image|redpacket|group_redpacket|location|sticker","content":"内容","duration":1,"amount":0,"recipient":"","count":0,"stickerName":""}]}]}。',
        '只能写入现有会话 ID；未建立联系人或群聊时宁可不显示。内容可以对正文明确写出的消息适度展开，但不得改变正文事实或补写未发送的消息。',
        '',
        `【最新正文】\n${request.storyText}`,
        `【共同故事与世界设定】\n${sharedContext || '（无额外设定）'}`,
        `【现有手机会话】\n${JSON.stringify(request.conversations)}`,
        `【已创建角色公共账号】\n${JSON.stringify(request.roleAccounts)}`,
        `【玩家公开资料】\n${JSON.stringify(request.profile)}`,
        `【玩家兴趣】\n${JSON.stringify(request.interests)}`,
        `【当前公共内容摘要】\n${JSON.stringify(request.currentState)}`,
        `【当前时间戳】${request.now}`,
    ].join('\n');
}

function requireArray(value, length, label) {
    if (!Array.isArray(value) || value.length !== length) throw new Error(`${label}必须恰好有 ${length} 条。`);
    return value;
}

function requireFiveComments(item, field, label) {
    const comments = item?.[field];
    if (!Array.isArray(comments) || comments.length !== 5) throw new Error(`${label}必须恰好有 5 条热评。`);
}

function applyCommunityModule(settings, data, sourceKey, now) {
    const state = normalizePhoneCommunityState(settings);
    const forum = requireArray(data?.forumThreads, 3, '论坛更新');
    const cp = requireArray(data?.cpRankings, 3, 'CP榜更新');
    const fanworks = requireArray(data?.fanWorks, 3, '同人区更新');
    forum.forEach((item, index) => requireFiveComments(item, 'comments', `第 ${index + 1} 条论坛`));
    cp.forEach((item, index) => requireFiveComments(item, 'comments', `第 ${index + 1} 条CP榜`));
    fanworks.forEach((item, index) => requireFiveComments(item, 'commentsList', `第 ${index + 1} 条同人`));
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
    };
}

function applyLiveModule(settings, data, sourceKey, now) {
    const state = normalizePhoneLiveState(settings);
    const official = requireArray(data?.official, 1, '官方直播更新');
    const privateStreams = requireArray(data?.private, 1, '私人直播更新');
    const occupiedIds = new Set(state.streams.map(item => item.id));
    const generated = [...official.map(item => ({ ...item, type: 'official' })), ...privateStreams.map(item => ({ ...item, type: 'private' }))]
        .map((item, index) => {
            if (!Array.isArray(item.scenes) || item.scenes.length < 4) throw new Error('新直播至少需要 4 个画面阶段。');
            if (!Array.isArray(item.barrages) || item.barrages.length < 8) throw new Error('新直播至少需要 8 条弹幕。');
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
    return { live: normalized.streams.filter(item => item.generationSourceKey === sourceKey).map(item => item.id) };
}

function applyMessagesModule(store, data, story, sourceKey) {
    const conversations = Array.isArray(data?.conversations) ? data.conversations : [];
    if (conversations.length === 0) return { messages: [] };
    const evidence = text(data?.evidenceQuote, 500);
    if (!evidence || !story.includes(evidence)) throw new Error('通讯模块没有提供正文中真实存在的发送证据。');
    const explicitTransfer = /(发来|发去|发出|发送|传来|收到|收到了|回了|回复了|信息|消息|短信|私信|微信|群里).{0,24}(消息|信息|短信|私信|微信|发|回复|弹出|跳出|送达|响|亮|一句|说|：|:)|(?:消息|信息|短信|私信|微信|群里).{0,24}(发来|发去|发出|发送|传来|收到|回复|弹出|跳出|送达|响|亮)|给.{1,20}发(?:了|去|出|送)/u;
    if (!explicitTransfer.test(evidence)) throw new Error('通讯证据没有明确表明消息已发送或到达。');
    const appended = [];
    for (const value of conversations) {
        const conversation = store.conversations.find(item => item.id === text(value?.conversationId, 120));
        if (!conversation) continue;
        const roundId = createPhoneRoundId();
        for (const message of (Array.isArray(value?.messages) ? value.messages : []).slice(0, 8)) {
            const saved = appendPhoneMessage(store, conversation.id, {
                ...message,
                id: makeId('story-phone-message'),
                roundId,
                fromUser: false,
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

export async function requestPhoneWorldStoryUpdate(phoneSession, context, messageId, options = {}) {
    if (!phoneSession || !isPhoneWeiboAiReady(phoneSession.settings)) throw new Error('请先配置弹幕/手机共用的 API。');
    const store = await phoneSession.ensure();
    const settings = phoneSession.settings;
    const message = context?.chat?.[Number(messageId)];
    if (!message || message.is_user) return { skipped: true };
    const latestStory = storyText(message);
    if (!latestStory) return { skipped: true };
    const swipeIndex = selectedSwipeIndex(message);
    const chatId = getPhoneChatId(context);
    const sourceKey = `${chatId}:${messageId}:${swipeIndex}:${hashText(latestStory)}:phone-world`;
    if (store.storyBatches?.some(batch => batch.sourceKey === sourceKey)) return { duplicate: true };

    removePhoneWorldStoryBatch(store, settings, messageId);
    await phoneSession.save();

    const recentStory = (Array.isArray(context.chat) ? context.chat : []).slice(-6)
        .map(item => text(item?.mes, 5000)).filter(Boolean);
    const snapshot = {
        conversation: { id: 'phone-world', name: '手机公共世界', type: 'group' },
        messages: [],
        messageRecords: [],
        activeMemory: store.onlineMemory?.events ?? [],
    };
    const preparedContext = await preparePhoneStoryContext({
        settings,
        context,
        snapshot,
        store,
        recentStory,
    }, options.contextClients ?? {});
    const weiboRequest = buildPhoneWeiboAiRequest(settings, context, {
        mode: settings.phone?.weibo?.initialized ? 'story' : 'bootstrap',
        messageId: String(messageId),
        swipeIndex,
        sourceKey,
        storyText: latestStory,
    });
    const request = {
        storyText: latestStory,
        storyContext: preparedContext,
        conversations: store.conversations.map(conversation => ({
            id: conversation.id,
            type: conversation.type,
            name: conversation.name,
            members: conversation.members,
            identity: conversation.identity,
            memberIdentities: conversation.memberIdentities,
        })),
        roleAccounts: summarizeDirectory(settings),
        profile: weiboRequest.profile,
        interests: weiboRequest.interests,
        currentState: summarizeCurrentState(settings),
        weiboMode: weiboRequest.mode,
        now: Date.now(),
    };
    const generate = options.generate ?? generatePhoneWorldCompletion;
    const response = await generate({
        barrage: settings.apis.barrage,
        maxTokens: Math.max(16_000, Math.min(48_000, Number(settings.phone?.generationMaxTokens) || 32_000)),
        prompt: buildWorldPrompt(request),
    });
    const parsed = parsePhoneWorldRecords(response?.content);
    const appliedModules = [];
    const items = {};
    const moduleErrors = [];

    const weiboData = parsed.records.get('weibo');
    if (weiboData) {
        try {
            const batch = parsePhoneWeiboAiBatch(JSON.stringify(weiboData), weiboRequest);
            applyPhoneWeiboBatch(settings.phone.weibo, batch, weiboRequest);
            items.weibo = batch.posts.map(post => post.id);
            appliedModules.push('weibo');
        } catch (error) {
            moduleErrors.push({ module: 'weibo', error });
        }
    }
    const communityData = parsed.records.get('community');
    if (communityData) {
        try {
            Object.assign(items, applyCommunityModule(settings, communityData, sourceKey, request.now));
            appliedModules.push('community');
        } catch (error) {
            moduleErrors.push({ module: 'community', error });
        }
    }
    const liveData = parsed.records.get('live');
    if (liveData) {
        try {
            Object.assign(items, applyLiveModule(settings, liveData, sourceKey, request.now));
            appliedModules.push('live');
        } catch (error) {
            moduleErrors.push({ module: 'live', error });
        }
    }
    const messageData = parsed.records.get('messages');
    if (messageData) {
        try {
            Object.assign(items, applyMessagesModule(store, messageData, latestStory, sourceKey));
            appliedModules.push('messages');
        } catch (error) {
            moduleErrors.push({ module: 'messages', error });
        }
    }
    if (appliedModules.length === 0) {
        const details = moduleErrors.map(item => `${item.module}: ${item.error.message}`).join('；');
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
    await phoneSession.save();
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
    return { modules: appliedModules, moduleErrors };
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
        generationActive = false;
        generationStopped = false;
        phoneSession.invalidate();
        const current = globalThis.SillyTavern?.getContext?.() ?? context;
        initialCount = Array.isArray(current.chat) ? current.chat.length : 0;
    });
    lifecycleBound = true;
    return true;
}
