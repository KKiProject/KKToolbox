import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createEmbeddings,
    generateBarrageCompletion,
    rerankCandidates,
} from '../browser-api-client.js';

function response(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 401 ? 'Unauthorized' : 'OK',
        headers: { get: () => null },
        async text() {
            return JSON.stringify(payload);
        },
    };
}

test('browser embeddings use OpenAI-compatible requests and batches at 64', async () => {
    const requests = [];
    const texts = Array.from({ length: 65 }, (_, index) => `text ${index}`);
    const vectors = await createEmbeddings(texts, {
        baseUrl: 'https://provider.example/v1/',
        apiKey: 'secret',
        model: 'embedding-model',
    }, {
        fetchImpl: async (url, options) => {
            const body = JSON.parse(options.body);
            requests.push({ url, options, body });
            return response({
                data: body.input.map((_, index) => ({ index, embedding: [index, 1, 2] })),
            });
        },
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://provider.example/v1/embeddings');
    assert.equal(requests[0].body.input.length, 64);
    assert.equal(requests[1].body.input.length, 1);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer secret');
    assert.equal(vectors.length, 65);
});

test('browser reranker maps provider indexes back to original candidate records', async () => {
    const candidates = [
        { id: 'a', text: 'first' },
        { id: 'b', text: 'second' },
        { id: 'c', text: 'third' },
    ];
    let requestBody;
    const result = await rerankCandidates({
        query: 'question',
        candidates,
        topN: 2,
        threshold: 0.5,
        reranker: {
            baseUrl: 'https://provider.example',
            apiKey: 'secret',
            model: 'rerank-model',
        },
    }, {
        fetchImpl: async (_url, options) => {
            requestBody = JSON.parse(options.body);
            return response({
                results: [
                    { index: 2, relevance_score: 0.9 },
                    { index: 0, relevance_score: 0.4 },
                    { index: 1, relevance_score: 0.8 },
                ],
            });
        },
    });

    assert.deepEqual(requestBody.documents, ['first', 'second', 'third']);
    assert.equal(requestBody.top_n, 2);
    assert.deepEqual(result.results.map(item => item.id), ['c', 'b']);
});

test('browser barrage request separates recap, memory, and latest chapter', async () => {
    let requestBody;
    const result = await generateBarrageCompletion({
        barrage: {
            baseUrl: 'https://provider.example',
            apiKey: 'secret',
            model: 'chat-model',
        },
        systemPrompt: '观众提示',
        recentMessages: [
            { id: 8, name: '玩家', text: '前面的剧情' },
            { id: 9, name: '角色', text: '最新回复' },
        ],
        ragFragments: [{ text: '更早的记忆' }],
        maxTokens: 1234,
    }, {
        fetchImpl: async (_url, options) => {
            requestBody = JSON.parse(options.body);
            return response({ choices: [{ message: { content: '弹幕内容' } }] });
        },
    });

    assert.equal(requestBody.max_tokens, 1234);
    assert.equal(requestBody.messages[0].content, '观众提示');
    assert.match(requestBody.messages[1].content, /【前情回顾】/);
    assert.match(requestBody.messages[1].content, /更早的记忆/);
    assert.match(requestBody.messages[1].content, /【最新章节】（这是你要评论的内容）\n最新回复$/);
    assert.deepEqual(result, { content: '弹幕内容' });
});

test('browser API errors expose the provider message without leaking the key', async () => {
    await assert.rejects(
        createEmbeddings(['text'], {
            baseUrl: 'https://provider.example',
            apiKey: 'do-not-leak-this-key',
            model: 'embedding-model',
        }, {
            maxRetries: 0,
            fetchImpl: async () => response({ error: { message: 'insufficient balance' } }, 401),
        }),
        error => {
            assert.match(error.message, /401/);
            assert.match(error.message, /insufficient balance/);
            assert.doesNotMatch(error.message, /do-not-leak-this-key/);
            return true;
        },
    );
});
