import assert from 'node:assert/strict';
import test from 'node:test';
import {
    findHistoricalInsertionIndex,
    formatMemoryMessage,
    memoryAugmentInterceptor,
    retrieveAndInject,
} from '../context-manager.js';
import { installNativeFetch } from './native-fetch-fixture.mjs';

function createSettings({ reranker = true, semanticWorldInfo = false, topK = 12, topN = 2, threshold = 0.4, recentMessages = 2 } = {}) {
    return {
        apis: {
            embedding: { url: 'https://embedding.example/v1/', apiKey: 'embed-key', model: 'embed-model' },
            reranker: reranker
                ? { url: 'https://reranker.example/v1/', apiKey: 'rerank-key', model: 'rerank-model' }
                : { url: '', apiKey: '', model: '' },
        },
        context: { recentMessages },
        rag: {
            topK,
            topN,
            rerankerThreshold: threshold,
            semanticWorldInfo,
            activeWorldInfoBookIds: semanticWorldInfo ? ['Book'] : [],
            semanticWorldInfoEntries: semanticWorldInfo ? ['Book::42'] : [],
        },
    };
}

function createChat(length = 6) {
    return Array.from({ length }, (_, index) => ({
        index,
        mes: `message ${index}`,
        is_user: index % 2 === 0,
        is_system: false,
        extra: {},
    }));
}

test('RAG can be temporarily disabled without changing the generation chat', async () => {
    const chat = createChat();
    const original = structuredClone(chat);
    let searched = false;
    const settings = createSettings();
    settings.rag.enabled = false;
    const result = await retrieveAndInject(chat, settings, { chatId: 'chat-disabled' }, {
        searchMemory: async () => {
            searched = true;
            return { chatResults: [] };
        },
    });

    assert.deepEqual(result, { injected: false, reason: 'disabled' });
    assert.deepEqual(chat, original);
    assert.equal(searched, false);
});

test('interceptor query, parameters, reranking, threshold, and insertion position are wired', async () => {
    const chat = createChat();
    let searchPayload;
    let rerankPayload;
    const result = await retrieveAndInject(chat, createSettings(), { chatId: 'chat-1' }, {
        async searchMemory(payload) {
            searchPayload = payload;
            return {
                results: [
                    { id: 'a', text: 'memory A' },
                    { id: 'b', text: 'memory B' },
                    { id: 'c', text: 'memory C' },
                ],
            };
        },
        async rerankMemory(payload) {
            rerankPayload = payload;
            return { results: [{ id: 'b', text: 'memory B', score: 0.9 }] };
        },
    });

    assert.equal(searchPayload.query, 'message 3\n\nmessage 4\n\nmessage 5');
    assert.equal(searchPayload.separate, true);
    assert.equal(searchPayload.chatTopK, 12);
    assert.equal(searchPayload.worldInfoTopK, 10);
    assert.equal(searchPayload.embedding.baseUrl, 'https://embedding.example');
    assert.deepEqual(searchPayload.scope, {
        chat_id: 'chat-1',
        chat_message_id_before: 4,
        chat_message_ranges: [],
        book_ids: [],
    });
    assert.equal(searchPayload.chatGlobalFallbackK, 3);
    assert.equal(rerankPayload.topN, 2);
    assert.equal(rerankPayload.threshold, 0.4);
    assert.equal(rerankPayload.reranker.baseUrl, 'https://reranker.example');
    assert.equal(result.usedReranker, true);
    assert.equal(result.insertionIndex, 0);
    assert.equal(chat[0].role, 'system');
    assert.equal(chat[0].extra.type, 'narrator');
    assert.match(chat[0].mes, /memory B/);
    assert.deepEqual(chat.slice(1).map(message => message.mes), createChat().map(message => message.mes));
});

test('falls back to vector order when reranker is not configured', async () => {
    const chat = createChat(4);
    let rerankerCalled = false;
    const result = await retrieveAndInject(chat, createSettings({ reranker: false, topN: 1, recentMessages: 1 }), { chatId: 'chat-2' }, {
        async searchMemory() {
            return { results: [{ text: 'vector first' }, { text: 'vector second' }] };
        },
        async rerankMemory() {
            rerankerCalled = true;
            return { results: [] };
        },
    });

    assert.equal(rerankerCalled, false);
    assert.equal(result.usedReranker, false);
    assert.equal(result.insertionIndex, 0);
    assert.equal(chat[0].extra.type, 'narrator');
    assert.match(chat[0].mes, /vector first/);
    assert.doesNotMatch(chat[0].mes, /vector second/);
    assert.deepEqual(chat.slice(1).map(message => message.mes), createChat(4).map(message => message.mes));
});

