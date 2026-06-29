'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createEmbeddings, MAX_BATCH_SIZE } = require('../embedding');

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

test('uses the OpenAI-compatible embeddings request format and batches at 64', async () => {
    const calls = [];
    const input = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, index) => `text-${index}`);
    const fetchImpl = async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url, options, body });
        return response({
            payload: {
                data: body.input.map((text, index) => ({ index, embedding: [text.length, 1] })),
            },
        });
    };

    const vectors = await createEmbeddings(input, {
        baseUrl: 'https://gateway.example/custom/v1/',
        apiKey: 'secret-key',
        model: 'user-selected-model',
    }, { fetchImpl });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://gateway.example/custom/v1/embeddings');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-key');
    assert.deepEqual(Object.keys(calls[0].body), ['model', 'input', 'encoding_format']);
    assert.equal(calls[0].body.model, 'user-selected-model');
    assert.equal(calls[0].body.encoding_format, 'float');
    assert.equal(calls[0].body.input.length, MAX_BATCH_SIZE);
    assert.equal(calls[1].body.input.length, 1);
    assert.equal(vectors.length, input.length);
});

test('retries 429 responses with exponential backoff', async () => {
    const delays = [];
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        if (calls < 3) {
            return response({ status: 429, payload: { error: { message: 'rate limited' } } });
        }
        return response({ payload: { data: [{ index: 0, embedding: [1, 0] }] } });
    };

    const vectors = await createEmbeddings(['query'], {
        baseUrl: 'https://gateway.example',
        apiKey: 'secret-key',
        model: 'user-selected-model',
    }, {
        fetchImpl,
        retryDelayMs: 25,
        sleep: async delay => delays.push(delay),
    });

    assert.equal(calls, 3);
    assert.deepEqual(delays, [25, 50]);
    assert.deepEqual(vectors, [[1, 0]]);
});
