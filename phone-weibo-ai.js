import { generateWeiboCompletion } from './rag-client.js';
import { getPhoneChatId } from './phone-store.js';
import { cleanPhoneText as text } from './phone-utils.js';
import {
    completePhoneWeiboHotTopics,
    normalizePhoneWeiboPost,
    normalizePhoneWeiboState,
} from './phone-weibo.js';

export const PHONE_WEIBO_FEED_LIMIT = 30;
export const PHONE_WEIBO_STORY_POST_MIN = 5;
export const PHONE_WEIBO_STORY_POST_MAX = 8;

function makeId(prefix) {
    const value = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    return `${prefix}-${value}`;
}

function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function parseJsonObject(raw) {
    const source = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    let parsed;
    try {
        parsed = JSON.parse(source);
    } catch (error) {
        const wrapped = new Error(`微博 API 返回了损坏的 JSON：${error.message}`);
        wrapped.cause = error;
        wrapped.rawResponse = source;
        throw wrapped;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('微博 API 必须返回一个 JSON 对象。');
    }
    return parsed;
}

function finiteInteger(value, label, { minimum = 0, maximum = 100_000_000, fallback } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        if (Number.isFinite(Number(fallback))) {
            return Math.max(minimum, Math.min(maximum, Math.trunc(Number(fallback))));
        }
        throw new Error(`${label} 必须是数字。`);
    }
    return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function requiredText(value, label, maximum = 500) {
    const result = text(value, maximum);
    if (!result) throw new Error(`${label}不能为空。`);
    return result;
}

function normalizeAiComment(value, index, postId, now, tolerant = false) {
    return {
        id: text(value?.id, 120) || `${postId}-comment-${index + 1}`,
        author: tolerant ? text(value?.author, 80) || '微博用户' : requiredText(value?.author, `第 ${index + 1} 条热评作者`, 80),
        content: requiredText(value?.content, `第 ${index + 1} 条热评内容`, 300),
        likes: finiteInteger(value?.likes, `第 ${index + 1} 条热评点赞数`, { fallback: tolerant ? 0 : undefined }),
        createdAt: Number.isFinite(Number(value?.createdAt)) ? Number(value.createdAt) : now - ((index + 1) * 60_000),
        tone: text(value?.tone, 20) || ['violet', 'orange', 'cyan', 'rose', 'green'][index % 5],
    };
}

