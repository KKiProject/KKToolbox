import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BARRAGE_METADATA_KEY,
    clearDeletedBarrageRecords,
    collectRecentMessages,
    findLatestEligibleAssistantMessageId,
    handleCharacterMessageRendered,
    restoreStoredBarrages,
} from '../barrage-ui.js';
import { hashStorySource, STORY_STATUS_METADATA_KEY } from '../story-status.js';
import { getCharacterDevelopmentSnapshot } from '../character-development.js';

function createSettings({ includeRag = false, statusEnabled = true } = {}) {
    return {
        apis: {
            embedding: includeRag
                ? { url: 'https://embedding.example/v1/', apiKey: 'embed-key', model: 'embed-model' }
                : { url: '', apiKey: '', model: '' },
            reranker: { url: '', apiKey: '', model: '' },
            barrage: { url: 'https://barrage.example/v1/', apiKey: 'barrage-key', model: 'barrage-model' },
        },
        rag: { topK: 9, topN: 2, rerankerThreshold: 0.3 },
        barrage: {
            enabled: true,
            recentMessages: 3,
            maxTokens: 4064,
            includeRag,
            systemPrompt: 'audience system prompt',
        },
        status: { enabled: statusEnabled, showGoals: true, customFields: [] },
    };
}

function getBarrageVariants(context, messageId = 5) {
    return context.chatMetadata[BARRAGE_METADATA_KEY]?.[String(messageId)]?.variants ?? {};
}

function getOnlyBarrageVariant(context, messageId = 5) {
    const variants = Object.values(getBarrageVariants(context, messageId));
    assert.equal(variants.length, 1);
    return variants[0];
}

function createContext() {
    let saves = 0;
    return {
        chatId: 'barrage-chat',
        chat: Array.from({ length: 6 }, (_, index) => ({
            name: index % 2 ? 'Character' : 'User',
            is_user: index % 2 === 0,
            is_system: false,
            mes: `message ${index}`,
        })),
        chatMetadata: {},
        async saveMetadata() {
            saves++;
        },
        get saves() {
            return saves;
        },
    };
}

test('recent floor setting selects N recap messages plus the rendered AI response', () => {
    const context = createContext();
    assert.deepEqual(
        collectRecentMessages(context.chat, 5, 3).map(message => message.id),
        [2, 3, 4, 5],
    );
});

test('latest recovery skips streaming placeholders and finds the newest finished assistant floor', () => {
    const context = createContext();
    context.chat.push({ is_user: false, is_system: false, mes: '...' });
    assert.equal(findLatestEligibleAssistantMessageId(context), 5);
    context.chat.push({ is_user: false, is_system: true, mes: 'hidden system floor' });
    assert.equal(findLatestEligibleAssistantMessageId(context), 5);
    context.chat.push({ is_user: false, is_system: false, mes: 'finished reply' });
    assert.equal(findLatestEligibleAssistantMessageId(context), 8);
});

test('barrage generation renders and caches without mutating context.chat', async () => {
    const context = createContext();
    const originalChat = structuredClone(context.chat);
    const renders = [];
    let requestBody;
    const result = await handleCharacterMessageRendered(5, createSettings(), context, {
        renderBarrage: (...args) => renders.push(args),
        getCurrentContext: () => context,
        async generateBarrage(payload) {
            requestBody = payload;
            return { content: JSON.stringify({
                barrage: '观众弹幕结果',
                status: {
                    environment: { time: '夜晚', location: '王城 → 酒馆', season: '冬季', weather: '雪' },
                    characters: [{ name: '玩家', role: 'user', emotion: '警觉' }],
                    event: { activity: '交谈', situation: '局势紧张', goals: ['找到线索'] },
                },
            }) };
        },
    });

    assert.equal(result.generated, true);
    assert.deepEqual(context.chat, originalChat);
    assert.deepEqual(requestBody.recentMessages.map(message => message.id), [2, 3, 4, 5]);
    assert.deepEqual(requestBody.ragFragments, []);
    assert.equal(requestBody.barrage.baseUrl, 'https://barrage.example');
    assert.equal(requestBody.systemPrompt, 'audience system prompt');
    assert.equal(requestBody.maxTokens, 4064);
    assert.equal(renders.at(-1)[1], '观众弹幕结果');
    assert.equal(renders.at(-1)[2], 'ready');
    const storedBarrage = getOnlyBarrageVariant(context);
    assert.equal(storedBarrage.content, '观众弹幕结果');
    assert.equal(context.chatMetadata[STORY_STATUS_METADATA_KEY]['5'].status.environment.location, '王城 → 酒馆');
    assert.equal(Number.isInteger(storedBarrage.timestamp), true);
    assert.equal(storedBarrage.sourceHash, hashStorySource(context.chat[5].mes));
    assert.equal(context.chatMetadata[BARRAGE_METADATA_KEY]['5'].version, 3);
    assert.equal(getBarrageVariants(context)['swipe:0'].content, '观众弹幕结果');
    assert.deepEqual(
        Object.keys(storedBarrage).sort(),
        ['content', 'sourceHash', 'timestamp'],
    );
    assert.equal(context.saves, 1);

    let generatedAgain = false;
    const cached = await handleCharacterMessageRendered(5, createSettings(), context, {
        renderBarrage: () => undefined,
        getCurrentContext: () => context,
        async generateBarrage() {
            generatedAgain = true;
            return { content: 'unexpected' };
        },
    });
    assert.equal(cached.cached, true);
    assert.equal(generatedAgain, false);
    assert.deepEqual(context.chat, originalChat);
});

