'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vectorStore = require('../vector-store');

test('persists chunks and returns cosine-ranked results', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-augment-store-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const chatId = '../../unsafe/chat-name';
    const chunks = [
        { id: 'a', chat_id: chatId, text: 'apple memory', vector: [1, 0], timestamp: 10, type: 'chat' },
        { id: 'b', chat_id: chatId, text: 'banana memory', vector: [0, 1], timestamp: 20, type: 'chat' },
    ];

    await vectorStore.replaceChunks(root, chatId, chunks);
    assert.deepEqual(await vectorStore.readChunks(root, chatId), chunks);

    const results = await vectorStore.searchChunks(root, chatId, [0.9, 0.1], 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'a');
    assert.equal(Object.hasOwn(results[0], 'vector'), false);

    const status = await vectorStore.getStoreStatus(root, chatId);
    assert.equal(status.chunkCount, 2);
    assert.equal(status.totalChunkCount, 2);
    assert.ok(status.totalSizeBytes > 0);
    assert.ok(status.chatSizeBytes > 0);
    assert.equal(status.lastUpdatedAt, 20);

    const otherChatChunks = [
        { id: 'other', chat_id: 'other-chat', text: 'private other chat', vector: [1, 0], timestamp: 30, type: 'chat' },
    ];
    await vectorStore.replaceChunks(root, 'other-chat', otherChatChunks);
    const statusAfterOtherChat = await vectorStore.getStoreStatus(root, chatId);
    assert.equal(statusAfterOtherChat.chatSizeBytes, status.chatSizeBytes);
    assert.ok(statusAfterOtherChat.totalSizeBytes > status.totalSizeBytes);
    const isolatedResults = await vectorStore.searchChunks(root, chatId, [1, 0], 10);
    assert.equal(isolatedResults.some(result => result.id === 'other'), false);
    assert.deepEqual(await vectorStore.readChunks(root, 'other-chat'), otherChatChunks);

    await vectorStore.updateChunks(root, chatId, current => [...current, {
        id: 'legacy-no-type',
        chat_id: chatId,
        message_ids: [10, 11],
        text: 'legacy packed chat memory',
        vector: [1, 0],
        timestamp: 25,
    }]);
    const legacyResults = await vectorStore.searchChunks(root, chatId, [1, 0], 10, ['chat']);
    const legacy = legacyResults.find(result => result.id === 'legacy-no-type');
    assert.equal(legacy.type, 'chat');
    assert.deepEqual(legacy.message_ids, [10, 11]);

    const storedEntries = await fs.readdir(path.join(root, vectorStore.CHAT_NAMESPACE));
    assert.equal(storedEntries.length, 2);
    assert.ok(storedEntries.every(entry => /^[a-f0-9]{64}$/.test(entry)));
    assert.equal(await vectorStore.clearChat(root, chatId), 3);
    assert.deepEqual(await vectorStore.readChunks(root, chatId), []);
});

test('stores chat and world-info metadata/vectors separately and migrates legacy mixed data', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-augment-layout-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const chatId = 'chat-layout';
    const key = crypto.createHash('sha256').update(chatId).digest('hex');
    const legacyDirectory = path.join(root, vectorStore.LEGACY_NAMESPACE, key);
    await fs.mkdir(legacyDirectory, { recursive: true });
    await fs.writeFile(path.join(legacyDirectory, 'chunks.json'), JSON.stringify([
        { id: 'old-chat', chat_id: chatId, message_ids: [1, 2], text: 'old chat', vector: [1, 0], type: 'chat' },
        { id: 'old-world', world_info_book: 'Legacy Book', world_info_id: '9', text: 'old lore', vector: [0, 1], type: 'worldinfo' },
    ]));

    const migratedChat = await vectorStore.readChunks(root, chatId);
    assert.deepEqual(migratedChat.map(chunk => chunk.id), ['old-chat']);
    assert.deepEqual((await vectorStore.readWorldInfoChunks(root, 'Legacy Book')).map(chunk => chunk.id), ['old-world']);
    const chatDirectory = path.join(root, vectorStore.CHAT_NAMESPACE, key);
    assert.ok(await fs.stat(path.join(chatDirectory, 'chunks.json')));
    assert.ok(await fs.stat(path.join(chatDirectory, 'vectors.json')));
    const storedMetadata = JSON.parse(await fs.readFile(path.join(chatDirectory, 'chunks.json'), 'utf8'));
    assert.equal(Object.hasOwn(storedMetadata[0], 'vector'), false);
    const storedVectors = JSON.parse(await fs.readFile(path.join(chatDirectory, 'vectors.json'), 'utf8'));
    assert.deepEqual(storedVectors['old-chat'], [1, 0]);
    await assert.rejects(fs.stat(legacyDirectory), error => error.code === 'ENOENT');
});

