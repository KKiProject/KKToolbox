import assert from 'node:assert/strict';
import test from 'node:test';
import { BARRAGE_METADATA_KEY, collectRecentMessages, handleCharacterMessageRendered } from '../barrage-ui.js';

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
            includeRag,
            systemPrompt: 'audience system prompt',
        },
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

test('recent floor setting selects only messages ending at the rendered AI response', () => {
    const context = createContext();
    assert.deepEqual(
        collectRecentMessages(context.chat, 5, 3).map(message => message.id),
        [3, 4, 5],
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
            return { content: '观众弹幕结果' };
        },
    });

    assert.equal(result.generated, true);
    assert.deepEqual(context.chat, originalChat);
    assert.deepEqual(requestBody.recentMessages.map(message => message.id), [3, 4, 5]);
    assert.deepEqual(requestBody.ragFragments, []);
    assert.equal(requestBody.barrage.baseUrl, 'https://barrage.example');
    assert.equal(requestBody.systemPrompt, 'audience system prompt');
    assert.equal(renders.at(-1)[1], '观众弹幕结果');
    assert.equal(renders.at(-1)[2], 'ready');
    assert.equal(context.chatMetadata[BARRAGE_METADATA_KEY]['5'].content, '观众弹幕结果');
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
    assert.equal(searchPayload.topK, 9);
    assert.equal(searchPayload.embedding.baseUrl, 'https://embedding.example');
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