test('RAG switch attaches retrieved fragments to the barrage request', async () => {
    const context = createContext();
    let searchPayload;
    let barragePayload;
    const result = await handleCharacterMessageRendered(5, createSettings({ includeRag: true }), context, {
        renderBarrage: () => undefined,
        getCurrentContext: () => context,
        async searchMemory(payload) {
            searchPayload = payload;
            return { results: [{ id: 'memory', text: 'recalled history' }] };
        },
        async generateBarrage(payload) {
            barragePayload = payload;
            return { content: 'with rag' };
        },
    });

    assert.equal(result.generated, true);
    assert.equal(result.ragCount, 1);
    assert.equal(searchPayload.separate, true);
    assert.equal(searchPayload.chatTopK, 9);
    assert.equal(searchPayload.worldInfoTopK, 10);
    assert.equal(searchPayload.embedding.baseUrl, 'https://embedding.example');
    assert.deepEqual(searchPayload.scope, {
        chat_id: 'barrage-chat',
        chat_message_id_before: 2,
        book_ids: [],
    });
    assert.equal(barragePayload.ragFragments[0].text, 'recalled history');
});

test('missing barrage API configuration produces no request or chat mutation', async () => {
    const context = createContext();
    const originalChat = structuredClone(context.chat);
    const settings = createSettings();
    settings.apis.barrage = { url: '', apiKey: '', model: '' };
    let requested = false;
    const renders = [];
    const result = await handleCharacterMessageRendered(5, settings, context, {
        renderBarrage: (...args) => renders.push(args),
        async generateBarrage() {
            requested = true;
            return { content: 'unexpected' };
        },
    });

    assert.equal(result.reason, 'missing-config');
    assert.equal(requested, false);
    assert.equal(renders.at(-1)[2], 'error');
    assert.match(renders.at(-1)[1], /Base URL.*API Key.*模型名/);
    assert.deepEqual(context.chat, originalChat);
});

test('status can run without rendering or storing barrage', async () => {
    const context = createContext();
    const settings = createSettings();
    settings.barrage.enabled = false;
    let rendered = false;
    const result = await handleCharacterMessageRendered(5, settings, context, {
        renderBarrage: () => rendered = true,
        getCurrentContext: () => context,
        async generateBarrage(payload) {
            assert.deepEqual(payload.outputOptions, {
                barrageEnabled: false,
                statusEnabled: true,
                developmentEnabled: false,
            });
            return { content: JSON.stringify({
                barrage: '',
                status: {
                    environment: { time: '清晨' },
                    characters: [{ name: '玩家', role: 'user' }, { name: '角色', role: 'char' }],
                    event: { activity: '赶路' },
                },
            }) };
        },
    });

    assert.equal(result.generated, true);
    assert.equal(rendered, false);
    assert.equal(context.chatMetadata[BARRAGE_METADATA_KEY], undefined);
    assert.equal(context.chatMetadata[STORY_STATUS_METADATA_KEY]['5'].status.environment.time, '清晨');
});