test('memory chunks are injected as raw text ordered by floor and segment index', () => {
    const message = formatMemoryMessage([
        { message_id: 38, segment_index: 0, text: '第三十八楼原文' },
        { message_id: 10, segment_index: 1, text: '第十楼第二段' },
        { message_id: 10, segment_index: 0, text: '第十楼第一段' },
    ]);
    assert.equal(message.mes, [
        '【历史召回附录】',
        '以下片段来自较早楼层，是根据当前内容检索出的可能相关历史。它们可能有用，也可能无关，仅供参考，不要求必须采用。',
        '若片段确与当前情境相关，应据此保持人物认知、事实与因果连续性；若无关则忽略。',
        '这些片段不是当前正在发生的场景，不得因此回退时间线或重复已经发生的事件。',
        '如与最近原文冲突，以最近原文和较晚楼层为准。',
        '',
        '[记忆召回-第10楼] 第十楼第一段',
        '',
        '[记忆召回-第10楼] 第十楼第二段',
        '',
        '[记忆召回-第38楼] 第三十八楼原文',
    ].join('\n'));
});

test('legacy multi-message chunks still produce a usable floor-range label', () => {
    const message = formatMemoryMessage([
        { message_ids: [10, 11, 12], text: '旧格式原文块' },
    ]);
    assert.match(message.mes, /^【历史召回附录】/);
    assert.match(message.mes, /\[记忆召回-第10-12楼\] 旧格式原文块$/);
});

test('recalled chunks carry their original time anchor instead of borrowing the current time', () => {
    const message = formatMemoryMessage([{
        message_id: 12,
        text: '她说三天前曾在花园见过候补。',
        timeline_time: '王历100年春三月初一',
        timeline_mainline_time: '王历100年春三月初一',
    }]);
    assert.match(message.mes, /该片段的历史时间锚点/);
    assert.match(message.mes, /当时场景：王历100年春三月初一/);
    assert.match(message.mes, /不得按当前回合重新解释/);
});

test('registered generation interceptor injects memory into a multi-turn generation chat', async (context) => {
    const chat = createChat(8);
    const originalSillyTavern = globalThis.SillyTavern;
    const originalFetch = globalThis.fetch;
    context.after(() => {
        globalThis.SillyTavern = originalSillyTavern;
        globalThis.fetch = originalFetch;
    });

    globalThis.SillyTavern = {
        getContext() {
            return {
                chatId: 'live-chat',
                getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
                extensionSettings: {
                    'st-memory-augment': createSettings({
                        reranker: false,
                        topK: 20,
                        topN: 1,
                        recentMessages: 3,
                    }),
                },
            };
        },
    };
    const fixture = installNativeFetch({
        chatDocument: {
            version: 1,
            kind: 'chat',
            scope_id: 'live-chat',
            chunks: [{
                id: 'history',
                message_id: 1,
                segment_index: 0,
                text: 'remembered event from earlier turns',
                type: 'chat',
            }],
        },
    });
    globalThis.fetch = fixture.fetch;

    await memoryAugmentInterceptor(chat, 8192, () => undefined, 'normal');

    assert.equal(chat.length, 9);
    assert.equal(chat[0].extra.type, 'narrator');
    assert.match(chat[0].mes, /^【历史上下文参考】/);
    assert.match(chat[0].mes, /remembered event from earlier turns/);
    assert.deepEqual(chat.slice(1).map(message => message.mes), createChat(8).map(message => message.mes));
});

