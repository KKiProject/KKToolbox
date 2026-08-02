import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMemoryMessage, memoryAugmentInterceptor, retrieveAndInject } from '../context-manager.js';
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
    assert.equal(searchPayload.worldInfoTopK, 7);
    assert.equal(searchPayload.embedding.baseUrl, 'https://embedding.example');
    assert.deepEqual(searchPayload.scope, {
        chat_id: 'chat-1',
        chat_message_id_before: 4,
        book_ids: [],
    });
    assert.equal(rerankPayload.topN, 2);
    assert.equal(rerankPayload.threshold, 0.4);
    assert.equal(rerankPayload.reranker.baseUrl, 'https://reranker.example');
    assert.equal(result.usedReranker, true);
    assert.equal(result.insertionIndex, 4);
    assert.equal(chat[4].role, 'system');
    assert.equal(chat[4].extra.type, 'narrator');
    assert.match(chat[4].mes, /memory B/);
    assert.equal(chat[5].mes, 'message 4');
    assert.equal(chat[6].mes, 'message 5');
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
    assert.equal(result.insertionIndex, 2);
    assert.equal(chat[2].extra.type, 'narrator');
    assert.match(chat[2].mes, /vector first/);
    assert.doesNotMatch(chat[2].mes, /vector second/);
    assert.deepEqual(chat.slice(3).map(message => message.mes), ['message 2', 'message 3']);
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
    assert.equal(chat[6].extra.type, 'narrator');
    assert.match(chat[6].mes, /^【历史召回附录】/);
    assert.match(chat[6].mes, /remembered event from earlier turns/);
    assert.deepEqual(chat.slice(0, 6).map(message => message.mes), createChat(6).map(message => message.mes));
    assert.deepEqual(chat.slice(7).map(message => message.mes), ['message 6', 'message 7']);
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
        book_ids: ['Book'],
    });
    assert.match(chat[2].mes, /^\[设定召回-/);
    assert.equal(chat[2].extra.memory_augment_recall_type, 'worldinfo');
    assert.match(chat[3].mes, /^【历史召回附录】/);
    assert.equal(chat[3].extra.memory_augment_recall_type, 'chat');
    assert.deepEqual(chat.slice(4).map(message => message.mes), ['message 2', 'message 3']);
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
    assert.equal(result.reason, 'no-results');
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
    assert.equal(searchPayload.worldInfoTopK, 7);
    assert.equal(searchPayload.scope.chat_message_id_before, 8);
    assert.deepEqual(rerankCalls.map(call => call.topN).sort(), [2, 3]);
    assert.deepEqual(rerankCalls.map(call => call.candidates.length).sort(), [6, 7]);
    assert.equal(result.chatResultCount, 2);
    assert.equal(result.worldInfoResultCount, 3);
    assert.equal(chat[8].extra.memory_augment_recall_type, 'worldinfo');
    assert.equal(chat[9].extra.memory_augment_recall_type, 'chat');
    assert.deepEqual(chat.slice(10).map(message => message.mes), ['message 8', 'message 9']);
});

test('full interceptor keeps ST-provided messages and injects setting and memory at depth 2', async (testContext) => {
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

    assert.deepEqual(chat.slice(0, 10).map(message => message.mes), createChat(10).map(message => message.mes));
    assert.match(chat[10].mes, /^\[设定召回-/);
    assert.match(chat[11].mes, /^【历史召回附录】/);
    assert.deepEqual(chat.slice(12).map(message => message.mes), [
        'message 10',
        'message 11',
    ]);
});

test('depth 2 injection falls back to the front when fewer than two messages exist', async () => {
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
