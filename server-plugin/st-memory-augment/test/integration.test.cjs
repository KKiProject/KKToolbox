'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const plugin = require('../index');
const vectorStore = require('../vector-store');

function openAiResponse(body) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        async json() {
            return {
                data: body.input.map((text, index) => ({
                    index,
                    embedding: (() => {
                        const value = String(text).toLowerCase();
                        if (value.includes('phoenix') || value.includes('reborn fire bird')) return [0.7, 0.7];
                        return value.includes('apple') ? [1, 0] : [0, 1];
                    })(),
                })),
            };
        },
    };
}

test('ingest persists vectors, reuses unchanged chunks, and search recalls relevant text', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-augment-api-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const originalFetch = global.fetch;
    context.after(() => global.fetch = originalFetch);
    const embeddingCalls = [];
    let modelRequest;
    global.fetch = async (url, options) => {
        if (String(url).endsWith('/v1/models')) {
            modelRequest = { url, options };
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                async json() {
                    return { data: [{ id: 'model-b' }, { id: 'model-a' }] };
                },
            };
        }
        const body = JSON.parse(options.body);
        embeddingCalls.push({ url, body });
        if (String(url).endsWith('/v1/chat/completions')) {
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => null },
                async json() {
                    return { choices: [{ message: { content: '观众：这段剧情太离谱了！' } }] };
                },
            };
        }
        if (String(url).endsWith('/v1/rerank')) {
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => null },
                async json() {
                    return {
                        results: [
                            { index: 1, relevance_score: 0.85 },
                            { index: 0, relevance_score: 0.2 },
                        ],
                    };
                },
            };
        }
        return openAiResponse(body);
    };

    const routes = new Map();
    const router = {
        get(route, handler) {
            routes.set(`GET ${route}`, handler);
        },
        post(route, handler) {
            routes.set(`POST ${route}`, handler);
        },
    };
    await plugin.init(router);

    async function invoke(route, body = {}, query = {}) {
        let payload;
        let statusCode = 200;
        const response = {
            status(value) {
                statusCode = value;
                return this;
            },
            json(value) {
                payload = value;
                return this;
            },
        };
        await routes.get(route)({
            body,
            query,
            user: { directories: { vectors: root } },
        }, response);
        return { payload, statusCode };
    }

    const embedding = {
        baseUrl: 'https://provider.example',
        apiKey: 'user-key',
        model: 'user-model',
    };

    const models = await invoke('POST /models', {
        base_url: 'https://provider.example/v1/',
        api_key: 'user-key',
    });
    assert.equal(models.statusCode, 200);
    assert.deepEqual(models.payload.models, ['model-a', 'model-b']);
    assert.equal(modelRequest.url, 'https://provider.example/v1/models');
    assert.equal(modelRequest.options.headers.Authorization, 'Bearer user-key');

    const ingestBody = {
        type: 'chat',
        chatId: 'chat-1',
        targetChars: 400,
        embedding,
        message: { id: 0, role: 'user', text: 'An apple appeared.', timestamp: 100 },
    };

    const firstIngest = await invoke('POST /ingest', ingestBody);
    assert.equal(firstIngest.statusCode, 200);
    assert.equal(firstIngest.payload.chunks, 1);
    assert.equal(firstIngest.payload.embedded, 1);
    assert.equal(embeddingCalls.length, 1);

    const secondIngest = await invoke('POST /ingest', ingestBody);
    assert.equal(secondIngest.payload.embedded, 0);
    assert.equal(secondIngest.payload.reused, 1);
    assert.equal(embeddingCalls.length, 1, 'unchanged chunks must not be embedded again');

    const assistantIngest = await invoke('POST /ingest', {
        ...ingestBody,
        message: { id: 1, role: 'assistant', text: 'A banana appeared.', timestamp: 101 },
    });
    assert.equal(assistantIngest.payload.chunks, 1);
    assert.equal(assistantIngest.payload.embedded, 1);
    assert.equal(embeddingCalls.length, 2);

    const search = await invoke('POST /search', {
        chatId: 'chat-1',
        query: 'apple',
        topK: 1,
        embedding,
    });
    assert.equal(search.statusCode, 200);
    assert.equal(search.payload.results.length, 1);
    assert.match(search.payload.results[0].text, /apple/i);
    assert.equal(search.payload.results[0].id, 'msg0_seg0');
    assert.equal(search.payload.results[0].message_id, 0);
    assert.equal(search.payload.results[0].segment_index, 0);
    assert.equal(search.payload.results[0].role, 'user');
    assert.equal(search.payload.results[0].char_count, 'An apple appeared.'.length);
    assert.equal(embeddingCalls.length, 3);
    assert.equal(embeddingCalls[2].url, 'https://provider.example/v1/embeddings');

    await invoke('POST /ingest', {
        ...ingestBody,
        targetChars: 100,
        message: { id: 1, role: 'assistant', text: 'x'.repeat(750), timestamp: 102 },
    });
    assert.equal(
        (await vectorStore.readChunks(root, 'chat-1')).filter(chunk => chunk.message_id === 1).length,
        2,
    );

    await invoke('POST /ingest', {
        ...ingestBody,
        targetChars: 100,
        message: { id: 1, role: 'assistant', text: 'the selected swipe', timestamp: 103 },
    });
    const selectedSwipeChunks = (await vectorStore.readChunks(root, 'chat-1'))
        .filter(chunk => chunk.message_id === 1);
    assert.deepEqual(selectedSwipeChunks.map(chunk => chunk.id), ['msg1_seg0']);
    assert.equal(selectedSwipeChunks[0].text, 'the selected swipe');

    await invoke('POST /ingest', {
        ...ingestBody,
        message: { id: 99, role: 'assistant', text: 'orphaned floor', timestamp: 104 },
    });
    const reconciliation = await invoke('POST /reconcile-chat', {
        chatId: 'chat-1',
        messageIds: [0, 1],
    });
    assert.equal(reconciliation.statusCode, 200);
    assert.deepEqual(reconciliation.payload.orphanMessageIds, ['99']);
    assert.equal(reconciliation.payload.removedChunks, 1);
    assert.deepEqual(
        (await vectorStore.readChunks(root, 'chat-1')).map(chunk => chunk.message_id).sort((a, b) => a - b),
        [0, 1],
    );
    assert.equal(
        (await vectorStore.readChunks(root, 'chat-1')).find(chunk => chunk.message_id === 1).text,
        'the selected swipe',
    );

    const rerank = await invoke('POST /rerank', {
        query: 'apple',
        candidates: [
            { id: 'low', text: 'low score' },
            { id: 'high', text: 'high score' },
        ],
        topN: 2,
        threshold: 0.3,
        reranker: {
            baseUrl: 'https://reranker.example',
            apiKey: 'reranker-key',
            model: 'reranker-model',
        },
    });
    assert.equal(rerank.statusCode, 200);
    assert.equal(rerank.payload.results.length, 1);
    assert.equal(rerank.payload.results[0].id, 'high');
    assert.equal(rerank.payload.results[0].score, 0.85);
    assert.equal(embeddingCalls.at(-1).url, 'https://reranker.example/v1/rerank');
    assert.deepEqual(embeddingCalls.at(-1).body, {
        model: 'reranker-model',
        query: 'apple',
        documents: ['low score', 'high score'],
        top_n: 2,
    });

    const barrage = await invoke('POST /barrage', {
        barrage: {
            baseUrl: 'https://barrage.example',
            apiKey: 'barrage-key',
            model: 'barrage-model',
        },
        systemPrompt: 'custom audience prompt',
        maxTokens: 8192,
        recentMessages: [
            { id: 8, name: 'User', text: 'What happened?' },
            { id: 9, name: 'Character', text: 'A door opened.' },
        ],
        ragFragments: [{ text: 'The same door appeared earlier.' }],
    });
    assert.equal(barrage.statusCode, 200);
    assert.equal(barrage.payload.content, '观众：这段剧情太离谱了！');
    assert.equal(embeddingCalls.at(-1).url, 'https://barrage.example/v1/chat/completions');
    assert.deepEqual(Object.keys(embeddingCalls.at(-1).body), ['model', 'messages', 'max_tokens']);
    assert.equal(embeddingCalls.at(-1).body.max_tokens, 8192);
    assert.equal(embeddingCalls.at(-1).body.messages[0].content, 'custom audience prompt');
    assert.equal(embeddingCalls.at(-1).body.messages[1].content, [
        '【前情回顾】（仅供理解上下文，不要单独评论）',
        '[第 8 楼] User: What happened?',
        '',
        '【相关记忆】（仅供前后呼应参考，不要单独评论）',
        '[历史片段 1] The same door appeared earlier.',
        '',
        '---',
        '',
        '【最新章节】（这是你要评论的内容）',
        'A door opened.',
    ].join('\n'));

    const worldInfoEmbed = await invoke('POST /embed', {
        chatId: 'chat-1',
        embedding,
        input: ['The crimson phoenix returns from ash once every century.'],
        worldInfoEntries: [{
            id: '42',
            name: 'Ash Bird Cycle',
            world: 'My Lorebook',
            text: 'The crimson phoenix returns from ash once every century.',
        }],
    });
    assert.equal(worldInfoEmbed.statusCode, 200);
    assert.equal(worldInfoEmbed.payload.stored, 1);

    const syncCallsBefore = embeddingCalls.length;
    const firstSync = await invoke('POST /sync-worldinfo', {
        book_id: 'Sync Book',
        targetChars: 400,
        embedding,
        entries: [
            { entry_uid: 1, entry_key: 'Apple lore', text: 'An apple is sacred.', content_hash: 'hash-a' },
            { entry_uid: 2, entry_key: 'Banana lore', text: 'A banana is forbidden.', content_hash: 'hash-b' },
        ],
    });
    assert.equal(firstSync.payload.embedded, 2);
    assert.deepEqual(firstSync.payload.updatedEntryUids, ['1', '2']);
    assert.equal(embeddingCalls.length, syncCallsBefore + 1, 'world info entries use one embedding batch');
    const unchangedSync = await invoke('POST /sync-worldinfo', {
        book_id: 'Sync Book', targetChars: 400, embedding,
        entries: [
            { entry_uid: 1, entry_key: 'Apple lore', text: 'An apple is sacred.', content_hash: 'hash-a' },
            { entry_uid: 2, entry_key: 'Banana lore', text: 'A banana is forbidden.', content_hash: 'hash-b' },
        ],
    });
    assert.equal(unchangedSync.payload.reused, 2);
    assert.deepEqual(unchangedSync.payload.unchangedEntryUids, ['1', '2']);
    assert.equal(embeddingCalls.length, syncCallsBefore + 1);
    const mergedSync = await invoke('POST /sync-worldinfo', {
        book_id: 'Sync Book', sync_mode: 'merge', targetChars: 400, embedding,
        entries: [
            { entry_uid: 1, entry_key: 'Apple lore', text: 'An apple is now blessed.', content_hash: 'hash-a1' },
        ],
    });
    assert.equal(mergedSync.payload.embedded, 1);
    assert.equal(mergedSync.payload.totalChunks, 2);
    const mergedStatus = await invoke('POST /worldinfo-status', { book_ids: ['Sync Book'] });
    assert.equal(mergedStatus.payload.statuses['Sync Book'].entryCount, 2, 'merge preserves unselected entries');
    const changedSync = await invoke('POST /sync-worldinfo', {
        book_id: 'Sync Book', targetChars: 400, embedding,
        entries: [
            { entry_uid: 1, entry_key: 'Apple lore', text: 'An apple is now forbidden.', content_hash: 'hash-a2' },
        ],
    });
    assert.equal(changedSync.payload.embedded, 1);
    assert.equal(changedSync.payload.removed, 1, 'deleted entries are removed during synchronization');
    assert.deepEqual(changedSync.payload.updatedEntryUids, ['1']);
    assert.deepEqual(changedSync.payload.removedEntryUids, ['2']);

    const worldStatus = await invoke('POST /worldinfo-status', { book_ids: ['My Lorebook', 'Sync Book'] });
    assert.equal(worldStatus.payload.statuses['My Lorebook'].entryCount, 1);
    assert.equal(worldStatus.payload.statuses['Sync Book'].entryCount, 1);

    const semanticSearch = await invoke('POST /search', {
        query: 'A reborn fire bird appeared in the sky.',
        topK: 1,
        scope: { chat_id: 'chat-1', book_ids: ['My Lorebook'] },
        embedding,
    });
    assert.equal(semanticSearch.statusCode, 200);
    assert.equal(semanticSearch.payload.results[0].type, 'worldinfo');
    assert.equal(semanticSearch.payload.results[0].entry_uid, '42');
    assert.equal(semanticSearch.payload.results[0].entry_key, 'Ash Bird Cycle');
    assert.equal(semanticSearch.payload.results[0].book_id, 'My Lorebook');
    assert.doesNotMatch('A reborn fire bird appeared in the sky.', /phoenix/i);

    const separateSearch = await invoke('POST /search', {
        query: 'A reborn fire bird appeared in the sky.',
        separate: true,
        chatTopK: 5,
        worldInfoTopK: 7,
        scope: {
            chat_id: 'chat-1',
            chat_message_id_before: 1,
            book_ids: ['My Lorebook'],
        },
        embedding,
    });
    assert.equal(separateSearch.statusCode, 200);
    assert.deepEqual(separateSearch.payload.chatResults.map(result => result.message_id), [0]);
    assert.deepEqual(separateSearch.payload.worldInfoResults.map(result => result.entry_uid), ['42']);
    assert.equal(separateSearch.payload.errors, undefined);

    const isolatedBookSearch = await invoke('POST /search', {
        query: 'apple',
        topK: 5,
        scope: { chat_id: '', book_ids: ['Sync Book'] },
        embedding,
    });
    assert.ok(isolatedBookSearch.payload.results.every(result => result.book_id === 'Sync Book'));

    const uncheckedWorldInfoSearch = await invoke('POST /search', {
        chatId: 'chat-1',
        query: 'A reborn fire bird appeared in the sky.',
        topK: 5,
        types: ['worldinfo'],
        worldInfoKeys: [],
        embedding,
    });
    assert.deepEqual(uncheckedWorldInfoSearch.payload.results, []);

    const chatOnlySearch = await invoke('POST /search', {
        chatId: 'chat-1',
        query: 'A reborn fire bird appeared in the sky.',
        topK: 5,
        types: ['chat'],
        embedding,
    });
    assert.ok(chatOnlySearch.payload.results.every(result => result.type === 'chat'));

    await vectorStore.updateChunks(root, 'chat-1', current => [...current, {
        id: 'chunk_legacy',
        chat_id: 'chat-1',
        message_ids: [20, 21],
        text: 'legacy packed chunk',
        vector: [1, 0],
        timestamp: 99,
        type: 'chat',
    }]);
    const rebuild = await invoke('POST /ingest', {
        chatId: 'chat-1',
        targetChars: 400,
        embedding,
        force: true,
        messages: [
            { id: 0, role: 'user', text: 'An apple appeared.', timestamp: 100 },
            { id: 1, role: 'assistant', text: 'A banana appeared.', timestamp: 101 },
        ],
    });
    assert.equal(rebuild.payload.chunks, 2);
    assert.equal(embeddingCalls.at(-1).body.input.length, 2, 'rebuild segments are embedded in one batch');
    const rebuiltChunks = await vectorStore.readChunks(root, 'chat-1');
    assert.equal(rebuiltChunks.some(chunk => chunk.id === 'chunk_legacy'), false);
    assert.equal(rebuiltChunks.filter(chunk => chunk.type === 'chat').length, 2);
    assert.equal(rebuiltChunks.filter(chunk => chunk.type === 'worldinfo').length, 0);
    assert.equal((await vectorStore.readWorldInfoChunks(root, 'My Lorebook')).length, 1);

    const status = await invoke('GET /status', {}, { chatId: 'chat-1' });
    assert.equal(status.payload.chunkCount, 2, 'chat status excludes isolated world-info vectors');
    assert.equal(status.payload.phase, 6);
    assert.ok(status.payload.totalSizeBytes > 0);
    assert.ok(status.payload.chatSizeBytes > 0);
    assert.match(status.payload.chatSize, /^\d+(?:\.\d+)? (?:B|KiB|MiB|GiB)$/);

    const clearBook = await invoke('POST /clear', { book_id: 'Sync Book' });
    assert.equal(clearBook.payload.cleared, 1);
    const clearedBookStatus = await invoke('POST /worldinfo-status', { book_ids: ['Sync Book'] });
    assert.equal(clearedBookStatus.payload.statuses['Sync Book'].entryCount, 0);

    global.fetch = async () => {
        throw new Error('connection refused');
    };
    const unreachable = await invoke('POST /ingest', {
        chatId: 'chat-1',
        targetChars: 400,
        embedding,
        messages: [
            { id: 0, role: 'user', text: 'An apple appeared.', timestamp: 100 },
            { id: 1, role: 'assistant', text: 'A banana appeared.', timestamp: 101 },
        ],
        force: true,
    });
    assert.equal(unreachable.statusCode, 502);
    assert.match(unreachable.payload.error, /connection refused/);

    await plugin.exit();
});

