import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyPhoneStore, createPhoneConversation, appendPhoneMessage } from '../phone-store.js';
import {
    buildPhoneStoryTurnText,
    detectPhoneWorldPlotModules,
    getPhoneWorldOutputTokenBudget,
    inferPhonePublicWorldFrame,
    isPhoneWorldAutomaticUpdateEnabled,
    parsePhoneWorldRecords,
    removePhoneWorldStoryBatch,
    requestPhoneWorldStoryUpdate,
    selectDailyPhoneWorldModule,
} from '../phone-world-ai.js';

test('phone automatic updates default on and can be disabled without disabling manual requests', () => {
    assert.equal(isPhoneWorldAutomaticUpdateEnabled({}), true);
    assert.equal(isPhoneWorldAutomaticUpdateEnabled({ phoneAutomation: { autoWorldUpdatesEnabled: false } }), false);
    assert.equal(isPhoneWorldAutomaticUpdateEnabled({
        settings: { phoneAutomation: { autoWorldUpdatesEnabled: false } },
    }), false);
});

test('one phone story turn includes both the player floor and its assistant reply', () => {
    const context = {
        chat: [
            { is_user: false, mes: '上一轮正文。' },
            { is_user: true, mes: '她打开微博，又顺手看了社区帖子。' },
            { is_user: false, mes: '屏幕上已经积了不少新内容。' },
        ],
    };
    const turn = buildPhoneStoryTurnText(context, 2);
    assert.match(turn, /【玩家本轮输入】[\s\S]*打开微博/);
    assert.match(turn, /【AI本轮正文】[\s\S]*积了不少新内容/);
    assert.deepEqual(detectPhoneWorldPlotModules(turn), ['weibo', 'community']);
});

test('story-side phone generation selects every module explicitly present on the player floor', async () => {
    const store = createEmptyPhoneStore('phone-world-two-floor-evidence');
    store.scopedInitialized = true;
    store.phone.weibo = { initialized: true, roleAccounts: [] };
    const settings = {
        apis: { barrage: { url: 'https://example.com/v1', apiKey: 'key', model: 'model' } },
        development: { enabled: false },
        map: { includeInPrompt: false },
        phone: store.phone,
    };
    const context = {
        getCurrentChatId: () => store.chatId,
        chatMetadata: {},
        chat: [
            { is_user: true, mes: '她看到微博和社区里都已经出现了相关内容。' },
            { is_user: false, mes: '她低头继续浏览手机。' },
        ],
    };
    let prompt = '';
    await assert.rejects(() => requestPhoneWorldStoryUpdate({
        settings,
        ensure: async () => store,
        save: async () => store,
    }, context, 1, {
        generate: async request => {
            prompt = request.prompt;
            throw new Error('只检查本轮请求');
        },
        contextClients: {
            getPowerUser: () => ({}),
            getMaxContextSize: () => 32768,
            getWorldInfoPrompt: async () => ({}),
            retrieveAndInject: async () => undefined,
        },
    }), /只检查本轮请求/);

    assert.match(prompt, /mode=plot；modules=\["weibo","community"\]/);
    assert.match(prompt, /【玩家本轮输入】[\s\S]*微博和社区/);
    assert.match(prompt, /【AI本轮正文】[\s\S]*继续浏览手机/);
});

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

