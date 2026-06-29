'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { listModels, normalizeModels } = require('../models');

test('normalizeModels accepts OpenAI data and removes duplicate ids', () => {
    assert.deepEqual(normalizeModels({
        data: [{ id: 'text-b' }, { id: 'text-a' }, { id: 'text-b' }, {}],
    }), ['text-a', 'text-b']);
});

test('listModels requests the normalized v1/models endpoint with bearer auth', async () => {
    let captured;
    const models = await listModels({ baseUrl: 'https://api.example.com/v1/', apiKey: 'secret' }, {
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return {
                ok: true,
                json: async () => ({ data: [{ id: 'model-1' }] }),
            };
        },
    });

    assert.deepEqual(models, ['model-1']);
    assert.equal(captured.url, 'https://api.example.com/v1/models');
    assert.equal(captured.options.headers.Authorization, 'Bearer secret');
});

test('listModels exposes upstream authentication errors', async () => {
    await assert.rejects(
        () => listModels({ baseUrl: 'https://api.example.com', apiKey: 'bad' }, {
            fetchImpl: async () => ({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                json: async () => ({ error: { message: 'invalid key' } }),
            }),
        }),
        /401.*invalid key/,
    );
});
