import assert from 'node:assert/strict';
import test from 'node:test';
import {
    fetchModels,
    getChatMemory,
    ingestChat,
    searchMemory,
    updateChatMemory,
} from '../rag-client.js';
import { installNativeFetch } from './native-fetch-fixture.mjs';

test('fetchModels calls the configured provider directly from the browser', async (context) => {
    const originalSillyTavern = globalThis.SillyTavern;
    const originalFetch = globalThis.fetch;
    context.after(() => {
        globalThis.SillyTavern = originalSillyTavern;
        globalThis.fetch = originalFetch;
    });

    globalThis.SillyTavern = {
        getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }),
    };
    const fixture = installNativeFetch();
    globalThis.fetch = fixture.fetch;

    const result = await fetchModels({ baseUrl: 'https://provider.example', apiKey: 'secret' });
    assert.deepEqual(result.models, ['model-a']);
    const request = fixture.requests.find(item => item.url === 'https://provider.example/v1/models');
    assert.ok(request);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.Authorization, 'Bearer secret');
});

test('native chat memory writes, searches, edits, and disables fragments without a server plugin', async (context) => {
    const originalSillyTavern = globalThis.SillyTavern;
    const originalFetch = globalThis.fetch;
    context.after(() => {
        globalThis.SillyTavern = originalSillyTavern;
        globalThis.fetch = originalFetch;
    });

    globalThis.SillyTavern = {
        getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }),
    };
    const fixture = installNativeFetch();
    globalThis.fetch = fixture.fetch;
    const embedding = {
        baseUrl: 'https://embedding.example',
        apiKey: 'embed-key',
        model: 'embed-model',
    };

    const ingested = await ingestChat({
        chatId: 'chat name',
        embedding,
        targetChars: 400,
        messages: [
            { id: 10, role: 'user', text: '第十楼的原始记忆' },
            { id: 11, role: 'assistant', text: '第十一楼的另一段记忆' },
        ],
    });
    assert.equal(ingested.chunks, 2);

    const listed = await getChatMemory('chat name', { offset: 0, limit: 25, query: '第十楼' });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].id, 'msg10_seg0');

    const updated = await updateChatMemory({
        chatId: 'chat name',
        chunkId: 'msg10_seg0',
        text: '人工修订后的记忆',
        embedding,
    });
    assert.equal(updated.item.manual_override, true);
    assert.equal(updated.item.text, '人工修订后的记忆');

    const recalled = await searchMemory({
        query: '人工修订',
        embedding,
        chatTopK: 10,
        scope: { chat_id: 'chat name', chat_message_id_before: 20, book_ids: [] },
    });
    assert.deepEqual(recalled.chatResults.map(item => item.text).sort(), [
        '人工修订后的记忆',
        '第十一楼的另一段记忆',
    ].sort());

    await updateChatMemory({
        chatId: 'chat name',
        chunkId: 'msg10_seg0',
        disabled: true,
        embedding,
    });
    const disabled = await getChatMemory('chat name', { offset: 0, limit: 25, query: '人工修订' });
    assert.equal(disabled.items[0].disabled, true);
    const vectorRequests = fixture.requests.filter(item => item.url.startsWith('/api/vector/'));
    assert.ok(vectorRequests.some(item => item.url === '/api/vector/insert'));
    assert.ok(vectorRequests.some(item => item.url === '/api/vector/delete'));
});