test('daily public-world generation cannot see private story, character names, or private recalls', async () => {
    const store = createEmptyPhoneStore('phone-world-private-daily');
    store.scopedInitialized = true;
    store.phone.weibo = { initialized: true, roleAccounts: [] };
    const settings = {
        apis: { barrage: { url: 'https://example.com/v1', apiKey: 'key', model: 'model' } },
        development: { enabled: true },
        map: { includeInPrompt: true },
        phone: store.phone,
    };
    const context = {
        getCurrentChatId: () => store.chatId,
        characterId: 0,
        characters: [{ name: '顾知夏', data: { scenario: '娱乐圈背景。顾知夏秘密离开公司去找妹妹。' } }],
        chatMetadata: {},
        chat: [{ is_user: false, mes: '顾知夏悄悄离开公司去找妹妹，公司公关没有对外透露。' }],
    };
    let prompt = '';
    let privateContextCalls = 0;
    await requestPhoneWorldStoryUpdate({ settings, ensure: async () => store, save: async () => store }, context, 0, {
        random: () => 0,
        generate: async request => {
            prompt = request.prompt;
            return { content: [
                JSON.stringify({ module: 'decision', data: { mode: 'daily', modules: ['weibo'] } }),
                JSON.stringify({
                    module: 'weibo',
                    data: {
                        posts: [{ id: 'background-post', authorType: 'npc', author: '影迷甲', content: '新剧发布了首支预告。' }],
                        hotTopics: [],
                    },
                }),
            ].join('\n') };
        },
        contextClients: {
            getPowerUser: () => { privateContextCalls++; return { persona_description: '私人玩家设定' }; },
            getWorldInfoPrompt: async () => { privateContextCalls++; return {}; },
            retrieveAndInject: async () => { privateContextCalls++; },
        },
    });

    assert.equal(privateContextCalls, 0);
    assert.doesNotMatch(prompt, /顾知夏|找妹妹|秘密离开|私人玩家设定/);
    assert.match(prompt, /本轮没有明确的公开平台事件/);
    assert.match(prompt, /存在成熟大众传媒与文娱行业/);
    assert.match(prompt, /正文不是给大众看的全知档案/);
    assert.match(prompt, /不得用“网友发现了”.*绕过证据/);
    assert.match(prompt, /【微博模块】/);
    assert.doesNotMatch(prompt, /【社区模块】|【直播模块】|【通讯模块】/);
    assert.doesNotMatch(inferPhonePublicWorldFrame(context), /顾知夏|找妹妹|秘密离开/);
});

test('phone world parser accepts arrays, module wrappers, and direct four-module objects', () => {
    const direct = parsePhoneWorldRecords(JSON.stringify({
        weibo: { posts: [] },
        community: { forumThreads: [] },
        live: { official: [], private: [] },
        messages: { conversations: [] },
    }));
    assert.deepEqual([...direct.records.keys()], ['weibo', 'community', 'live', 'messages']);

    const wrapped = parsePhoneWorldRecords(JSON.stringify({
        modules: [
            { module: 'weibo', data: { posts: [] } },
            { module: 'messages', data: { conversations: [] } },
        ],
    }));
    assert.deepEqual([...wrapped.records.keys()], ['weibo', 'messages']);

    const bareJsonl = parsePhoneWorldRecords([
        JSON.stringify({ posts: [], hotTopics: [] }),
        JSON.stringify({ forumThreads: [], cpRankings: [], fanWorks: [] }),
        JSON.stringify({ official: [], private: [] }),
        JSON.stringify({ evidenceQuote: '', conversations: [] }),
    ].join('\n'));
    assert.deepEqual([...bareJsonl.records.keys()], ['weibo', 'community', 'live', 'messages']);
});

test('phone world parser keeps the mode decision separate from generated modules', () => {
    const parsed = parsePhoneWorldRecords([
        '{"module":"decision","data":{"mode":"daily","modules":["community"]}}',
        '{"module":"community","data":{"forumThreads":[],"cpRankings":[],"fanWorks":[]}}',
    ].join('\n'));
    assert.deepEqual(parsed.decision, { mode: 'daily', modules: ['community'] });
    assert.deepEqual([...parsed.records.keys()], ['community']);
    const decisionOnly = parsePhoneWorldRecords('{"module":"decision","data":{"mode":"daily","modules":["weibo"]}}');
    assert.deepEqual(decisionOnly.decision, { mode: 'daily', modules: ['weibo'] });
    assert.equal(decisionOnly.records.size, 0);
    assert.equal(selectDailyPhoneWorldModule(() => 0), 'weibo');
    assert.equal(selectDailyPhoneWorldModule(() => 0.34), 'community');
    assert.equal(selectDailyPhoneWorldModule(() => 0.99), 'live');
    assert.deepEqual(detectPhoneWorldPlotModules('她决定明天去海边度假，顺便去社区服务中心吃顿饭。', { playerName: '夜酱' }), []);
    assert.deepEqual(
        detectPhoneWorldPlotModules('微博热搜出现了她的名字，姐姐随后发来消息叫她下楼。', { playerName: '夜酱' }),
        ['weibo', 'messages'],
    );
    assert.deepEqual(
        detectPhoneWorldPlotModules('她按下内线拨号键，电话接起，听筒里传来总助的声音：“季董。”通话随后切断。', { playerName: '朝汐' }),
        [],
    );
    assert.deepEqual(
        detectPhoneWorldPlotModules('朝汐就在旁边，季秋辞给总助发微信：“十分钟后开会。”', { playerName: '朝汐' }),
        [],
    );
    assert.deepEqual(
        detectPhoneWorldPlotModules('季秋辞给朝汐发微信：“十分钟后下来。”', { playerName: '朝汐' }),
        ['messages'],
    );
    assert.deepEqual(
        detectPhoneWorldPlotModules('季秋辞先给总助发微信。片刻后，姐姐给朝汐发消息叫她下楼。', { playerName: '朝汐' }),
        ['messages'],
    );
    assert.deepEqual(
        detectPhoneWorldPlotModules('季秋辞给总助发微信。微博随后发布了公开公告。', { playerName: '朝汐' }),
        ['weibo'],
    );
    assert.equal(getPhoneWorldOutputTokenBudget(['messages']), 4096);
    assert.equal(getPhoneWorldOutputTokenBudget(['weibo']), 10_000);
    assert.equal(getPhoneWorldOutputTokenBudget(['weibo', 'community', 'live', 'messages']), 32_000);
});

