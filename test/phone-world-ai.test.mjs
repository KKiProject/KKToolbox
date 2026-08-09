import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyPhoneStore, createPhoneConversation, appendPhoneMessage } from '../phone-store.js';
import { parsePhoneWorldRecords, removePhoneWorldStoryBatch, requestPhoneWorldStoryUpdate } from '../phone-world-ai.js';

test('phone world JSONL keeps valid modules when a neighboring module is malformed', () => {
    const raw = [
        '{"module":"weibo","data":{"posts":[],"note":"正文里有 {括号} 也没事"}}',
        '{"module":"community","data":{"forumThreads":[1,2,]}}',
        '{"module":"live","data":{"official":[],"private":[]}}',
        '{"module":"messages","data":{"evidenceQuote":"","conversations":[]}}',
    ].join('\n');
    const parsed = parsePhoneWorldRecords(raw);
    assert.deepEqual([...parsed.records.keys()], ['weibo', 'live', 'messages']);
    assert.equal(parsed.records.get('weibo').note, '正文里有 {括号} 也没事');
    assert.equal(parsed.errors.length, 1);
});

test('removing a story batch clears only that swipe-derived phone data in every app', () => {
    const store = createEmptyPhoneStore('phone-world-cleanup');
    const conversation = createPhoneConversation(store, { type: 'direct', name: '沈越' });
    const generatedMessage = appendPhoneMessage(store, conversation.id, {
        id: 'generated-message', sender: '沈越', content: '今晚见。', storyPending: false,
    });
    store.phone.weibo = {
        posts: [{ id: 'generated-post' }, { id: 'kept-post' }],
        feedPostIds: ['generated-post', 'kept-post'],
        hotTopics: [{ id: 'generated-topic', postId: 'generated-post' }],
        commentReplies: [], likedPostIds: [], followerCount: 15,
        generationBatches: [{ messageId: '9', postIds: ['generated-post'], hotTopicIds: ['generated-topic'], followerDelta: 5 }],
    };
    store.phone.community = {
        forumThreads: [{ id: 'generated-forum' }, { id: 'kept-forum' }],
        cpRankings: [{ id: 'generated-cp' }],
        fanWorks: [{ id: 'generated-fanwork' }],
    };
    store.phone.live = {
        streams: [{ id: 'generated-live', type: 'official', scenes: [{ text: '画面' }] }],
        ownLive: { status: 'idle', records: [] },
    };
    store.storyBatches = [{
        sourceKey: 'chat:9:0:phone-world', messageId: '9', swipeIndex: 0,
        modules: ['weibo', 'community', 'live', 'messages'],
        items: {
            messages: [generatedMessage.id],
            communityForum: ['generated-forum'],
            communityCp: ['generated-cp'],
            communityFanwork: ['generated-fanwork'],
            live: ['generated-live'],
        },
    }];
    const settings = { phone: store.phone };

    assert.equal(removePhoneWorldStoryBatch(store, settings, '9'), 1);
    assert.deepEqual(store.phone.weibo.posts.map(item => item.id), ['kept-post']);
    assert.deepEqual(store.phone.community.forumThreads.map(item => item.id), ['kept-forum']);
    assert.equal(store.phone.live.streams.some(item => item.id === 'generated-live'), false);
    assert.equal(store.conversations[0].messages.some(item => item.id === generatedMessage.id), false);
    assert.equal(store.storyBatches.length, 0);
});

