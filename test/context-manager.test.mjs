import assert from 'node:assert/strict';
import test from 'node:test';
import { compressGenerationChat, memoryAugmentInterceptor, retrieveAndInject } from '../context-manager.js';

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
    assert.equal(searchPayload.topK, 12);
    assert.equal(searchPayload.embedding.baseUrl, 'https://embedding.example');
    assert.deepEqual(searchPayload.types, ['chat']);
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
    assert.equal(chat[3].extra.type, 'narrator');
    assert.match(chat[3].mes, /vector first/);
    assert.doesNotMatch(chat[3].mes, /vector second/);
    assert.equal(chat[4].mes, 'message 3');
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
                    'st-memory-augment': createSettings({ topK: 20, topN: 1, recentMessages: 3 }),
                },
            };
        },
    };
    globalThis.fetch = async (url) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
            if (String(url).endsWith('/search')) {
                return { results: [{ id: 'history', text: 'remembered event from earlier turns' }] };
            }
            if (String(url).endsWith('/rerank')) {
                return { results: [{ id: 'history', text: 'remembered event from earlier turns', score: 0.95 }] };
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
    });

    await memoryAugmentInterceptor(chat, 8192, () => undefined, 'normal');

    assert.equal(chat.length, 4);
    assert.equal(chat[0].extra.type, 'narrator');
    assert.match(chat[0].mes, /\[记忆召回\]/);
    assert.match(chat[0].mes, /remembered event from earlier turns/);
    assert.equal(chat[1].mes, 'message 5');
    assert.equal(chat[3].mes, 'message 7');
});

test('10+ message compression keeps RAG and recent originals; summaries come from Lorebook', () => {
    const chat = createChat(12);
    chat.splice(7, 0, {
        mes: '[记忆召回] recalled history',
        is_user: false,
        extra: { type: 'narrator', memory_augment_rag: true },
    });
    const result = compressGenerationChat(chat, 5);

    assert.equal(result.removed, 7);
    assert.equal(result.retained, 5);
    assert.equal(chat.length, 6);
    assert.equal(chat[0].extra.memory_augment_rag, true);
    assert.equal(chat[1].mes, 'message 7');
    assert.equal(chat[5].mes, 'message 11');
});

test('old originals without summaries are removed from generation only', () => {
    const chat = createChat(10);
    const result = compressGenerationChat(chat, 3);

    assert.equal(result.removed, 7);
    assert.deepEqual(chat.map(message => message.mes), ['message 7', 'message 8', 'message 9']);
});

test('semantic world info is jointly retrieved but injected before chat memories', async () => {
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

    assert.deepEqual(searchPayload.types, ['chat', 'worldinfo']);
    assert.deepEqual(searchPayload.worldInfoKeys, ['Book::42']);
    assert.match(chat[3].mes, /^\[设定召回\]/);
    assert.equal(chat[3].extra.memory_augment_recall_type, 'worldinfo');
    assert.match(chat[4].mes, /^\[记忆召回\]/);
    assert.equal(chat[4].extra.memory_augment_recall_type, 'chat');
    assert.equal(chat[5].mes, 'message 3');
});

test('full interceptor order is setting, memory, then recent originals', async (testContext) => {
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
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
            return {
                results: [
                    { type: 'chat', text: 'recalled chat memory' },
                    { type: 'worldinfo', text: 'recalled setting' },
                ],
            };
        },
    });

    await memoryAugmentInterceptor(chat, 8192, () => undefined, 'normal');

    assert.match(chat[0].mes, /^\[设定召回\]/);
    assert.match(chat[1].mes, /^\[记忆召回\]/);
    assert.deepEqual(chat.slice(2).map(message => message.mes), [
        'message 7',
        'message 8',
        'message 9',
        'message 10',
        'message 11',
    ]);
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
    assert.deepEqual(generationChat.map(message => message.mes), ['message 4', 'message 5']);
    assert.notEqual(generationChat[0], persistentChat[4]);

    await memoryAugmentInterceptor(persistentChat, 8192, () => undefined, 'normal');
    assert.deepEqual(persistentChat, snapshot, 'persistent array is refused even when passed directly');
});

test('missing embedding configuration skips RAG but still compresses safely', async (testContext) => {
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
    assert.deepEqual(chat.map(message => message.mes), ['message 5', 'message 6', 'message 7']);
});
