import assert from 'node:assert/strict';
import test from 'node:test';
import {
    fetchModels,
    getChatMemory,
    ingestChat,
    searchMemory,
    searchPhoneMemory,
    searchSummaryMemory,
    getWorldInfoStatuses,
    syncWorldInfo,
    syncPhoneMemory,
    syncSummaryMemory,
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

    const ranged = await searchMemory({
        query: '记忆',
        embedding,
        chatTopK: 10,
        chatGlobalFallbackK: 0,
        scope: {
            chat_id: 'chat name',
            chat_message_id_before: 20,
            chat_message_ranges: [{ start: 10, end: 10 }],
            book_ids: [],
        },
    });
    assert.deepEqual(ranged.chatResults.map(item => item.message_id), [10]);

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

test('native world info merge updates selected entries without deleting earlier vectors', async (context) => {
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
    const bookId = 'incremental-world-info-test';

    await syncWorldInfo({
        book_id: bookId,
        sync_mode: 'replace',
        embedding,
        entries: [
            { entry_uid: '1', entry_key: 'NPC', text: '旧的 NPC 设定' },
            { entry_uid: '2', entry_key: '地图', text: '旧的地图设定' },
            { entry_uid: '3', entry_key: '王国', text: '不需要修改的王国设定' },
        ],
    });
    const update = await syncWorldInfo({
        book_id: bookId,
        sync_mode: 'merge',
        embedding,
        entries: [
            { entry_uid: '1', entry_key: 'NPC', text: '更新后的 NPC 设定' },
            { entry_uid: '2', entry_key: '地图', text: '更新后的地图设定' },
        ],
    });
    const statuses = await getWorldInfoStatuses([bookId]);

    assert.equal(update.entries, 2);
    assert.equal(update.totalChunks, 3);
    assert.equal(statuses[bookId].entryCount, 3);
});

test('detailed summaries use an independent vector scope and respect the eligible uid list', async (context) => {
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
    await syncSummaryMemory({
        chatId: 'summary-chat',
        embedding,
        entries: [
            { uid: 'old', start: 0, end: 9, text: '旧王宫发现了王冠' },
            { uid: 'recent', start: 10, end: 19, text: '最近在花园喝茶' },
        ],
    });
    const result = await searchSummaryMemory({
        chatId: 'summary-chat',
        query: '王冠',
        topK: 10,
        summaryUids: ['old'],
        embedding,
    });
    assert.deepEqual(result.results.map(item => item.summary_uid), ['old']);
    assert.equal(result.results[0].start, 0);
    assert.equal(result.results[0].end, 9);
});

test('online phone memories use a separate vector scope and return their event ids', async (context) => {
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
    await syncPhoneMemory({
        chatId: 'phone-rag-chat',
        embedding,
        entries: [
            { id: 'event-1', text: '与经纪人约定明天下午三点去公司', type: 'commitment', status: 'active', conversationId: 'direct-1' },
            { id: 'event-2', text: '超话出现了新的同人图', type: 'platform_fact', status: 'informational', conversationId: 'community' },
        ],
    });
    const result = await searchPhoneMemory({
        chatId: 'phone-rag-chat',
        query: '明天去公司',
        topK: 1,
        embedding,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].memory_event_id, 'event-1');
    assert.equal(result.results[0].type, 'phone');
});

test('one unchanged query shares its embedding across summary and chat stores without relisting either index', async (context) => {
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
        baseUrl: 'https://embedding-cache.example',
        apiKey: 'embed-key',
        model: 'embed-cache-model',
    };
    await syncSummaryMemory({
        chatId: 'shared-query-chat',
        embedding,
        entries: [{ uid: 'summary-a', start: 0, end: 9, text: '王冠藏在旧王宫' }],
    });
    await ingestChat({
        chatId: 'shared-query-chat',
        embedding,
        targetChars: 400,
        messages: [{ id: 2, role: 'assistant', text: '侍卫把王冠交给了公主' }],
    });
    fixture.requests.length = 0;

    const query = '只用于共享向量测试的王冠线索';
    await searchSummaryMemory({
        chatId: 'shared-query-chat',
        query,
        topK: 1,
        summaryUids: ['summary-a'],
        embedding,
    });
    await searchMemory({
        query,
        embedding,
        chatTopK: 1,
        scope: { chat_id: 'shared-query-chat', chat_message_id_before: 30, book_ids: [] },
    });

    const queryEmbeddings = fixture.requests.filter(request => (
        request.url === 'https://embedding-cache.example/v1/embeddings'
        && request.body.input?.[0] === query
    ));
    assert.equal(queryEmbeddings.length, 1);
    assert.equal(fixture.requests.filter(request => request.url === '/api/vector/list').length, 0);
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