test('a decision-only phone response gets one focused module recovery', async () => {
    const store = createEmptyPhoneStore('phone-world-recovery');
    store.scopedInitialized = true;
    store.phone.weibo = { initialized: true, roleAccounts: [] };
    const settings = {
        apis: { barrage: { url: 'https://example.com/v1', apiKey: 'key', model: 'model' } },
        development: { enabled: false },
        map: { includeInPrompt: false },
        phone: store.phone,
    };
    const context = {
        getCurrentChatId: () => store.chatId,
        chatMetadata: {},
        chat: [{ is_user: false, mes: '她安静地看完窗外的雨。' }],
    };
    const prompts = [];
    const result = await requestPhoneWorldStoryUpdate({
        settings,
        ensure: async () => store,
        save: async () => store,
    }, context, 0, {
        random: () => 0,
        generate: async request => {
            prompts.push(request.prompt);
            if (prompts.length === 1) {
                return { content: '{"module":"decision","data":{"mode":"daily","modules":["weibo"]}}' };
            }
            return { content: JSON.stringify({
                module: 'weibo',
                data: {
                    posts: [{ id: 'recovered-post', authorType: 'npc', author: '观众甲', content: '城市音乐节公开了演出名单。' }],
                    hotTopics: [],
                },
            }) };
        },
    });

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /【格式补救】/);
    assert.match(prompts[1], /不得只返回 decision/);
    assert.deepEqual(result.modules, ['weibo']);
    assert.equal(store.phone.weibo.posts.some(post => post.id === 'recovered-post'), true);
});