test('missing status in a combined response gets one focused recovery request without losing barrage', async () => {
    const context = createContext();
    let calls = 0;
    const result = await handleCharacterMessageRendered(5, createSettings(), context, {
        renderBarrage: () => true,
        getCurrentContext: () => context,
        async generateBarrage(payload) {
            calls++;
            if (calls === 1) {
                assert.equal(payload.outputOptions.barrageEnabled, true);
                return { content: '先保留下来的弹幕' };
            }
            assert.deepEqual(payload.outputOptions, {
                barrageEnabled: false,
                statusEnabled: true,
                developmentEnabled: false,
            });
            return { content: JSON.stringify({
                barrage: '',
                status: {
                    environment: { time: '深夜', location: '走廊' },
                    characters: [{ name: '玩家', role: 'user' }],
                    event: { activity: '等待' },
                },
            }) };
        },
    });
    assert.equal(calls, 2);
    assert.equal(result.generated, true);
    assert.equal(result.statusSaved, true);
    assert.equal(getOnlyBarrageVariant(context).content, '先保留下来的弹幕');
    assert.equal(context.chatMetadata[STORY_STATUS_METADATA_KEY]['5'].status.environment.location, '走廊');
});

test('player-declared character development shares the same side request and is cached', async () => {
    const context = createContext();
    context.chat[4].mes = '十年后，Character 已经从开朗变得阴郁寡言。';
    const settings = createSettings();
    settings.development = { enabled: true };
    let calls = 0;
    const dependencies = {
        renderBarrage: () => true,
        getCurrentContext: () => context,
        async generateBarrage(payload) {
            calls++;
            assert.equal(payload.outputOptions.developmentEnabled, true);
            return { content: JSON.stringify({
                barrage: '时间跳跃！',
                status: {
                    environment: { time: '十年后' },
                    characters: [{ name: 'User', role: 'user' }, { name: 'Character', role: 'char' }],
                    event: { activity: '重逢' },
                },
                timeline: { transition: 'jump', currentTime: '十年后', elapsed: '十年后', segments: [] },
                development: { changes: [{
                    character: 'Character',
                    dimension: 'temperament',
                    before: '开朗',
                    after: '阴郁寡言',
                    reason: '',
                    source: 'user_direct',
                    evidence: [{ messageId: 4, quote: '十年后，Character 已经从开朗变得阴郁寡言。' }],
                }] },
            }) };
        },
    };

    const generated = await handleCharacterMessageRendered(5, settings, context, dependencies);
    assert.equal(generated.development.confirmed, 1);
    assert.equal(getCharacterDevelopmentSnapshot(context).profiles[0].fields[0].value, '阴郁寡言');
    const cached = await handleCharacterMessageRendered(5, settings, context, dependencies);
    assert.equal(cached.cached, true);
    assert.equal(calls, 1);
});

test('RAG failure is isolated and barrage generation continues with recent messages only', async () => {
    const context = createContext();
    let barragePayload;
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
        const result = await handleCharacterMessageRendered(5, createSettings({ includeRag: true }), context, {
            renderBarrage: () => undefined,
            getCurrentContext: () => context,
            async searchMemory() {
                throw new Error('embedding unavailable');
            },
            async generateBarrage(payload) {
                barragePayload = payload;
                return { content: 'without rag' };
            },
        });

        assert.equal(result.generated, true);
        assert.deepEqual(barragePayload.ragFragments, []);
        assert.deepEqual(barragePayload.recentMessages.map(message => message.id), [2, 3, 4, 5]);
    } finally {
        console.warn = originalWarn;
    }
});

test('barrage API and render failures do not reject or mutate chat', async () => {
    const context = createContext();
    const originalChat = structuredClone(context.chat);
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
        const result = await handleCharacterMessageRendered(5, createSettings(), context, {
            renderBarrage() {
                throw new Error('DOM unavailable');
            },
            async generateBarrage() {
                throw new Error('side API unavailable');
            },
        });

        assert.equal(result.generated, false);
        assert.match(result.error.message, /side API unavailable/);
        assert.deepEqual(context.chat, originalChat);
        const storedBarrage = getOnlyBarrageVariant(context);
        assert.equal(storedBarrage.state, 'error');
        assert.match(storedBarrage.error, /side API unavailable/);
    } finally {
        console.warn = originalWarn;
    }
});

test('barrage panel displays the detailed upstream API error', async () => {
    const context = createContext();
    const renders = [];
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
        const result = await handleCharacterMessageRendered(5, createSettings(), context, {
            renderBarrage: (...args) => renders.push(args),
            async generateBarrage() {
                throw new Error('Barrage API returned 402: Insufficient balance');
            },
        });

        assert.equal(result.generated, false);
        assert.equal(renders.at(-1)[2], 'error');
        assert.match(renders.at(-1)[1], /402: Insufficient balance/);
    } finally {
        console.warn = originalWarn;
    }
});