test('reconciles stored message ids against the current chat and removes orphaned chunks', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-augment-reconcile-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const chatId = 'reconciled-chat';
    await vectorStore.replaceChunks(root, chatId, [
        { id: 'current-0', message_id: 0, text: 'current', vector: [1, 0], type: 'chat' },
        { id: 'orphan-2a', message_id: 2, text: 'deleted a', vector: [0, 1], type: 'chat' },
        { id: 'orphan-2b', message_id: 2, text: 'deleted b', vector: [0, 1], type: 'chat' },
        { id: 'legacy-mixed', message_ids: [0, 3], text: 'contains deleted content', vector: [1, 1], type: 'chat' },
        { id: 'unmapped', text: 'cannot be tied to current chat', vector: [1, 1], type: 'chat' },
    ]);

    const result = await vectorStore.reconcileChatMessages(root, chatId, [0, 1]);

    assert.deepEqual(result.currentMessageIds, ['0', '1']);
    assert.deepEqual(result.storedMessageIds.sort(), ['0', '2', '3']);
    assert.deepEqual(result.orphanMessageIds.sort(), ['2', '3']);
    assert.equal(result.removedChunks, 4);
    assert.deepEqual((await vectorStore.readChunks(root, chatId)).map(chunk => chunk.id), ['current-0']);

    const emptyResult = await vectorStore.reconcileChatMessages(root, chatId, []);
    assert.deepEqual(emptyResult.orphanMessageIds, ['0']);
    assert.equal(emptyResult.removedChunks, 1);
    assert.deepEqual(await vectorStore.readChunks(root, chatId), []);
});

test('search scope excludes recent chat floors before ranking without filtering world info', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-augment-recent-window-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const chatId = 'recent-window-chat';
    await vectorStore.replaceChunks(root, chatId, [
        { id: 'old', message_id: 2, text: 'old history', vector: [1, 0], type: 'chat' },
        { id: 'recent', message_id: 8, text: 'recent raw text', vector: [1, 0], type: 'chat' },
        { id: 'legacy-overlap', message_ids: [4, 5], text: 'overlapping legacy text', vector: [1, 0], type: 'chat' },
    ]);
    await vectorStore.replaceWorldInfoChunks(root, 'Lore', [
        { id: 'lore', book_id: 'Lore', entry_uid: '1', text: 'canonical lore', vector: [1, 0], type: 'worldinfo' },
    ]);

    const chatResults = await vectorStore.searchScopes(root, {
        chat_id: chatId,
        chat_message_id_before: 5,
        book_ids: [],
    }, [1, 0], 10);
    const worldInfoResults = await vectorStore.searchScopes(root, {
        chat_id: '',
        book_ids: ['Lore'],
    }, [1, 0], 10);

    assert.deepEqual(chatResults.map(result => result.id), ['old']);
    assert.deepEqual(worldInfoResults.map(result => result.id), ['lore']);
});

test('manual and disabled memories survive reconciliation while disabled memories never rank', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-augment-manual-memory-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const chatId = 'manual-memory-chat';
    await vectorStore.replaceChunks(root, chatId, [
        { id: 'auto', message_id: 10, text: 'automatic old timeline', vector: [1, 0], type: 'chat' },
        {
            id: 'manual',
            message_id: 11,
            text: 'player corrected memory',
            vector: [1, 0],
            type: 'chat',
            manual_override: true,
        },
        {
            id: 'disabled',
            message_id: 12,
            text: 'player disabled memory',
            vector: [1, 0],
            type: 'chat',
            disabled: true,
        },
    ]);

    const reconciliation = await vectorStore.reconcileChatMessages(root, chatId, []);
    assert.equal(reconciliation.removedChunks, 1);
    assert.equal(reconciliation.preservedManualChunks, 2);
    assert.deepEqual(
        (await vectorStore.readChunks(root, chatId)).map(chunk => chunk.id),
        ['manual', 'disabled'],
    );

    const ranked = await vectorStore.searchScopes(root, {
        chat_id: chatId,
        book_ids: [],
    }, [1, 0], 10);
    assert.deepEqual(ranked.map(chunk => chunk.id), ['manual']);
});
