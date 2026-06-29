import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchModels } from '../rag-client.js';

test('fetchModels uses the mounted plugin route and snake_case payload', async (context) => {
    const originalSillyTavern = globalThis.SillyTavern;
    const originalFetch = globalThis.fetch;
    context.after(() => {
        globalThis.SillyTavern = originalSillyTavern;
        globalThis.fetch = originalFetch;
    });

    globalThis.SillyTavern = {
        getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }),
    };
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return {
            ok: true,
            async json() {
                return { ok: true, models: ['model-a'] };
            },
        };
    };

    const result = await fetchModels({ baseUrl: 'https://provider.example', apiKey: 'secret' });
    assert.deepEqual(result.models, ['model-a']);
    assert.equal(request.url, '/api/plugins/st-memory-augment/models');
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(JSON.parse(request.options.body), {
        base_url: 'https://provider.example',
        api_key: 'secret',
    });
});