test('switching the selected story candidate aborts and discards the obsolete phone result', async () => {
    const store = createEmptyPhoneStore('phone-world-swipe');
    store.scopedInitialized = true;
    store.phone.weibo = { initialized: true, roleAccounts: [] };
    const settings = {
        apis: { barrage: { url: 'https://example.com/v1', apiKey: 'key', model: 'model' } },
        development: { enabled: false },
        map: { includeInPrompt: false },
        phone: store.phone,
    };
    const message = {
        is_user: false,
        mes: '候选一的普通正文。',
        swipes: ['候选一的普通正文。', '候选二的普通正文。'],
        swipe_id: 0,
    };
    const context = {
        getCurrentChatId: () => store.chatId,
        chatMetadata: {},
        chat: [message],
    };
    let calls = 0;
    let releaseFirst;
    let firstSignal;
    let firstStartedResolve;
    const firstStarted = new Promise(resolve => { firstStartedResolve = resolve; });
    const generate = async (_request, options = {}) => {
        calls++;
        if (calls === 1) {
            firstSignal = options.signal;
            firstStartedResolve();
            await new Promise(resolve => { releaseFirst = resolve; });
            return { content: [
                '{"module":"decision","data":{"mode":"daily","modules":["weibo"]}}',
                '{"module":"weibo","data":{"posts":[{"id":"old-swipe-post","authorType":"npc","author":"旧候选","content":"旧内容"}],"hotTopics":[]}}',
            ].join('\n') };
        }
        return { content: [
            '{"module":"decision","data":{"mode":"daily","modules":["weibo"]}}',
            '{"module":"weibo","data":{"posts":[{"id":"new-swipe-post","authorType":"npc","author":"新候选","content":"新内容"}],"hotTopics":[]}}',
        ].join('\n') };
    };
    const phoneSession = { settings, ensure: async () => store, save: async () => store };

    const obsolete = requestPhoneWorldStoryUpdate(phoneSession, context, 0, { generate, random: () => 0 });
    await firstStarted;
    message.swipe_id = 1;
    message.mes = message.swipes[1];
    const current = requestPhoneWorldStoryUpdate(phoneSession, context, 0, { generate, random: () => 0 });
    assert.equal(firstSignal.aborted, true);
    await current;
    releaseFirst();
    const obsoleteResult = await obsolete;

    assert.equal(obsoleteResult.stale, true);
    assert.equal(store.phone.weibo.posts.some(post => post.id === 'old-swipe-post'), false);
    assert.equal(store.phone.weibo.posts.some(post => post.id === 'new-swipe-post'), true);
    assert.equal(store.storyBatches.length, 1);
    assert.equal(store.storyBatches[0].swipeIndex, 1);
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
        chat: [{ is_user: false, mes: '散场后，沈越发来消息：“今晚十点开会。”微博热搜出现艾莉娅的采访，论坛正在讨论她的新片，直播间正在播出发布会回放。' }],
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
        { module: 'decision', data: {
            mode: 'plot',
            modules: ['weibo', 'community', 'live', 'messages'],
            evidence: {
                weibo: '微博热搜出现艾莉娅的采访',
                community: '论坛正在讨论她的新片',
                live: '直播间正在播出发布会回放',
                messages: '沈越发来消息',
            },
        } },
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
    assert.match(prompt, /日常模式 daily/);
    assert.match(prompt, /messages 最严格/);
    assert.match(prompt, /严禁只机械输出“下来吃饭”四个字/);
    assert.match(prompt, /三个板块各生成恰好 3 条/);
    assert.equal(settings.phone.weibo.posts.some(post => post.id === 'world-post-0'), true);
    assert.equal(settings.phone.community.forumThreads.some(item => item.id === 'world-forum-0'), true);
    assert.equal(settings.phone.live.streams.some(item => item.id === 'world-official'), true);
    assert.equal(store.conversations[0].messages.at(-1).content, '今晚十点开会。');
    assert.equal(store.conversations[0].messages.at(-1).storyPending, false);
    assert.equal(store.storyBatches.length, 1);
});

test('story-side phone update preserves usable partial content and records validation warnings', async () => {
    const store = createEmptyPhoneStore('phone-world-partial');
    store.scopedInitialized = true;
    store.phone.profile = { nickname: '夜酱', accountId: 'main', isMask: false };
    store.phone.weibo = { initialized: true, interests: [], posts: [], feedPostIds: [], hotTopics: [], roleAccounts: [] };
    store.phone.community = {};
    store.phone.live = {};
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
        chat: [{ is_user: false, mes: '夜幕降临，微博出现城市活动预告，论坛有人开了讨论帖，电视台直播正在准备。' }],
    };
    const response = {
        decision: {
            mode: 'plot',
            modules: ['weibo', 'community', 'live'],
            evidence: {
                weibo: '微博出现城市活动预告',
                community: '论坛有人开了讨论帖',
                live: '电视台直播正在准备',
            },
        },
        weibo: {
            posts: [{
                id: 'partial-post', authorType: 'npc', author: '路人', content: '夜晚随手拍。',
                hotComments: [{ content: '灯光很好看。' }],
            }],
            hotTopics: [{ title: '无效热搜会单独跳过', postId: 'missing-post' }],
        },
        community: {
            forumThreads: [{ id: 'partial-forum', title: '夜聊楼', comments: [{ content: '来啦。' }] }],
            cpRankings: [],
            fanWorks: [],
        },
        live: {
            official: [{ id: 'partial-live', title: '夜间直播', scenes: [{ text: '镜头扫过夜景。' }], barrages: ['晚安'] }],
            private: [],
        },
    };
    const phoneSession = { settings, ensure: async () => store, save: async () => store };

    const result = await requestPhoneWorldStoryUpdate(phoneSession, context, 0, {
        generate: async () => ({ content: JSON.stringify(response) }),
        contextClients: {
            getPowerUser: () => ({ persona_description: '普通用户。' }),
            getMaxContextSize: () => 32768,
            getWorldInfoPrompt: async () => ({}),
            retrieveAndInject: async () => undefined,
        },
    });

    assert.deepEqual(result.modules, ['weibo', 'community', 'live']);
    assert.equal(settings.phone.weibo.posts.some(post => post.id === 'partial-post'), true);
    assert.equal(settings.phone.community.forumThreads.some(item => item.id === 'partial-forum'), true);
    assert.equal(settings.phone.live.streams.some(item => item.id === 'partial-live'), true);
    assert.equal(store.worldGeneration.status, 'partial');
    assert.ok(store.worldGeneration.warnings.length >= 4);
});

