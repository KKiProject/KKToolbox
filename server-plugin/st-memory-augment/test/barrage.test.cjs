'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { generateBarrage, MAX_TOKENS } = require('../barrage');

function response({ status = 200, payload = {}, headers = {} } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 429 ? 'Too Many Requests' : 'OK',
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        async json() {
            return payload;
        },
    };
}

test('uses standard OpenAI chat completions format with a 500 token limit', async () => {
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
        max_tokens: MAX_TOKENS,
    });
    assert.equal(MAX_TOKENS, 500);
    assert.equal(content, '弹幕内容');
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