test('a failed barrage is restored after reopening and still offers the same-floor retry panel', async () => {
    const context = createContext();
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
        await handleCharacterMessageRendered(5, createSettings(), context, {
            renderBarrage: () => true,
            async generateBarrage() {
                throw new Error('temporary upstream failure');
            },
        });
        const renders = [];
        restoreStoredBarrages(context, createSettings(), (...args) => renders.push(args));
        assert.equal(renders.length, 1);
        assert.equal(renders[0][0], '5');
        assert.equal(renders[0][2], 'error');
        assert.match(renders[0][1], /重新生成弹幕/);
    } finally {
        console.warn = originalWarn;
    }
});

test('forced regeneration bypasses the stored barrage and replaces it', async () => {
    const context = createContext();
    const sourceHash = hashStorySource(context.chat[5].mes);
    context.chatMetadata[BARRAGE_METADATA_KEY] = {
        5: {
            version: 3,
            variants: {
                'swipe:0': { content: 'old barrage', sourceHash, timestamp: 1 },
            },
        },
    };
    context.chatMetadata[STORY_STATUS_METADATA_KEY] = {
        5: {
            status: {
                environment: { location: '旧状态仍应保留' },
                characters: [],
                event: {},
            },
        },
    };

    const result = await handleCharacterMessageRendered(5, createSettings(), context, {
        renderBarrage: () => undefined,
        getCurrentContext: () => context,
        async generateBarrage() {
            return { content: 'new barrage' };
        },
    }, { force: true });

    assert.equal(result.generated, true);
    assert.equal(getOnlyBarrageVariant(context).content, 'new barrage');
    assert.equal(context.chatMetadata[STORY_STATUS_METADATA_KEY]['5'].status.environment.location, '旧状态仍应保留');
    assert.equal(context.saves, 2, 'the stale barrage is removed before the replacement is saved');
});

test('forced status regeneration updates only status and preserves barrage and development', async () => {
    const context = createContext();
    const settings = createSettings();
    settings.development = { enabled: true };
    context.chat[5].mes = '角色决定保护玩家。';
    let calls = 0;
    const dependencies = {
        renderBarrage: () => true,
        getCurrentContext: () => context,
        async generateBarrage(payload) {
            calls++;
            if (calls === 1) {
                return { content: JSON.stringify({
                    barrage: '应当保留的弹幕',
                    status: { environment: { location: '旧地点' }, characters: [], event: { activity: '交谈' } },
                    development: { changes: [{
                        character: '角色',
                        dimension: 'relationship',
                        target: '玩家',
                        after: '决定保护玩家',
                        source: 'observed',
                        evidence: [{ messageId: 5, quote: '角色决定保护玩家。' }],
                    }] },
                }) };
            }
            assert.deepEqual(payload.outputOptions, {
                barrageEnabled: false,
                statusEnabled: true,
                developmentEnabled: false,
            });
            return { content: JSON.stringify({
                barrage: '',
                status: { environment: { location: '新地点' }, characters: [], event: { activity: '继续交谈' } },
                timeline: { transition: 'unchanged' },
                development: null,
            }) };
        },
    };

    await handleCharacterMessageRendered(5, settings, context, dependencies);
    const before = getCharacterDevelopmentSnapshot(context, { includeCandidates: true });
    const regenerated = await handleCharacterMessageRendered(5, settings, context, dependencies, { forceStatus: true });

    assert.equal(regenerated.statusSaved, true);
    assert.equal(calls, 2);
    assert.equal(getBarrageVariants(context)['swipe:0'].content, '应当保留的弹幕');
    assert.equal(context.chatMetadata[STORY_STATUS_METADATA_KEY]['5'].status.environment.location, '新地点');
    assert.deepEqual(getCharacterDevelopmentSnapshot(context, { includeCandidates: true }), before);
});