test('story-side phone update persists its real failure reason in the chat-scoped phone store', async () => {
    const store = createEmptyPhoneStore('phone-world-error');
    store.scopedInitialized = true;
    store.phone.weibo = { initialized: true, roleAccounts: [] };
    const settings = {
        apis: { barrage: { url: 'https://example.com/v1', apiKey: 'key', model: 'model' } },
        development: { enabled: false },
        map: { includeInPrompt: false },
        phone: store.phone,
    };
    const context = {
        getCurrentChatId: () => store.chatId,
        chatMetadata: {},
        chat: [{ is_user: false, mes: '正文继续。' }],
    };
    let saves = 0;
    const phoneSession = { settings, ensure: async () => store, save: async () => { saves++; return store; } };

    await assert.rejects(() => requestPhoneWorldStoryUpdate(phoneSession, context, 0, {
        generate: async () => ({ content: '{"unexpected":true}' }),
        contextClients: {
            getPowerUser: () => ({}),
            getMaxContextSize: () => 32768,
            getWorldInfoPrompt: async () => ({}),
            retrieveAndInject: async () => undefined,
        },
    }), /没有返回可用的模块记录/);

    assert.equal(store.worldGeneration.status, 'error');
    assert.match(store.worldGeneration.lastError, /没有返回可用的模块记录/);
    assert.ok(saves >= 2);
});

test('the same story source shares one in-flight phone request across duplicate lifecycle events', async () => {
    const store = createEmptyPhoneStore('phone-world-in-flight');
    store.scopedInitialized = true;
    store.phone.weibo = { initialized: true, roleAccounts: [] };
    const settings = {
        apis: { barrage: { url: 'https://example.com/v1', apiKey: 'key', model: 'model' } },
        development: { enabled: false },
        map: { includeInPrompt: false },
        phone: store.phone,
    };
    const context = {
        getCurrentChatId: () => store.chatId,
        chatMetadata: {},
        chat: [{ is_user: false, mes: '同一条正文只应更新一次手机。' }],
    };
    let calls = 0;
    let release;
    const responseReady = new Promise(resolve => { release = resolve; });
    const options = {
        generate: async () => {
            calls++;
            await responseReady;
            return { content: JSON.stringify({
                decision: { mode: 'daily', modules: ['weibo'] },
                weibo: {
                    posts: [{ id: 'daily-post', authorType: 'npc', author: '路人', content: '与正文无关的城市读书会开幕。' }],
                    hotTopics: [],
                },
            }) };
        },
        random: () => 0,
        contextClients: {
            getPowerUser: () => ({}),
            getMaxContextSize: () => 32768,
            getWorldInfoPrompt: async () => ({}),
            retrieveAndInject: async () => undefined,
        },
    };
    const phoneSession = { settings, ensure: async () => store, save: async () => store };

    const first = requestPhoneWorldStoryUpdate(phoneSession, context, 0, options);
    const second = requestPhoneWorldStoryUpdate(phoneSession, context, 0, options);
    assert.equal(first, second);
    release();
    await Promise.all([first, second]);

    assert.equal(calls, 1);
    assert.equal(store.storyBatches.length, 1);
    assert.equal(store.worldGeneration.status, 'partial');
});

