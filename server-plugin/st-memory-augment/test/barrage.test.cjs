'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_MAX_TOKENS, buildBarrageUserContent, generateBarrage } = require('../barrage');

function response({ status = 200, payload = {}, headers = {}, rawBody = JSON.stringify(payload) } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 429 ? 'Too Many Requests' : 'OK',
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        async text() {
            return rawBody;
        },
        async json() {
            return payload;
        },
    };
}

test('separates recap, recalled memory, and the latest AI chapter by priority', () => {
    const content = buildBarrageUserContent([
        { id: 7, name: '角色', text: '旧剧情。' },
        { id: 8, name: '用户', text: '然后呢？' },
        { id: 9, name: '角色', text: '最新回复完整原文。' },
    ], [{ text: '更早的相关记忆。' }]);

    assert.equal(content, [
        '【前情回顾】（仅供理解上下文，不要单独评论）',
        '[第 7 楼] 角色: 旧剧情。',
        '[第 8 楼] 用户: 然后呢？',
        '',
        '【相关记忆】（仅供前后呼应参考，不要单独评论）',
        '[历史片段 1] 更早的相关记忆。',
        '',
        '---',
        '',
        '【最新章节】（这是你要评论的内容）',
        '最新回复完整原文。',
    ].join('\n'));
});

test('uses standard OpenAI chat completions format with the default token limit', async () => {
    let request;
    const messages = [
        { role: 'system', content: 'audience prompt' },
        { role: 'user', content: 'story content' },
    ];
    const content = await generateBarrage(messages, {
        baseUrl: 'https://side-api.example/custom/v1/',
        apiKey: 'side-api-key',
        model: 'cheap-user-model',
    }, {
        async fetchImpl(url, options) {
            request = { url, options, body: JSON.parse(options.body) };
            return response({
                payload: { choices: [{ message: { content: '弹幕内容' } }] },
            });
        },
    });

    assert.equal(request.url, 'https://side-api.example/custom/v1/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer side-api-key');
    assert.deepEqual(request.body, {
        model: 'cheap-user-model',
        messages,
        max_tokens: DEFAULT_MAX_TOKENS,
    });
    assert.equal(DEFAULT_MAX_TOKENS, 4064);
    assert.equal(content, '弹幕内容');
});

test('uses the configured maximum output length', async () => {
    let requestBody;
    await generateBarrage([{ role: 'user', content: 'story' }], {
        baseUrl: 'https://side-api.example',
        apiKey: 'side-api-key',
        model: 'cheap-user-model',
    }, {
        maxTokens: 8192,
        async fetchImpl(_url, options) {
            requestBody = JSON.parse(options.body);
            return response({ payload: { choices: [{ message: { content: 'ok' } }] } });
        },
    });

    assert.equal(requestBody.max_tokens, 8192);
});

test('retries rate limits and transient upstream failures', async () => {
    const delays = [];
    let calls = 0;
    await generateBarrage([{ role: 'user', content: 'story' }], {
        baseUrl: 'https://side-api.example',
        apiKey: 'side-api-key',
        model: 'cheap-user-model',
    }, {
        async fetchImpl() {
            calls++;
            if (calls === 1) return response({ status: 429 });
            if (calls === 2) return response({ status: 503 });
            return response({ payload: { choices: [{ message: { content: 'ok' } }] } });
        },
        retryDelayMs: 15,
        sleep: async delay => delays.push(delay),
    });

    assert.equal(calls, 3);
    assert.deepEqual(delays, [15, 30]);
});

test('logs the request and raw upstream response before parsing', async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args);
    try {
        await generateBarrage([{ role: 'user', content: 'story' }], {
            baseUrl: 'https://side-api.example',
            apiKey: 'side-api-key',
            model: 'cheap-user-model',
        }, {
            fetchImpl: async () => response({
                payload: { choices: [{ message: { content: 'ok' } }] },
            }),
        });
    } finally {
        console.log = originalLog;
    }

    assert.equal(logs.length, 4);
    assert.equal(logs[0][0], '[Barrage] Sending request to:');
    assert.equal(logs[0][1], 'https://side-api.example/v1/chat/completions');
    assert.equal(logs[1][0], '[Barrage] Request body:');
    assert.match(logs[1][1], /"model": "cheap-user-model"/);
    assert.equal(logs[2][0], '[Barrage] Response status:');
    assert.equal(logs[2][1], 200);
    assert.equal(logs[3][0], '[Barrage] Raw response:');
    assert.match(logs[3][1], /choices/);
});

test('propagates non-200 upstream status and error.message', async () => {
    await assert.rejects(
        generateBarrage([{ role: 'user', content: 'story' }], {
            baseUrl: 'https://side-api.example',
            apiKey: 'side-api-key',
            model: 'wrong-model',
        }, {
            maxRetries: 0,
            fetchImpl: async () => response({
                status: 401,
                payload: { error: { message: 'Invalid API key or insufficient balance' } },
            }),
        }),
        error => error.statusCode === 401
            && /Invalid API key or insufficient balance/.test(error.message),
    );
});

test('extracts an error payload returned with HTTP 200 instead of reporting missing choices', async () => {
    await assert.rejects(
        generateBarrage([{ role: 'user', content: 'story' }], {
            baseUrl: 'https://side-api.example',
            apiKey: 'side-api-key',
            model: 'unavailable-model',
        }, {
            fetchImpl: async () => response({
                payload: { error: { message: 'Model does not exist' } },
            }),
        }),
        /Barrage API returned an error: Model does not exist/,
    );
});
