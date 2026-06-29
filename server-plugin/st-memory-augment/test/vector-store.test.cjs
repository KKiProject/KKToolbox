'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
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
    assert.equal(status.lastUpdatedAt, 20);

    const otherChatChunks = [
        { id: 'other', chat_id: 'other-chat', text: 'private other chat', vector: [1, 0], timestamp: 30, type: 'chat' },
    ];
    await vectorStore.replaceChunks(root, 'other-chat', otherChatChunks);
    const isolatedResults = await vectorStore.searchChunks(root, chatId, [1, 0], 10);
    assert.equal(isolatedResults.some(result => result.id === 'other'), false);
    assert.deepEqual(await vectorStore.readChunks(root, 'other-chat'), otherChatChunks);

    const storedEntries = await fs.readdir(path.join(root, vectorStore.STORE_NAMESPACE));
    assert.equal(storedEntries.length, 2);
    assert.ok(storedEntries.every(entry => /^[a-f0-9]{64}$/.test(entry)));
    assert.equal(await vectorStore.clearChat(root, chatId), 2);
    assert.deepEqual(await vectorStore.readChunks(root, chatId), []);
});
