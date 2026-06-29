'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { rerankDocuments } = require('../reranker');

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

test('uses the compatible rerank request format and normalizes scores', async () => {
    let request;
    const fetchImpl = async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return response({
            payload: {
                results: [
                    { index: 1, relevance_score: 0.91 },
                    { index: 0, relevance_score: 0.42 },
                ],
            },
        });
    };

    const results = await rerankDocuments('current query', ['first', 'second'], {
        baseUrl: 'https://gateway.example/custom/v1/',
        apiKey: 'rerank-key',
        model: 'user-reranker',
    }, 2, { fetchImpl });

    assert.equal(request.url, 'https://gateway.example/custom/v1/rerank');
    assert.equal(request.options.headers.Authorization, 'Bearer rerank-key');
    assert.deepEqual(request.body, {
        model: 'user-reranker',
        query: 'current query',
        documents: ['first', 'second'],
        top_n: 2,
    });
    assert.deepEqual(results, [
        { index: 1, score: 0.91 },
        { index: 0, score: 0.42 },
    ]);
});

test('retries transient reranker failures with exponential backoff', async () => {
    const delays = [];
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        if (calls === 1) {
            return response({ status: 429 });
        }
        if (calls === 2) {
            return response({ status: 503 });
        }
        return response({ payload: { results: [{ index: 0, relevance_score: 0.8 }] } });
    };

    await rerankDocuments('query', ['document'], {
        baseUrl: 'https://gateway.example',
        apiKey: 'rerank-key',
        model: 'user-reranker',
    }, 1, {
        fetchImpl,
        retryDelayMs: 20,
        sleep: async delay => delays.push(delay),
    });

    assert.equal(calls, 3);
    assert.deepEqual(delays, [20, 40]);
});