test('semantic world info is independently retrieved and injected before chat memories', async () => {
    const chat = createChat(4);
    let searchPayload;
    await retrieveAndInject(
        chat,
        createSettings({ reranker: false, semanticWorldInfo: true, topN: 2, recentMessages: 1 }),
        { chatId: 'semantic-chat' },
        {
            async searchMemory(payload) {
                searchPayload = payload;
                return {
                    results: [
                        { type: 'chat', text: 'historical dialogue' },
                        { type: 'worldinfo', text: 'semantic setting', world_info_name: 'Setting' },
                    ],
                };
            },
        },
    );

    assert.deepEqual(searchPayload.scope, {
        chat_id: 'semantic-chat',
        chat_message_id_before: 3,
        chat_message_ranges: [],
        book_ids: ['Book'],
    });
    assert.match(chat[0].mes, /^【历史上下文参考】/);
    assert.equal(chat[0].extra.memory_augment_recall_type, 'history');
    assert.match(chat[3].mes, /^\[设定召回-/);
    assert.equal(chat[3].extra.memory_augment_recall_type, 'worldinfo');
    assert.deepEqual(chat.filter(message => /^message /.test(message.mes)).map(message => message.mes), createChat(4).map(message => message.mes));
});

test('an empty or failed source is not padded and does not suppress the other source', async () => {
    const chat = createChat(6);
    const result = await retrieveAndInject(
        chat,
        createSettings({ reranker: false, semanticWorldInfo: true, topN: 5 }),
        { chatId: 'partial-recall', chat: createChat(6) },
        {
            async searchMemory() {
                return {
                    chatResults: [],
                    worldInfoResults: [
                        { type: 'worldinfo', book_id: 'Book', entry_uid: 1, text: 'only available setting' },
                    ],
                    errors: { chat: 'chat store unavailable' },
                };
            },
        },
    );

    assert.equal(result.chatResultCount, 0);
    assert.equal(result.worldInfoResultCount, 1);
    assert.equal(chat.length, 7);
    assert.equal(chat[4].extra.memory_augment_recall_type, 'worldinfo');
    assert.deepEqual(chat.slice(5).map(message => message.mes), ['message 4', 'message 5']);
});

test('zero results inject nothing and leave generation messages unchanged', async () => {
    const chat = createChat(6);
    const snapshot = structuredClone(chat);
    const result = await retrieveAndInject(
        chat,
        createSettings({ reranker: false, semanticWorldInfo: true }),
        { chatId: 'empty-recall', chat: createChat(6) },
        {
            async searchMemory() {
                return { chatResults: [], worldInfoResults: [] };
            },
        },
    );

    assert.equal(result.injected, false);
    assert.equal(result.reason, 'filtered');
    assert.deepEqual(chat, snapshot);
});

test('chat and world-info candidates are independently reranked with separate limits', async () => {
    const chat = createChat(10);
    const rerankCalls = [];
    let searchPayload;
    const result = await retrieveAndInject(
        chat,
        createSettings({ semanticWorldInfo: true, topK: 6, topN: 2, recentMessages: 2 }),
        { chatId: 'separate-pools', chat: createChat(10) },
        {
            async searchMemory(payload) {
                searchPayload = payload;
                return {
                    chatResults: Array.from({ length: 6 }, (_, index) => ({
                        type: 'chat',
                        message_id: index,
                        text: `chat ${index}`,
                    })),
                    worldInfoResults: Array.from({ length: 7 }, (_, index) => ({
                        type: 'worldinfo',
                        book_id: 'Book',
                        entry_uid: index,
                        text: `world ${index}`,
                    })),
                };
            },
            async rerankMemory(payload) {
                rerankCalls.push(payload);
                return { results: payload.candidates.slice(0, payload.topN) };
            },
        },
    );

    assert.equal(searchPayload.chatTopK, 6);
    assert.equal(searchPayload.worldInfoTopK, 10);
    assert.equal(searchPayload.scope.chat_message_id_before, 8);
    assert.deepEqual(rerankCalls.map(call => call.topN).sort(), [2, 5]);
    assert.deepEqual(rerankCalls.map(call => call.candidates.length).sort(), [6, 7]);
    assert.equal(result.chatResultCount, 2);
    assert.equal(result.worldInfoResultCount, 5);
    assert.equal(chat[0].extra.memory_augment_recall_type, 'history');
    assert.equal(chat[9].extra.memory_augment_recall_type, 'worldinfo');
    assert.deepEqual(chat.filter(message => /^message /.test(message.mes)).map(message => message.mes), createChat(10).map(message => message.mes));
});

test('five recent and up to three recalled summaries jointly route the raw-memory search', async () => {
    const chat = createChat(12);
    const summaries = Array.from({ length: 10 }, (_, index) => ({
        uid: String(index),
        start: index * 10,
        end: index * 10 + 9,
        summary: `summary ${index}`,
    }));
    let summarySearchPayload;
    let rawSearchPayload;
    const result = await retrieveAndInject(
        chat,
        createSettings({ reranker: true, topK: 10, topN: 2, recentMessages: 2 }),
        { chatId: 'hierarchical-chat', chat: createChat(12) },
        {
            async getSummaries() { return summaries; },
            async syncSummaryMemory(payload) {
                assert.equal(payload.entries.length, 10);
                return { embedded: 10 };
            },
            async searchSummaryMemory(payload) {
                summarySearchPayload = payload;
                return {
                    results: ['0', '2', '4'].map(uid => ({
                        summary_uid: uid,
                        text: `summary ${uid}`,
                        type: 'summary',
                    })),
                };
            },
            async searchMemory(payload) {
                rawSearchPayload = payload;
                return {
                    chatResults: [{ message_id: 21, segment_index: 0, text: 'linked raw detail' }],
                    worldInfoResults: [],
                };
            },
            async rerankMemory(payload) {
                if (payload.candidates[0]?.type === 'summary') {
                    return { results: payload.candidates.slice(0, payload.topN) };
                }
                return { results: payload.candidates.slice(0, payload.topN) };
            },
        },
    );

    assert.equal(summarySearchPayload.topK, 10);
    assert.deepEqual(summarySearchPayload.summaryUids, ['0', '1', '2', '3', '4']);
    assert.equal(result.recalledSummaryCount, 3);
    assert.equal(result.recentSummaryCount, 5);
    assert.deepEqual(rawSearchPayload.scope.chat_message_ranges, [
        { start: 0, end: 9 },
        { start: 20, end: 29 },
        { start: 40, end: 49 },
        { start: 50, end: 59 },
        { start: 60, end: 69 },
        { start: 70, end: 79 },
        { start: 80, end: 89 },
        { start: 90, end: 99 },
    ]);
    assert.equal(rawSearchPayload.chatGlobalFallbackK, 3);
    assert.match(chat[0].mes, /\[相关旧总结\]/);
    assert.match(chat[0].mes, /\[近期固定总结\]/);
    assert.match(chat[0].mes, /linked raw detail/);
});

test('unchanged detailed summaries are synchronized only once while retrieval still runs every turn', async () => {
    const summaries = Array.from({ length: 6 }, (_, index) => ({
        uid: `stable-${index}`,
        start: index * 10,
        end: index * 10 + 9,
        summary: `stable summary ${index}`,
    }));
    let syncCalls = 0;
    let searchCalls = 0;
    const clients = {
        async getSummaries() { return summaries; },
        async syncSummaryMemory() { syncCalls++; return { embedded: summaries.length }; },
        async searchSummaryMemory() {
            searchCalls++;
            return { results: [{ summary_uid: 'stable-0', text: 'stable summary 0', type: 'summary' }] };
        },
        async searchMemory() { return { chatResults: [], worldInfoResults: [] }; },
    };
    const settings = createSettings({ reranker: false, recentMessages: 2 });
    const context = { chatId: 'stable-summary-sync-chat', chat: createChat(12) };

    await retrieveAndInject(createChat(12), settings, context, clients);
    await retrieveAndInject(createChat(12), settings, context, clients);

    assert.equal(syncCalls, 1);
    assert.equal(searchCalls, 2);
});

test('summary and memory counts are maxima and are never padded', async () => {
    const chat = createChat(4);
    const result = await retrieveAndInject(
        chat,
        createSettings({ reranker: false }),
        { chatId: 'small-summary-chat', chat: createChat(4) },
        {
            async getSummaries() {
                return [{ uid: 'only', start: 0, end: 2, summary: '唯一存在的总结。' }];
            },
            async searchMemory() { return { chatResults: [], worldInfoResults: [] }; },
        },
    );
    assert.equal(result.recentSummaryCount, 1);
    assert.equal(result.recalledSummaryCount, 0);
    assert.equal(result.chatResultCount, 0);
    assert.match(chat[0].mes, /唯一存在的总结/);
});

test('full interceptor keeps ST-provided messages, puts history at the beginning, and keeps settings separate', async (testContext) => {
    const chat = createChat(12);
    const settings = createSettings({
        reranker: false,
        semanticWorldInfo: true,
        topN: 2,
        recentMessages: 5,
    });
    const context = {
        chatId: 'ordered-chat',
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        extensionSettings: { 'st-memory-augment': settings },
        chatMetadata: {},
    };
    const originalSillyTavern = globalThis.SillyTavern;
    const originalFetch = globalThis.fetch;
    testContext.after(() => {
        globalThis.SillyTavern = originalSillyTavern;
        globalThis.fetch = originalFetch;
    });
    globalThis.SillyTavern = { getContext: () => context };
    const fixture = installNativeFetch({
        chatDocument: {
            version: 1,
            kind: 'chat',
            scope_id: 'ordered-chat',
            chunks: [{
                id: 'chat-history',
                message_id: 1,
                segment_index: 0,
                text: 'recalled chat memory',
                type: 'chat',
            }],
        },
        worldDocument: {
            version: 1,
            kind: 'worldinfo',
            scope_id: 'Book',
            chunks: [{
                id: 'world-setting',
                book_id: 'Book',
                entry_uid: '42',
                entry_key: 'Setting',
                segment_index: 0,
                text: 'recalled setting',
                type: 'worldinfo',
            }],
        },
    });
    globalThis.fetch = fixture.fetch;

    await memoryAugmentInterceptor(chat, 8192, () => undefined, 'normal');

    assert.match(chat[0].mes, /^【历史上下文参考】/);
    assert.match(chat[11].mes, /^\[设定召回-/);
    assert.deepEqual(chat.filter(message => /^message /.test(message.mes)).map(message => message.mes), createChat(12).map(message => message.mes));
});

test('history insertion falls back to the front when no story marker exists', async () => {
    const chat = createChat(1);
    const result = await retrieveAndInject(
        chat,
        createSettings({ reranker: false, topN: 1 }),
        { chatId: 'short-chat' },
        { async searchMemory() { return { results: [{ text: 'early memory' }] }; } },
    );

    assert.equal(result.insertionIndex, 0);
    assert.match(chat[0].mes, /early memory/);
    assert.equal(chat[1].mes, 'message 0');
});

test('history is inserted immediately after the Start a new Story marker', () => {
    const chat = [
        { role: 'system', content: 'character settings' },
        { role: 'system', content: '[Start a new Story]' },
        { role: 'user', content: 'first floor', is_user: true },
    ];
    assert.equal(findHistoricalInsertionIndex(chat), 2);
});

test('interceptor never mutates context.chat or shared message objects', async (testContext) => {
    const persistentChat = createChat(6);
    const generationChat = persistentChat.slice();
    const snapshot = structuredClone(persistentChat);
    const settings = createSettings({ reranker: false, recentMessages: 2 });
    settings.apis.embedding = { url: '', apiKey: '', model: '' };
    const context = {
        chatId: 'copy-safety-chat',
        chat: persistentChat,
        extensionSettings: { 'st-memory-augment': settings },
    };
    const originalSillyTavern = globalThis.SillyTavern;
    testContext.after(() => globalThis.SillyTavern = originalSillyTavern);
    globalThis.SillyTavern = { getContext: () => context };

    await memoryAugmentInterceptor(generationChat, 8192, () => undefined, 'normal');
    assert.deepEqual(persistentChat, snapshot);
    assert.deepEqual(generationChat.map(message => message.mes), persistentChat.map(message => message.mes));
    assert.notEqual(generationChat[0], persistentChat[0]);

    await memoryAugmentInterceptor(persistentChat, 8192, () => undefined, 'normal');
    assert.deepEqual(persistentChat, snapshot, 'persistent array is refused even when passed directly');
});

test('missing embedding configuration leaves the ST-provided generation chat intact', async (testContext) => {
    const chat = createChat(8);
    const settings = createSettings({ reranker: false, recentMessages: 3 });
    settings.apis.embedding = { url: '', apiKey: '', model: '' };
    const context = {
        chatId: 'no-api-chat',
        extensionSettings: { 'st-memory-augment': settings },
        chatMetadata: {},
    };
    const originalSillyTavern = globalThis.SillyTavern;
    testContext.after(() => globalThis.SillyTavern = originalSillyTavern);
    globalThis.SillyTavern = { getContext: () => context };

    await memoryAugmentInterceptor(chat, 8192, () => undefined, 'normal');
    assert.deepEqual(chat.map(message => message.mes), createChat(8).map(message => message.mes));
});