test('manual force regeneration replaces the saved batch for the same story floor', async () => {
    const store = createEmptyPhoneStore('phone-world-force-regeneration');
    store.scopedInitialized = true;
    store.phone.weibo = { initialized: true, roleAccounts: [] };
    const settings = {
        apis: { barrage: { url: 'https://example.com/v1', apiKey: 'key', model: 'model' } },
        phoneAutomation: { autoWorldUpdatesEnabled: false },
        development: { enabled: false },
        map: { includeInPrompt: false },
        phone: store.phone,
    };
    const context = {
        getCurrentChatId: () => store.chatId,
        chatMetadata: {},
        chat: [{ is_user: false, mes: '正文没有公共事件，更新一项日常背景。' }],
    };
    let calls = 0;
    const options = {
        random: () => 0,
        generate: async () => {
            calls++;
            return { content: JSON.stringify({
                decision: { mode: 'daily', modules: ['weibo'] },
                weibo: {
                    posts: [{ id: `daily-post-${calls}`, authorType: 'npc', author: '路人', content: `背景动态${calls}` }],
                    hotTopics: [],
                },
            }) };
        },
        contextClients: {
            getPowerUser: () => ({}),
            getMaxContextSize: () => 32768,
            getWorldInfoPrompt: async () => ({}),
            retrieveAndInject: async () => undefined,
        },
    };
    const phoneSession = { settings, ensure: async () => store, save: async () => store };

    await requestPhoneWorldStoryUpdate(phoneSession, context, 0, options);
    assert.equal((await requestPhoneWorldStoryUpdate(phoneSession, context, 0, options)).duplicate, true);
    await requestPhoneWorldStoryUpdate(phoneSession, context, 0, { ...options, force: true });

    assert.equal(calls, 2);
    assert.equal(store.storyBatches.length, 1);
    assert.deepEqual(store.storyBatches[0].items.weibo, ['daily-post-2']);
    assert.equal(settings.phone.weibo.posts.some(post => post.id === 'daily-post-1'), false);
    assert.equal(settings.phone.weibo.posts.some(post => post.id === 'daily-post-2'), true);
});

test('evidence-backed story messages preserve whether the player sent or received them', async () => {
    const store = createEmptyPhoneStore('phone-world-direction');
    store.scopedInitialized = true;
    store.profile.nickname = '季宁';
    store.phone.profile = { nickname: '季宁', accountId: 'main', isMask: false };
    store.phone.weibo = { initialized: true, roleAccounts: [] };
    const conversation = createPhoneConversation(store, { type: 'direct', name: '张伯' });
    const settings = {
        apis: { barrage: { url: 'https://example.com/v1', apiKey: 'key', model: 'model' } },
        development: { enabled: false },
        map: { includeInPrompt: false },
        phone: store.phone,
    };
    const context = {
        getCurrentChatId: () => store.chatId,
        name1: '季宁',
        chatMetadata: {},
        chat: [{ is_user: false, mes: '季宁用手机发给张伯：“给她介绍个工作。”' }],
    };
    const record = {
        module: 'messages',
        data: {
            conversations: [{
                conversationId: conversation.id,
                messages: [{ sender: '季宁', fromUser: true, type: 'text', content: '给她介绍个工作。' }],
            }],
        },
    };
    const phoneSession = { settings, ensure: async () => store, save: async () => store };

    await requestPhoneWorldStoryUpdate(phoneSession, context, 0, {
        generate: async () => ({ content: [
            JSON.stringify({
                module: 'decision',
                data: {
                    mode: 'plot',
                    modules: ['messages'],
                    evidence: { messages: '季宁用手机发给张伯' },
                },
            }),
            JSON.stringify(record),
        ].join('\n') }),
        contextClients: {
            getPowerUser: () => ({}),
            getMaxContextSize: () => 32768,
            getWorldInfoPrompt: async () => ({}),
            retrieveAndInject: async () => undefined,
        },
    });

    const saved = store.conversations[0].messages.at(-1);
    assert.equal(saved.sender, '季宁');
    assert.equal(saved.fromUser, true);
    assert.equal(saved.content, '给她介绍个工作。');
});
