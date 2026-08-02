import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BARRAGE_METADATA_KEY,
    collectRecentMessages,
    handleCharacterMessageRendered,
    restoreStoredBarrages,
} from '../barrage-ui.js';
import { STORY_STATUS_METADATA_KEY } from '../story-status.js';
import { getCharacterDevelopmentSnapshot } from '../character-development.js';

function createSettings({ includeRag = false } = {}) {
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
        status: { enabled: true, showGoals: true, customFields: [] },
    };
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
    assert.equal(context.chatMetadata[BARRAGE_METADATA_KEY]['5'].content, '观众弹幕结果');
    assert.equal(context.chatMetadata[STORY_STATUS_METADATA_KEY]['5'].status.environment.location, '王城 → 酒馆');
    assert.equal(Number.isInteger(context.chatMetadata[BARRAGE_METADATA_KEY]['5'].timestamp), true);
    assert.deepEqual(
        Object.keys(context.chatMetadata[BARRAGE_METADATA_KEY]['5']).sort(),
        ['content', 'timestamp'],
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
    assert.equal(searchPayload.worldInfoTopK, 7);
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
    const result = await handleCharacterMessageRendered(5, settings, context, {
        async generateBarrage() {
            requested = true;
            return { content: 'unexpected' };
        },
    });

    assert.equal(result.reason, 'missing-config');
    assert.equal(requested, false);
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
        assert.equal(context.chatMetadata[BARRAGE_METADATA_KEY]['5'].state, 'error');
        assert.match(context.chatMetadata[BARRAGE_METADATA_KEY]['5'].error, /side API unavailable/);
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
    context.chatMetadata[BARRAGE_METADATA_KEY] = {
        5: { content: 'old barrage', timestamp: 1 },
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
    assert.equal(context.chatMetadata[BARRAGE_METADATA_KEY]['5'].content, 'new barrage');
    assert.equal(context.chatMetadata[STORY_STATUS_METADATA_KEY]['5'].status.environment.location, '旧状态仍应保留');
    assert.equal(context.saves, 2, 'the stale barrage is removed before the replacement is saved');
});