test('each swiped reply keeps its own barrage and restores it when switched back', async () => {
    const context = createContext();
    const settings = createSettings({ statusEnabled: false });
    context.chat[5].swipes = ['first reply', 'second reply'];
    context.chat[5].swipe_id = 0;
    context.chat[5].mes = 'first reply';
    const renders = [];
    let calls = 0;
    const dependencies = {
        renderBarrage: (...args) => renders.push(args),
        getCurrentContext: () => context,
        async generateBarrage() {
            calls++;
            return { content: `barrage for ${context.chat[5].mes}` };
        },
    };

    await handleCharacterMessageRendered(5, settings, context, dependencies);
    context.chat[5].swipe_id = 1;
    context.chat[5].mes = 'second reply';
    await handleCharacterMessageRendered(5, settings, context, dependencies);

    assert.equal(Object.keys(getBarrageVariants(context)).length, 2);
    assert.equal(calls, 2);

    context.chat[5].swipe_id = 0;
    context.chat[5].mes = 'first reply';
    const restored = await handleCharacterMessageRendered(5, settings, context, dependencies);
    assert.equal(restored.cached, true);
    assert.equal(calls, 2, 'switching back must restore instead of regenerating');
    assert.equal(renders.at(-1)[1], 'barrage for first reply');
    assert.equal(renders.at(-1)[2], 'ready');
});

test('each swiped reply restores its own status and development without another side API call', async () => {
    const context = createContext();
    const settings = createSettings();
    settings.development = { enabled: true };
    context.chat[5].swipes = ['角色决定敌视玩家。', '角色决定保护玩家。'];
    context.chat[5].swipe_id = 0;
    context.chat[5].mes = context.chat[5].swipes[0];
    let calls = 0;
    const dependencies = {
        renderBarrage: () => true,
        getCurrentContext: () => context,
        async generateBarrage() {
            calls++;
            const protects = context.chat[5].swipe_id === 1;
            const reply = context.chat[5].mes;
            return { content: JSON.stringify({
                barrage: protects ? '保护分支弹幕' : '敌对分支弹幕',
                status: {
                    environment: { location: protects ? '城门' : '地牢' },
                    characters: [],
                    event: { activity: protects ? '保护玩家' : '敌视玩家' },
                },
                development: { changes: [{
                    character: '角色',
                    dimension: 'relationship',
                    target: '玩家',
                    after: protects ? '决定保护玩家' : '决定敌视玩家',
                    source: 'observed',
                    evidence: [{ messageId: 5, quote: reply }],
                }] },
            }) };
        },
    };

    await handleCharacterMessageRendered(5, settings, context, dependencies);
    context.chat[5].swipe_id = 1;
    context.chat[5].mes = context.chat[5].swipes[1];
    await handleCharacterMessageRendered(5, settings, context, dependencies);
    assert.equal(calls, 2);
    assert.equal(context.chatMetadata[STORY_STATUS_METADATA_KEY]['5'].status.environment.location, '城门');

    context.chat[5].swipe_id = 0;
    context.chat[5].mes = context.chat[5].swipes[0];
    const restored = await handleCharacterMessageRendered(5, settings, context, dependencies);

    assert.equal(restored.cached, true);
    assert.equal(calls, 2, 'switching back must restore all side results without calling the API');
    assert.equal(context.chatMetadata[STORY_STATUS_METADATA_KEY]['5'].status.environment.location, '地牢');
    const candidates = getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].after, '决定敌视玩家');
});

test('editing a reply keeps and reattaches the barrage for the same swipe', async () => {
    const context = createContext();
    const settings = createSettings({ statusEnabled: false });
    context.chat[5].swipes = ['original reply', 'other reply'];
    context.chat[5].swipe_id = 0;
    context.chat[5].mes = 'original reply';
    const renders = [];
    let calls = 0;
    const dependencies = {
        renderBarrage: (...args) => renders.push(args),
        getCurrentContext: () => context,
        async generateBarrage() {
            calls++;
            return { content: 'keep this barrage' };
        },
    };

    await handleCharacterMessageRendered(5, settings, context, dependencies);
    context.chat[5].mes = 'edited reply';
    context.chat[5].swipes[0] = 'edited reply';
    const restored = await handleCharacterMessageRendered(5, settings, context, dependencies);

    assert.equal(restored.cached, true);
    assert.equal(calls, 1, 'editing must not regenerate or replace the existing barrage');
    assert.equal(Object.keys(getBarrageVariants(context)).length, 1);
    assert.equal(getBarrageVariants(context)['swipe:0'].content, 'keep this barrage');
    assert.equal(renders.at(-1)[1], 'keep this barrage');
    assert.equal(renders.at(-1)[2], 'ready');
});