test('one story-side request updates all public apps and only imports evidence-backed messages', async () => {
    const store = createEmptyPhoneStore('phone-world-integration');
    store.scopedInitialized = true;
    store.phone.profile = { nickname: '夜酱', accountId: 'main', isMask: false };
    store.phone.weibo = { initialized: true, interests: [], posts: [], feedPostIds: [], hotTopics: [], roleAccounts: [] };
    store.phone.community = {};
    store.phone.live = {};
    const direct = createPhoneConversation(store, { type: 'direct', name: '沈越' });
    const settings = {
        apis: { barrage: { url: 'https://example.com/v1', apiKey: 'key', model: 'model' } },
        development: { enabled: false },
        map: { includeInPrompt: false },
        phone: store.phone,
    };
    const context = {
        getCurrentChatId: () => store.chatId,
        name1: '夜酱',
        name2: '艾莉娅',
        characterId: 0,
        characters: [{ name: '艾莉娅', description: '演员。', data: {} }],
        chatMetadata: {},
        chat: [{ is_user: false, mes: '散场后，沈越发来消息：“今晚十点开会。”' }],
    };
    const comments = prefix => Array.from({ length: 5 }, (_, index) => ({
        id: `${prefix}-comment-${index}`, author: `网友${index}`, content: `${prefix}相关评论${index}`, likes: 10 - index,
    }));
    const weibo = {
        posts: Array.from({ length: 5 }, (_, index) => ({
            id: `world-post-${index}`, authorType: 'npc', author: `路人${index}`, content: `世界动态${index}`,
            metrics: { reposts: index, comments: 5, likes: 20 + index }, hotComments: comments(`微博${index}`),
        })),
        hotTopics: [{ id: 'world-hot-1', title: '散场夜', postId: 'world-post-0', heat: 1000, mark: '新' }],
        reply: null, followerDelta: 0, followerReason: '',
    };
    const forumThreads = Array.from({ length: 3 }, (_, index) => ({
        id: `world-forum-${index}`, category: 'analysis', tag: '剧情分析', time: '刚刚', title: `论坛${index}`,
        excerpt: '摘要', body: '正文', author: '匿名用户', views: 100, replies: 5, comments: comments(`论坛${index}`),
    }));
    const cpRankings = Array.from({ length: 3 }, (_, index) => ({
        id: `world-cp-${index}`, rank: index + 1, name: `心动${index}`, kind: 'directional', kindLabel: '角色CP',
        left: '甲', right: '乙', pairing: '甲 × 乙', members: ['甲', '乙'], series: '故事', trend: 'new',
        change: 1, heat: '1万', weekly: '本周同框。', comments: comments(`CP${index}`),
    }));
    const fanWorks = Array.from({ length: 3 }, (_, index) => ({
        id: `world-fan-${index}`, type: 'article', typeLabel: '同人文', title: `同人${index}`, creator: '写手',
        cpName: `心动${index}`, pairing: '甲 × 乙', series: '故事', characters: ['甲', '乙'],
        tags: ['故事', '甲', '乙', `心动${index}`], time: '刚刚', likes: 20, comments: 5,
        summary: '试读', preview: '这是大约一百字的试读内容，故事在这里暂时停下……', commentsList: comments(`同人${index}`),
    }));
    const stream = (id, type) => ({
        id, type, host: `${type}主播`, title: `${type}直播`, category: '闲聊', viewers: 100, summary: '直播中', segment: '开场',
        scenes: Array.from({ length: 4 }, (_, index) => ({ kind: index % 2 ? 'dialogue' : 'narration', segment: `阶段${index}`, speaker: '主播', text: `画面${index}` })),
        barrages: Array.from({ length: 8 }, (_, index) => `弹幕${index}`),
        chats: Array.from({ length: 5 }, (_, index) => ({ id: `${id}-chat-${index}`, author: `观众${index}`, content: `聊天${index}` })),
    });
    const records = [
        { module: 'weibo', data: weibo },
        { module: 'community', data: { forumThreads, cpRankings, fanWorks } },
        { module: 'live', data: { official: [stream('world-official', 'official')], private: [stream('world-private', 'private')] } },
        { module: 'messages', data: { evidenceQuote: '沈越发来消息', conversations: [{ conversationId: direct.id, messages: [{ sender: '沈越', type: 'text', content: '今晚十点开会。' }] }] } },
    ].map(record => JSON.stringify(record)).join('\n');
    let prompt = '';
    const phoneSession = { settings, ensure: async () => store, save: async () => store };

    const result = await requestPhoneWorldStoryUpdate(phoneSession, context, 0, {
        generate: async payload => { prompt = payload.prompt; return { content: records }; },
        contextClients: {
            getPowerUser: () => ({ persona_description: '夜酱是普通助理。' }),
            getMaxContextSize: () => 32768,
            getWorldInfoPrompt: async () => ({}),
            retrieveAndInject: async () => undefined,
        },
    });

    assert.deepEqual(result.modules, ['weibo', 'community', 'live', 'messages']);
    assert.match(prompt, /messages 最严格/);
    assert.match(prompt, /三个板块各生成恰好 3 条/);
    assert.equal(settings.phone.weibo.posts.some(post => post.id === 'world-post-0'), true);
    assert.equal(settings.phone.community.forumThreads.some(item => item.id === 'world-forum-0'), true);
    assert.equal(settings.phone.live.streams.some(item => item.id === 'world-official'), true);
    assert.equal(store.conversations[0].messages.at(-1).content, '今晚十点开会。');
    assert.equal(store.conversations[0].messages.at(-1).storyPending, false);
    assert.equal(store.storyBatches.length, 1);
});
