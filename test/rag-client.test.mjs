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
import { splitMessageTextWithTimeline } from '../native-vector-store.js';

test('an explicit in-floor time jump is a mandatory vector split boundary', () => {
    const text = `现在，众人仍在王城议事。${'甲'.repeat(40)}十年后，旧王城已经荒废。${'乙'.repeat(40)}`;
    const chunks = splitMessageTextWithTimeline(text, 400, {
        sceneAnchorId: 't2-mainline',
        sceneTime: '王历110年',
        mainlineAnchorId: 't2-mainline',
        mainlineTime: '王历110年',
        precedingSceneAnchorId: 't1-mainline',
        precedingSceneTime: '王历100年',
        precedingMainlineAnchorId: 't1-mainline',
        precedingMainlineTime: '王历100年',
        segments: [{
            startQuote: '十年后，旧王城已经荒废。',
            anchorId: 't2-mainline',
            anchorLabel: '王历110年',
            mode: 'mainline',
            relation: '十年后',
        }],
    });

    assert.equal(chunks.length, 2);
    assert.match(chunks[0].text, /^现在/);
    assert.match(chunks[1].text, /^十年后/);
    assert.equal(chunks[0].timeline.time, '王历100年');
    assert.equal(chunks[1].timeline.time, '王历110年');
});

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

    const annotated = await ingestChat({
        chatId: 'chat name',
        embedding,
        targetChars: 400,
        messages: [{
            id: 10,
            role: 'user',
            text: '第十楼的原始记忆',
            timeline: {
                sceneAnchorId: 't10-mainline',
                sceneTime: '王历100年春',
                mainlineAnchorId: 't10-mainline',
                mainlineTime: '王历100年春',
            },
        }],
    });
    assert.equal(annotated.embedded, 0, 'adding an anchor must not regenerate an unchanged vector');

    const listed = await getChatMemory('chat name', { offset: 0, limit: 25, query: '第十楼' });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].id, 'msg10_seg0');
    assert.equal(listed.items[0].timeline_time, '王历100年春');

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

test('a partial 80-95 floor store is repaired with all missing historical floors without re-embedding saved floors', async (context) => {
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
    const messages = Array.from({ length: 96 }, (_, id) => ({
        id,
        role: id % 2 === 0 ? 'user' : 'assistant',
        text: `第 ${id} 楼原文`,
    }));

    const partial = await ingestChat({
        chatId: 'hundred-floor-chat',
        embedding,
        targetChars: 400,
        messages: messages.slice(80),
    });
    assert.equal(partial.embedded, 16);

    const repaired = await ingestChat({
        chatId: 'hundred-floor-chat',
        embedding,
        targetChars: 400,
        messages,
    });
    assert.equal(repaired.embedded, 80);
    assert.equal(repaired.reused, 16);

    const listed = await getChatMemory('hundred-floor-chat', { offset: 0, limit: 200 });
    assert.equal(listed.total, 96);
    assert.equal(Math.min(...listed.items.map(item => item.message_id)), 0);
    assert.equal(Math.max(...listed.items.map(item => item.message_id)), 95);
});