test('editing a reply preserves its barrage but replaces status and development derived from the old text', async () => {
    const context = createContext();
    const settings = createSettings();
    settings.development = { enabled: true };
    context.chat[5].swipes = ['角色开始敌视玩家。'];
    context.chat[5].swipe_id = 0;
    context.chat[5].mes = '角色开始敌视玩家。';
    let calls = 0;
    const dependencies = {
        renderBarrage: () => true,
        getCurrentContext: () => context,
        async generateBarrage(payload) {
            calls++;
            if (calls === 1) {
                return { content: JSON.stringify({
                    barrage: '保留下来的旧弹幕',
                    status: {
                        environment: { location: '旧地点' },
                        characters: [],
                        event: { activity: '彼此敌对' },
                    },
                    development: { changes: [{
                        character: '角色',
                        dimension: 'relationship',
                        target: '玩家',
                        after: '开始敌视玩家',
                        source: 'observed',
                        evidence: [{ messageId: 5, quote: '角色开始敌视玩家。' }],
                    }] },
                }) };
            }
            assert.deepEqual(payload.outputOptions, {
                barrageEnabled: false,
                statusEnabled: true,
                developmentEnabled: true,
            });
            return { content: JSON.stringify({
                status: {
                    environment: { location: '新地点' },
                    characters: [],
                    event: { activity: '保护玩家' },
                },
                development: { changes: [{
                    character: '角色',
                    dimension: 'relationship',
                    target: '玩家',
                    after: '决定保护玩家',
                    source: 'observed',
                    evidence: [{ messageId: 5, quote: '角色决定保护玩家。' }],
                }] },
            }) };
        },
    };

    await handleCharacterMessageRendered(5, settings, context, dependencies);
    context.chat[5].mes = '角色决定保护玩家。';
    context.chat[5].swipes[0] = context.chat[5].mes;
    await handleCharacterMessageRendered(5, settings, context, dependencies, { refreshDerived: true });

    assert.equal(calls, 2);
    assert.equal(getBarrageVariants(context)['swipe:0'].content, '保留下来的旧弹幕');
    assert.equal(context.chatMetadata[STORY_STATUS_METADATA_KEY]['5'].status.environment.location, '新地点');
    const candidates = getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].after, '决定保护玩家');
});

test('version 2 text-hash barrages migrate to swipe slots without losing an edited current reply', () => {
    const context = createContext();
    context.chat[5].swipes = ['edited current reply', 'other reply'];
    context.chat[5].swipe_id = 0;
    context.chat[5].mes = 'edited current reply';
    const oldCurrentHash = hashStorySource('current reply before edit');
    const otherHash = hashStorySource('other reply');
    context.chatMetadata[BARRAGE_METADATA_KEY] = {
        5: {
            version: 2,
            variants: {
                [oldCurrentHash]: { content: 'current barrage', sourceHash: oldCurrentHash, timestamp: 1 },
                [otherHash]: { content: 'other barrage', sourceHash: otherHash, timestamp: 2 },
            },
        },
    };
    const renders = [];

    restoreStoredBarrages(context, createSettings({ statusEnabled: false }), (...args) => renders.push(args));

    const bucket = context.chatMetadata[BARRAGE_METADATA_KEY]['5'];
    assert.equal(bucket.version, 3);
    assert.equal(bucket.variants['swipe:0'].content, 'current barrage');
    assert.equal(bucket.variants['swipe:1'].content, 'other barrage');
    assert.equal(renders.at(-1)[1], 'current barrage');
});

test('regenerating a reply clears the deleted floor so the replacement must get a new barrage', async () => {
    const context = createContext();
    const settings = createSettings({ statusEnabled: false });
    context.chat[5].swipes = ['old reply'];
    context.chat[5].swipe_id = 0;
    context.chat[5].mes = 'old reply';
    let calls = 0;
    const dependencies = {
        renderBarrage: () => true,
        getCurrentContext: () => context,
        async generateBarrage() {
            calls++;
            return { content: calls === 1 ? 'old barrage' : 'new barrage' };
        },
    };

    await handleCharacterMessageRendered(5, settings, context, dependencies);
    assert.equal(getBarrageVariants(context)['swipe:0'].content, 'old barrage');

    // SillyTavern's "regenerate" deletes the AI message, then creates its
    // replacement at the same floor and swipe index.
    context.chat.pop();
    const cleared = await clearDeletedBarrageRecords(context, 5);
    context.chat.push({
        name: 'Character',
        is_user: false,
        is_system: false,
        mes: 'new reply',
        swipes: ['new reply'],
        swipe_id: 0,
    });
    const regenerated = await handleCharacterMessageRendered(5, settings, context, dependencies);

    assert.equal(cleared, true);
    assert.equal(regenerated.generated, true);
    assert.equal(calls, 2, 'the replacement reply must call the side API again');
    assert.equal(getBarrageVariants(context)['swipe:0'].content, 'new barrage');
});
