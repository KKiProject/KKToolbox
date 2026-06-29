'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const plugin = require('../index');

function openAiResponse(body) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        async json() {
            return {
                data: body.input.map((text, index) => ({
                    index,
                    embedding: (() => {
                        const value = String(text).toLowerCase();
                        if (value.includes('phoenix') || value.includes('reborn fire bird')) return [0.7, 0.7];
                        return value.includes('apple') ? [1, 0] : [0, 1];
                    })(),
                })),
            };
        },
    };
}

test('ingest persists vectors, reuses unchanged chunks, and search recalls relevant text', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-augment-api-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const originalFetch = global.fetch;
    context.after(() => global.fetch = originalFetch);
    const embeddingCalls = [];
    let modelRequest;
    global.fetch = async (url, options) => {
        if (String(url).endsWith('/v1/models')) {
            modelRequest = { url, options };
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                async json() {
                    return { data: [{ id: 'model-b' }, { id: 'model-a' }] };
                },
            };
        }
        const body = JSON.parse(options.body);
        embeddingCalls.push({ url, body });
        if (String(url).endsWith('/v1/chat/completions')) {
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => null },
                async json() {
                    return { choices: [{ message: { content: '观众：这段剧情太离谱了！' } }] };
                },
            };
        }
        if (String(url).endsWith('/v1/rerank')) {
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => null },
                async json() {
                    return {
                        results: [
                            { index: 1, relevance_score: 0.85 },
                            { index: 0, relevance_score: 0.2 },
                        ],
                    };
                },
            };
        }
        return openAiResponse(body);
    };

    const routes = new Map();
    const router = {
        get(route, handler) {
            routes.set(`GET ${route}`, handler);
        },
        post(route, handler) {
            routes.set(`POST ${route}`, handler);
        },
    };
    await plugin.init(router);

    async function invoke(route, body = {}, query = {}) {
        let payload;
        let statusCode = 200;
        const response = {
            status(value) {
                statusCode = value;
                return this;
            },
            json(value) {
                payload = value;
                return this;
            },
        };
        await routes.get(route)({
            body,
            query,
            user: { directories: { vectors: root } },
        }, response);
        return { payload, statusCode };
    }

    const embedding = {
        baseUrl: 'https://provider.example',
        apiKey: 'user-key',
        model: 'user-model',
    };

    const models = await invoke('POST /models', {
        base_url: 'https://provider.example/v1/',
        api_key: 'user-key',
    });
    assert.equal(models.statusCode, 200);
    assert.deepEqual(models.payload.models, ['model-a', 'model-b']);
    assert.equal(modelRequest.url, 'https://provider.example/v1/models');
    assert.equal(modelRequest.options.headers.Authorization, 'Bearer user-key');

    const ingestBody = {
        chatId: 'chat-1',
        chunkSize: 1,
        embedding,
        messages: [
            { id: 0, name: 'A', text: 'An apple appeared.', timestamp: 100 },
            { id: 1, name: 'B', text: 'A banana appeared.', timestamp: 101 },
        ],
    };

    const firstIngest = await invoke('POST /ingest', ingestBody);
    assert.equal(firstIngest.statusCode, 200);
    assert.equal(firstIngest.payload.chunks, 2);
    assert.equal(firstIngest.payload.embedded, 2);
    assert.equal(embeddingCalls.length, 1);

    const secondIngest = await invoke('POST /ingest', ingestBody);
    assert.equal(secondIngest.payload.embedded, 0);
    assert.equal(secondIngest.payload.reused, 2);
    assert.equal(embeddingCalls.length, 1, 'unchanged chunks must not be embedded again');

    const search = await invoke('POST /search', {
        chatId: 'chat-1',
        query: 'apple',
        topK: 1,
        embedding,
    });
    assert.equal(search.statusCode, 200);
    assert.equal(search.payload.results.length, 1);
    assert.match(search.payload.results[0].text, /apple/i);
    assert.equal(embeddingCalls.length, 2);
    assert.equal(embeddingCalls[1].url, 'https://provider.example/v1/embeddings');

    const rerank = await invoke('POST /rerank', {
        query: 'apple',
        candidates: [
            { id: 'low', text: 'low score' },
            { id: 'high', text: 'high score' },
        ],
        topN: 2,
        threshold: 0.3,
        reranker: {
            baseUrl: 'https://reranker.example',
            apiKey: 'reranker-key',
            model: 'reranker-model',
        },
    });
    assert.equal(rerank.statusCode, 200);
    assert.equal(rerank.payload.results.length, 1);
    assert.equal(rerank.payload.results[0].id, 'high');
    assert.equal(rerank.payload.results[0].score, 0.85);
    assert.equal(embeddingCalls.at(-1).url, 'https://reranker.example/v1/rerank');
    assert.deepEqual(embeddingCalls.at(-1).body, {
        model: 'reranker-model',
        query: 'apple',
        documents: ['low score', 'high score'],
        top_n: 2,
    });

    const barrage = await invoke('POST /barrage', {
        barrage: {
            baseUrl: 'https://barrage.example',
            apiKey: 'barrage-key',
            model: 'barrage-model',
        },
        systemPrompt: 'custom audience prompt',
        recentMessages: [
            { id: 8, name: 'User', text: 'What happened?' },
            { id: 9, name: 'Character', text: 'A door opened.' },
        ],
        ragFragments: [{ text: 'The same door appeared earlier.' }],
    });
    assert.equal(barrage.statusCode, 200);
    assert.equal(barrage.payload.content, '观众：这段剧情太离谱了！');
    assert.equal(embeddingCalls.at(-1).url, 'https://barrage.example/v1/chat/completions');
    assert.deepEqual(Object.keys(embeddingCalls.at(-1).body), ['model', 'messages', 'max_tokens']);
    assert.equal(embeddingCalls.at(-1).body.max_tokens, 500);
    assert.equal(embeddingCalls.at(-1).body.messages[0].content, 'custom audience prompt');
    assert.match(embeddingCalls.at(-1).body.messages[1].content, /A door opened/);
    assert.match(embeddingCalls.at(-1).body.messages[1].content, /same door appeared earlier/);

    const worldInfoEmbed = await invoke('POST /embed', {
        chatId: 'chat-1',
        embedding,
        input: ['The crimson phoenix returns from ash once every century.'],
        worldInfoEntries: [{
            id: '42',
            name: 'Ash Bird Cycle',
            world: 'My Lorebook',
            text: 'The crimson phoenix returns from ash once every century.',
        }],
    });
    assert.equal(worldInfoEmbed.statusCode, 200);
    assert.equal(worldInfoEmbed.payload.stored, 1);

    const semanticSearch = await invoke('POST /search', {
        chatId: 'chat-1',
        query: 'A reborn fire bird appeared in the sky.',
        topK: 1,
        types: ['chat', 'worldinfo'],
        worldInfoKeys: ['My Lorebook::42'],
        embedding,
    });
    assert.equal(semanticSearch.statusCode, 200);
    assert.equal(semanticSearch.payload.results[0].type, 'worldinfo');
    assert.equal(semanticSearch.payload.results[0].world_info_id, '42');
    assert.equal(semanticSearch.payload.results[0].world_info_name, 'Ash Bird Cycle');
    assert.doesNotMatch('A reborn fire bird appeared in the sky.', /phoenix/i);

    const uncheckedWorldInfoSearch = await invoke('POST /search', {
        chatId: 'chat-1',
        query: 'A reborn fire bird appeared in the sky.',
        topK: 5,
        types: ['worldinfo'],
        worldInfoKeys: [],
        embedding,
    });
    assert.deepEqual(uncheckedWorldInfoSearch.payload.results, []);

    const chatOnlySearch = await invoke('POST /search', {
        chatId: 'chat-1',
        query: 'A reborn fire bird appeared in the sky.',
        topK: 5,
        types: ['chat'],
        embedding,
    });
    assert.ok(chatOnlySearch.payload.results.every(result => result.type === 'chat'));

    const status = await invoke('GET /status', {}, { chatId: 'chat-1' });
    assert.equal(status.payload.chunkCount, 3);
    assert.equal(status.payload.phase, 6);
    assert.ok(status.payload.totalSizeBytes > 0);

    global.fetch = async () => {
        throw new Error('connection refused');
    };
    const unreachable = await invoke('POST /ingest', {
        ...ingestBody,
        force: true,
    });
    assert.equal(unreachable.statusCode, 502);
    assert.match(unreachable.payload.error, /connection refused/);

    await plugin.exit();
});
