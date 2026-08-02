import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createEmbeddings,
    generateAtlasCompletion,
    generateBarrageCompletion,
    generateSummaryCompletion,
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
    assert.match(requestBody.messages[1].content, /【最新章节】（这是你要评论的内容）\n最新回复/);
    assert.match(requestBody.messages[1].content, /完成：观众弹幕、最新剧情状态与时间线/);
    assert.deepEqual(result, { content: '弹幕内容' });
});

test('browser summary request uses the side API with a neutral transformation prompt', async () => {
    let requestBody;
    const result = await generateSummaryCompletion({
        barrage: { baseUrl: 'https://provider.example', apiKey: 'secret', model: 'chat-model' },
        prompt: '请总结这十楼既有剧情。',
        maxTokens: 1200,
    }, {
        fetchImpl: async (_url, options) => {
            requestBody = JSON.parse(options.body);
            return response({ choices: [{ message: { content: '完整摘要。' } }] });
        },
    });

    assert.equal(requestBody.max_tokens, 1200);
    assert.match(requestBody.messages[0].content, /只负责概括用户提供的既有虚构剧情/);
    assert.match(requestBody.messages[0].content, /强制关系、近亲关系/);
    assert.match(requestBody.messages[0].content, /不得拒绝、说教/);
    assert.equal(requestBody.messages[1].content, '请总结这十楼既有剧情。');
    assert.deepEqual(result, { content: '完整摘要。' });
});

test('development output defaults to empty and gives direct player canon highest priority', async () => {
    let requestBody;
    await generateBarrageCompletion({
        barrage: { baseUrl: 'https://provider.example', apiKey: 'secret', model: 'chat-model' },
        recentMessages: [
            { id: 4, name: '玩家', text: '十年后，她变得阴郁寡言。' },
            { id: 5, name: '角色', text: '她站在旧宅门前。' },
        ],
        developmentSnapshot: { profiles: [] },
        outputOptions: { barrageEnabled: false, statusEnabled: false, developmentEnabled: true },
    }, {
        fetchImpl: async (_url, options) => {
            requestBody = JSON.parse(options.body);
            return response({ choices: [{ message: { content: '{"barrage":"","status":null,"timeline":null,"development":{"changes":[]}}' } }] });
        },
    });
    const prompt = requestBody.messages.at(-1).content;
    assert.match(prompt, /绝大多数回复都应返回空数组/);
    assert.match(prompt, /玩家明确设定拥有最高优先级/);
    assert.match(prompt, /仅写“十年后”只代表时间推进/);
    assert.match(prompt, /不能冒充玩家设定/);
});

test('browser barrage recovers a final JSON object placed in reasoning_content', async () => {
    const result = await generateBarrageCompletion({
        barrage: { baseUrl: 'https://provider.example', apiKey: 'secret', model: 'chat-model' },
        recentMessages: [{ id: 1, name: '角色', text: '最新回复' }],
    }, {
        fetchImpl: async () => response({
            choices: [{
                finish_reason: 'stop',
                message: {
                    content: '',
                    reasoning_content: `先分析。\n${JSON.stringify({ barrage: '救回来了！', status: null })}`,
                },
            }],
        }),
    });
    assert.match(result.content, /"barrage":"救回来了！"/);
});

test('an empty stop response retries with a lightweight barrage-only request', async () => {
    const requests = [];
    const result = await generateBarrageCompletion({
        barrage: { baseUrl: 'https://provider.example', apiKey: 'secret', model: 'chat-model' },
        systemPrompt: '用围观群众语气吐槽',
        recentMessages: [{ id: 1, name: '角色', text: '剧情发生了复杂的关系变化。' }],
        outputOptions: { barrageEnabled: true, statusEnabled: true },
    }, {
        fetchImpl: async (_url, options) => {
            requests.push(JSON.parse(options.body));
            if (requests.length === 1) {
                return response({ choices: [{ finish_reason: 'stop', message: { content: '' } }] });
            }
            return response({ choices: [{ finish_reason: 'stop', message: { content: '{"barrage":"这关系越来越复杂了！","status":null}' } }] });
        },
    });

    assert.equal(requests.length, 2);
    assert.match(requests[0].messages.at(-1).content, /最新剧情状态/);
    assert.match(requests[1].messages.at(-1).content, /只生成几条简短的观众弹幕/);
    assert.doesNotMatch(requests[1].messages.at(-1).content, /innerThoughts/);
    assert.match(result.content, /这关系越来越复杂了/);
});

test('empty side API responses explain whether tokens ended in reasoning', async () => {
    await assert.rejects(
        generateBarrageCompletion({
            barrage: { baseUrl: 'https://provider.example', apiKey: 'secret', model: 'chat-model' },
            recentMessages: [{ id: 1, name: '角色', text: '最新回复' }],
        }, {
            fetchImpl: async () => response({
                choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '只完成了思考' } }],
            }),
        }),
        /finish_reason=length.*仅返回了 6 字思考内容/,
    );
});

test('browser atlas request sends all supplied worldbook entries in one structured request', async () => {
    let requestBody;
    const result = await generateAtlasCompletion({
        barrage: { baseUrl: 'https://provider.example', apiKey: 'secret', model: 'chat-model' },
        books: [{
            name: '北境设定',
            entries: [
                { name: '银松城', content: '银松城通过北境大道连接霜隘。' },
                { name: '霜隘', content: '霜隘是一座山口关隘。' },
            ],
        }],
        maxTokens: 16000,
    }, {
        fetchImpl: async (_url, options) => {
            requestBody = JSON.parse(options.body);
            return response({ choices: [{ message: { content: JSON.stringify({ title: '地图', pages: [] }) } }] });
        },
    });

    assert.equal(requestBody.max_tokens, 16000);
    assert.equal(requestBody.messages.length, 2);
    assert.match(requestBody.messages[1].content, /世界书：北境设定/);
    assert.match(requestBody.messages[1].content, /银松城通过北境大道连接霜隘/);
    assert.match(requestBody.messages[1].content, /不得编造地点/);
    assert.match(result.content, /"title":"地图"/);
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