test('manual chat memory edits outrank automatic synchronization and can be disabled or restored', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-augment-manual-api-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const originalFetch = global.fetch;
    context.after(() => global.fetch = originalFetch);
    let embeddingCalls = 0;
    global.fetch = async (_url, options) => {
        embeddingCalls++;
        return openAiResponse(JSON.parse(options.body));
    };

    const routes = new Map();
    await plugin.init({
        get(route, handler) {
            routes.set(`GET ${route}`, handler);
        },
        post(route, handler) {
            routes.set(`POST ${route}`, handler);
        },
    });
    async function invoke(route, body = {}, query = {}) {
        let payload;
        let statusCode = 200;
        const response = {
            status(value) {
                statusCode = value;
                return this;
            },
            json(value) {
                payload = value;
                return this;
            },
        };
        await routes.get(route)({
            body,
            query,
            user: { directories: { vectors: root } },
        }, response);
        return { payload, statusCode };
    }

    const embedding = {
        baseUrl: 'https://provider.example',
        apiKey: 'user-key',
        model: 'user-model',
    };
    const sourceMessage = {
        type: 'chat',
        chatId: 'manual-chat',
        targetChars: 400,
        embedding,
        message: { id: 7, role: 'assistant', text: 'An apple appeared.', timestamp: 100 },
    };
    await invoke('POST /ingest', sourceMessage);
    const edited = await invoke('POST /chat-memory/update', {
        chatId: 'manual-chat',
        chunkId: 'msg7_seg0',
        text: 'A pear appeared after the timeline changed.',
        embedding,
    });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.payload.item.manual_override, true);
    assert.equal(edited.payload.item.text, 'A pear appeared after the timeline changed.');
    assert.equal(edited.payload.item.source_text, 'An apple appeared.');

    const rebuilt = await invoke('POST /ingest', {
        ...sourceMessage,
        force: true,
        reconcile: true,
    });
    assert.equal(rebuilt.payload.preservedManual, 1);
    const listed = await invoke('GET /chat-memory', {}, {
        chatId: 'manual-chat',
        offset: 0,
        limit: 50,
    });
    assert.equal(listed.payload.total, 1);
    assert.equal(listed.payload.manualCount, 1);
    assert.equal(listed.payload.items[0].text, 'A pear appeared after the timeline changed.');
    assert.equal(listed.payload.items[0].vector, undefined);
    assert.equal(listed.payload.items[0].vector_dimension, 2);

    const callsBeforeDisable = embeddingCalls;
    await invoke('POST /chat-memory/update', {
        chatId: 'manual-chat',
        chunkId: 'msg7_seg0',
        disabled: true,
    });
    assert.equal(embeddingCalls, callsBeforeDisable, 'disabling a memory must not call the embedding service');
    const disabledSearch = await invoke('POST /search', {
        chatId: 'manual-chat',
        query: 'pear',
        topK: 5,
        embedding,
    });
    assert.deepEqual(disabledSearch.payload.results, []);

    await invoke('POST /chat-memory/update', {
        chatId: 'manual-chat',
        chunkId: 'msg7_seg0',
        disabled: false,
    });
    const restored = await invoke('POST /chat-memory/update', {
        chatId: 'manual-chat',
        chunkId: 'msg7_seg0',
        restore: true,
        embedding,
    });
    assert.equal(restored.payload.item.text, 'An apple appeared.');
    assert.equal(restored.payload.item.manual_override, false);
    assert.equal(restored.payload.item.disabled, false);

    await invoke('POST /chat-memory/update', {
        chatId: 'manual-chat',
        chunkId: 'msg7_seg0',
        text: 'A final manual memory.',
        embedding,
    });
    const reconciliation = await invoke('POST /reconcile-chat', {
        chatId: 'manual-chat',
        messageIds: [],
    });
    assert.equal(reconciliation.payload.preservedManualChunks, 1);
    assert.equal((await vectorStore.readChunks(root, 'manual-chat')).length, 1);
    await plugin.exit();
});