function normalizeAiPost(value, index, request, now, warnings = []) {
    const tolerant = request.allowPartial === true;
    const id = text(value?.id, 120) || makeId('weibo-post');
    const authorType = ['npc', 'role', 'player'].includes(value?.authorType) ? value.authorType : 'npc';
    const roleId = authorType === 'role' ? requiredText(value?.authorId, `第 ${index + 1} 条角色微博的账号 ID`, 120) : '';
    const comments = (Array.isArray(value?.hotComments) ? value.hotComments : []).slice(0, 5);
    if (!tolerant && comments.length !== 5) throw new Error(`第 ${index + 1} 条微博必须恰好带 5 条高度相关的热评。`);
    if (tolerant && comments.length !== 5) warnings.push(`第 ${index + 1} 条微博只返回了 ${comments.length} 条热评。`);
    const roleAccount = roleId
        ? request.roleAccounts.find(account => account.id === roleId)
        : null;
    if (authorType === 'role') {
        if (!roleAccount) throw new Error(`第 ${index + 1} 条微博引用了不存在的角色账号。`);
        if (roleAccount.identity?.mode === 'unbound') throw new Error(`角色账号“${roleAccount.nickname}”尚未绑定身份，不能自动发微博。`);
        if (request.mode === 'story') {
            const evidence = requiredText(value?.storyEvidence, `第 ${index + 1} 条角色微博的正文依据`, 300);
            if (!request.storyText.includes(evidence)) {
                throw new Error(`角色账号“${roleAccount.nickname}”的发帖依据并非正文原句。`);
            }
        }
    }
    const metrics = value?.metrics && typeof value.metrics === 'object' ? value.metrics : value;
    const content = requiredText(value?.content, `第 ${index + 1} 条微博正文`, 500);
    const normalizedComments = [];
    comments.forEach((comment, commentIndex) => {
        try {
            normalizedComments.push(normalizeAiComment(comment, commentIndex, id, now, tolerant));
        } catch (error) {
            if (!tolerant) throw error;
            warnings.push(`第 ${index + 1} 条微博的第 ${commentIndex + 1} 条热评已跳过：${error.message}`);
        }
    });
    const commentCount = finiteInteger(metrics?.comments, `第 ${index + 1} 条微博评论数`, {
        fallback: tolerant ? normalizedComments.length : undefined,
    });
    if (!tolerant && commentCount < normalizedComments.length) throw new Error(`第 ${index + 1} 条微博的评论总数小于已生成热评数。`);
    return {
        id,
        kind: value?.kind === 'repost' && value?.source ? 'repost' : 'original',
        authorType,
        authorId: roleId,
        author: authorType === 'player'
            ? request.profile.nickname
            : authorType === 'role' ? roleAccount.nickname : tolerant
                ? text(value?.author, 80) || '微博用户'
                : requiredText(value?.author, `第 ${index + 1} 条微博作者`, 80),
        avatar: authorType === 'role' ? roleAccount.avatar : text(value?.avatar, 4000),
        badge: text(value?.badge, 80) || (authorType === 'player' ? 'KK PHONE 用户' : authorType === 'role' ? '角色账号' : '微博用户'),
        tone: text(value?.tone, 20) || 'rose',
        content,
        topics: (Array.isArray(value?.topics) ? value.topics : []).map(item => text(item, 40)).filter(Boolean),
        customTopics: (Array.isArray(value?.customTopics) ? value.customTopics : []).map(item => text(item, 50).replace(/^#+|#+$/g, '')).filter(Boolean),
        imageDescription: text(value?.imageDescription, 240),
        location: text(value?.location, 120),
        mentions: (Array.isArray(value?.mentions) ? value.mentions : []).map(mention => ({
            id: text(mention?.id, 120),
            nickname: text(mention?.nickname, 80),
        })).filter(mention => mention.id && mention.nickname),
        source: value?.source && typeof value.source === 'object' ? clone(value.source) : null,
        createdAt: Number.isFinite(Number(value?.createdAt)) ? Number(value.createdAt) : now - (index * 60_000),
        reposts: finiteInteger(metrics?.reposts, `第 ${index + 1} 条微博转发数`, { fallback: tolerant ? 0 : undefined }),
        comments: Math.max(commentCount, normalizedComments.length),
        likes: finiteInteger(metrics?.likes, `第 ${index + 1} 条微博点赞数`, { fallback: tolerant ? 0 : undefined }),
        hotComments: normalizedComments,
        generationBatchId: request.batchId,
        storyEvidence: text(value?.storyEvidence, 300),
    };
}

function normalizeHotTopic(value, index, postIds, tolerant = false) {
    const postId = requiredText(value?.postId, `第 ${index + 1} 个热搜关联微博`, 120);
    if (!postIds.has(postId)) throw new Error(`第 ${index + 1} 个热搜没有指向本批次的有效微博。`);
    return {
        id: text(value?.id, 120) || makeId('weibo-hot'),
        title: requiredText(value?.title, `第 ${index + 1} 个热搜标题`, 80),
        postId,
        heat: finiteInteger(value?.heat, `第 ${index + 1} 个热搜热度`, { maximum: 1_000_000_000, fallback: tolerant ? 0 : undefined }),
        mark: ['爆', '沸', '热', '新', ''].includes(value?.mark) ? value.mark : '',
    };
}

export function parsePhoneWeiboAiBatch(raw, request = {}) {
    const parsed = parseJsonObject(raw);
    const values = Array.isArray(parsed.posts) ? parsed.posts : [];
    const tolerant = request.allowPartial === true;
    const validationWarnings = [];
    if ((request.mode === 'story' || request.mode === 'bootstrap') && !tolerant) {
        if (values.length < PHONE_WEIBO_STORY_POST_MIN || values.length > PHONE_WEIBO_STORY_POST_MAX) {
            throw new Error(`正文更新微博时必须生成 ${PHONE_WEIBO_STORY_POST_MIN}–${PHONE_WEIBO_STORY_POST_MAX} 条帖子。`);
        }
    } else if (['player_post', 'player_repost', 'role_post'].includes(request.mode) && values.length !== 1) {
        throw new Error('这次微博操作必须返回且只返回 1 条帖子。');
    } else if (request.mode === 'player_reply' && values.length !== 0) {
        throw new Error('回复评论时不能额外生成新帖子。');
    }
    const now = Number(request.now) || Date.now();
    if (tolerant && (values.length < PHONE_WEIBO_STORY_POST_MIN || values.length > PHONE_WEIBO_STORY_POST_MAX)) {
        validationWarnings.push(`微博返回了 ${values.length} 条帖子，已保留其中可用内容。`);
    }
    let posts = [];
    values.slice(0, PHONE_WEIBO_STORY_POST_MAX).forEach((value, index) => {
        try {
            posts.push(normalizeAiPost(value, index, request, now, validationWarnings));
        } catch (error) {
            if (!tolerant) throw error;
            validationWarnings.push(`第 ${index + 1} 条微博已跳过：${error.message}`);
        }
    });
    if (tolerant) {
        const seenPostIds = new Set();
        posts = posts.filter((post, index) => {
            if (!seenPostIds.has(post.id)) {
                seenPostIds.add(post.id);
                return true;
            }
            validationWarnings.push(`第 ${index + 1} 条微博 ID 重复，已单独跳过。`);
            return false;
        });
    }
    if (['player_post', 'player_repost'].includes(request.mode)) {
        if (posts[0]?.authorType !== 'player') throw new Error('玩家发布操作返回的帖子作者不是玩家。');
        const expectedContent = text(request.operation?.content, 500) || (request.mode === 'player_repost' ? '转发微博' : '');
        if (posts[0]?.content !== expectedContent) throw new Error('微博 API 改写了玩家输入，整批内容未发布。');
    }
    if (request.mode === 'player_post') {
        const expectedTopics = (Array.isArray(request.operation?.customTopics) ? request.operation.customTopics : [])
            .map(item => text(item, 50).replace(/^#+|#+$/g, '')).filter(Boolean);
        const expectedMentions = (Array.isArray(request.operation?.mentions) ? request.operation.mentions : []).map(mention => ({
            id: text(mention?.id, 120),
            nickname: text(mention?.nickname, 80),
        })).filter(mention => mention.id && mention.nickname);
        if (JSON.stringify(posts[0]?.customTopics ?? []) !== JSON.stringify(expectedTopics)
            || posts[0]?.imageDescription !== text(request.operation?.imageDescription, 240)
            || posts[0]?.location !== text(request.operation?.location, 120)
            || JSON.stringify(posts[0]?.mentions ?? []) !== JSON.stringify(expectedMentions)) {
            throw new Error('微博 API 改动或遗漏了玩家填写的话题、图片、位置或提及信息。');
        }
    }
    if (request.mode === 'player_repost' && JSON.stringify(posts[0]?.source ?? null) !== JSON.stringify(request.operation?.source ?? null)) {
        throw new Error('微博 API 改动了玩家要转发的原帖。');
    }
    if (request.mode === 'role_post'
        && (posts[0]?.authorType !== 'role' || posts[0]?.authorId !== request.operation?.roleId)) {
        throw new Error('角色发帖操作返回了错误的微博账号。');
    }
    const postIds = new Set(posts.map(post => post.id));
    if (!tolerant && postIds.size !== posts.length) throw new Error('微博 API 返回了重复的帖子 ID。');
    const hotTopics = [];
    (Array.isArray(parsed.hotTopics) ? parsed.hotTopics : []).forEach((value, index) => {
        try {
            hotTopics.push(normalizeHotTopic(value, index, postIds, tolerant));
        } catch (error) {
            if (!tolerant) throw error;
            validationWarnings.push(`第 ${index + 1} 个热搜已跳过：${error.message}`);
        }
    });
    const reply = request.mode === 'player_reply' ? {
        id: text(parsed?.reply?.id, 120) || makeId('weibo-reply'),
        postId: requiredText(parsed?.reply?.postId, '回复对应的微博 ID', 120),
        commentId: requiredText(parsed?.reply?.commentId, '回复对应的评论 ID', 160),
        content: requiredText(parsed?.reply?.content, '回复内容', 300),
        createdAt: now,
    } : null;
    if (reply && (reply.postId !== request.operation?.postId || reply.commentId !== request.operation?.commentId)) {
        throw new Error('微博 API 把玩家回复挂到了错误的帖子或评论上。');
    }
    if (reply && reply.content !== text(request.operation?.content, 300)) {
        throw new Error('微博 API 改写了玩家回复，整批内容未发布。');
    }
    const followerDelta = finiteInteger(Math.abs(Number(parsed.followerDelta) || 0), '粉丝变化', { maximum: 10_000_000 })
        * (Number(parsed.followerDelta) < 0 ? -1 : 1);
    if (request.mode === 'bootstrap' && followerDelta < 1) {
        throw new Error('首次初始化必须根据玩家设定生成合理的粉丝基线。');
    }
    return {
        posts,
        hotTopics,
        reply,
        followerDelta,
        followerReason: text(parsed.followerReason, 160),
        validationWarnings,
    };
}

function removeBatch(state, batch) {
    const postIds = new Set(batch?.postIds ?? []);
    const hotTopicIds = new Set(batch?.hotTopicIds ?? []);
    state.posts = state.posts.filter(post => !postIds.has(post.id));
    state.feedPostIds = state.feedPostIds.filter(id => !postIds.has(id));
    state.hotTopics = state.hotTopics.filter(topic => !hotTopicIds.has(topic.id) && !postIds.has(topic.postId));
    state.commentReplies = state.commentReplies.filter(reply => !postIds.has(reply.postId));
    state.likedPostIds = state.likedPostIds.filter(id => !postIds.has(id));
    state.followerCount = Math.max(0, state.followerCount - (Number(batch?.followerDelta) || 0));
}

function enforceFeedLimit(state) {
    const postsById = new Map(state.posts.map(post => [post.id, post]));
    const uniqueIds = [...new Set(state.feedPostIds)].filter(id => postsById.has(id));
    uniqueIds.sort((left, right) => Number(postsById.get(right)?.createdAt || 0) - Number(postsById.get(left)?.createdAt || 0));
    const evictedIds = uniqueIds.slice(PHONE_WEIBO_FEED_LIMIT);
    state.feedPostIds = uniqueIds.slice(0, PHONE_WEIBO_FEED_LIMIT);
    const deletedIds = new Set(evictedIds.filter(id => postsById.get(id)?.authorType === 'npc'));
    if (deletedIds.size > 0) {
        state.posts = state.posts.filter(post => !deletedIds.has(post.id));
        state.hotTopics = state.hotTopics.filter(topic => !deletedIds.has(topic.postId));
        state.commentReplies = state.commentReplies.filter(reply => !deletedIds.has(reply.postId));
        state.likedPostIds = state.likedPostIds.filter(id => !deletedIds.has(id));
    }
    return { evictedIds, deletedIds: [...deletedIds] };
}

export function applyPhoneWeiboBatch(state, batch, request = {}) {
    const working = clone(state);
    working.posts ??= [];
    working.feedPostIds ??= [];
    working.hotTopics ??= [];
    working.commentReplies ??= [];
    working.likedPostIds ??= [];
    working.generationBatches ??= [];
    if (request.sourceKey && working.generationBatches.some(item => item.sourceKey === request.sourceKey)) {
        return { state, duplicate: true, evictedIds: [], deletedIds: [] };
    }
    if (request.messageId) {
        const replaced = working.generationBatches.filter(item => item.messageId === request.messageId);
        replaced.forEach(item => removeBatch(working, item));
        working.generationBatches = working.generationBatches.filter(item => item.messageId !== request.messageId);
    }
    batch.posts = batch.posts.map(normalizePhoneWeiboPost).filter(Boolean);
    const existingIds = new Set(working.posts.map(post => post.id));
    if (batch.posts.some(post => existingIds.has(post.id))) throw new Error('新微博 ID 与已有帖子冲突，整批内容未保存。');
    working.posts.push(...batch.posts);
    working.posts.sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
    working.feedPostIds.unshift(...batch.posts.map(post => post.id));
    const newPostIds = new Set(batch.posts.map(post => post.id));
    working.hotTopics = [
        ...batch.hotTopics,
        ...working.hotTopics.filter(topic => !batch.hotTopics.some(item => item.id === topic.id)),
    ].filter(topic => newPostIds.has(topic.postId) || working.posts.some(post => post.id === topic.postId)).slice(0, 30);
    if (batch.reply) working.commentReplies.push(batch.reply);
    working.followerCount = Math.max(0, Math.trunc(Number(working.followerCount) || 0) + batch.followerDelta);
    if (batch.followerDelta) {
        working.followerHistory ??= [];
        working.followerHistory.unshift({
            id: makeId('weibo-fans'),
            delta: batch.followerDelta,
            reason: batch.followerReason,
            createdAt: Number(request.now) || Date.now(),
            batchId: request.batchId,
        });
        working.followerHistory = working.followerHistory.slice(0, 100);
    }
    const retention = enforceFeedLimit(working);
    working.hotTopics = completePhoneWeiboHotTopics(working);
    working.initialized = true;
    working.initializing = false;
    working.lastError = '';
    working.generationBatches.push({
        id: request.batchId,
        sourceKey: request.sourceKey,
        chatId: request.chatId,
        messageId: request.messageId,
        swipeIndex: request.swipeIndex,
        mode: request.mode,
        postIds: batch.posts.map(post => post.id),
        hotTopicIds: batch.hotTopics.map(topic => topic.id),
        followerDelta: batch.followerDelta,
        createdAt: Number(request.now) || Date.now(),
    });
    working.generationBatches = working.generationBatches.slice(-200);
    Object.keys(state).forEach(key => delete state[key]);
    Object.assign(state, working);
    return { state, duplicate: false, ...retention };
}

export function isPhoneWeiboAiReady(settings = {}) {
    const api = settings?.apis?.barrage;
    return Boolean(text(api?.url, 2000) && text(api?.apiKey, 4000) && text(api?.model, 500));
}

function summarizePost(post) {
    return `[${post.id}] ${post.author || post.authorType}：${text(post.content, 180)}`;
}

export function buildPhoneWeiboAiRequest(settings, context, options = {}) {
    const state = normalizePhoneWeiboState(settings);
    const chatId = getPhoneChatId(context);
    const messageId = text(options.messageId, 120);
    const swipeIndex = Math.max(0, Math.trunc(Number(options.swipeIndex) || 0));
    const mode = text(options.mode, 40) || 'story';
    const batchId = text(options.batchId, 120) || makeId('weibo-batch');
    const sourceKey = text(options.sourceKey, 500)
        || `${chatId}:${messageId}:${swipeIndex}:${mode}`;
    return {
        mode,
        batchId,
        sourceKey,
        chatId,
        messageId,
        swipeIndex,
        storyText: text(options.storyText, 60_000),
        storyContext: clone(options.storyContext ?? {}),
        operation: clone(options.operation ?? {}),
        interests: [...state.interests],
        profile: clone(state.profile),
        followerCount: Math.max(0, Math.trunc(Number(state.followerCount) || 0)),
        roleAccounts: state.roleAccounts.map(account => clone(account)),
        recentPosts: state.posts.slice(0, 30).map(summarizePost),
        hotTopics: state.hotTopics.slice(0, 20).map(topic => `${topic.title}（${topic.heat}）`),
        userPersona: text(settings.phone?.weibo?.profile?.persona, 12_000) || text(context?.powerUser?.persona_description
            ?? context?.power_user?.persona_description
            ?? globalThis.power_user?.persona_description, 12_000),
        now: Number(options.now) || Date.now(),
    };
}

async function executeRequest(settings, context, options = {}) {
    if (!isPhoneWeiboAiReady(settings)) throw new Error('请先配置弹幕/手机共用的 API。');
    const request = buildPhoneWeiboAiRequest(settings, context, options);
    const state = normalizePhoneWeiboState(settings);
    if (request.sourceKey && state.generationBatches.some(item => item.sourceKey === request.sourceKey)) {
        return { duplicate: true, state };
    }
    const generate = options.generateWeibo ?? generateWeiboCompletion;
    const response = await generate({
        barrage: settings.apis.barrage,
        maxTokens: Math.max(4096, Math.min(16_384, Math.trunc(Number(settings.phone?.weibo?.generationMaxTokens) || 12_000))),
        request,
    });
    const batch = parsePhoneWeiboAiBatch(response?.content, request);
    return applyPhoneWeiboBatch(state, batch, request);
}

function notifyUpdated(detail = {}) {
    globalThis.dispatchEvent?.(new CustomEvent('memory-augment-weibo-updated', { detail }));
}

export async function requestPhoneWeiboBootstrap(settings, context, options = {}) {
    const state = normalizePhoneWeiboState(settings);
    if (state.initialized) return { state, duplicate: true };
    state.initializing = true;
    state.lastError = '';
    await options.saveSettings?.();
    try {
        const result = await executeRequest(settings, context, {
            ...options,
            mode: 'bootstrap',
            sourceKey: `${getPhoneChatId(context)}:weibo-bootstrap`,
        });
        await options.saveSettings?.();
        notifyUpdated({ mode: 'bootstrap' });
        return result;
    } catch (error) {
        state.initializing = false;
        state.lastError = text(error?.message, 500);
        await options.saveSettings?.();
        notifyUpdated({ mode: 'bootstrap', error: state.lastError });
        throw error;
    }
}

export async function requestPhoneWeiboOperation(settings, context, operation, options = {}) {
    const mode = text(operation?.type, 40);
    const allowed = new Set(['player_post', 'player_repost', 'player_reply', 'role_post']);
    if (!allowed.has(mode)) throw new Error('不支持的微博操作。');
    const latestStory = [...(Array.isArray(context?.chat) ? context.chat : [])].reverse()
        .find(message => !message?.is_user && !message?.is_system);
    const result = await executeRequest(settings, context, {
        ...options,
        mode,
        operation,
        storyText: text(latestStory?.mes ?? latestStory?.content, 20_000),
        sourceKey: `${getPhoneChatId(context)}:${mode}:${makeId('operation')}`,
    });
    await options.saveSettings?.();
    notifyUpdated({ mode });
    return result;
}
