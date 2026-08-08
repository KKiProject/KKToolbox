import test from 'node:test';
import assert from 'node:assert/strict';
import { recallPhoneMemoryEvents } from '../phone-memory-recall.js';

test('shared phone-memory recall synchronizes once, filters current facts, and removes duplicates', async () => {
    const events = [
        { id: 'event-1', summary: '当前会话已经带入的事实', type: 'commitment', status: 'active', conversationId: 'c1' },
        { id: 'event-2', summary: '需要额外召回的事实', type: 'conflict', status: 'resolved', conversationId: 'c2' },
    ];
    let synchronizedEntries = [];
    const recalled = await recallPhoneMemoryEvents({
        store: { chatId: 'chat-a', onlineMemory: { events } },
        query: '召回相关手机事实',
        embedding: { baseUrl: 'https://example.com', apiKey: 'key', model: 'model' },
        excludeIds: ['event-1'],
        sync: async payload => { synchronizedEntries = payload.entries; },
        search: async () => ({
            results: [
                { memory_event_id: 'event-2' },
                { memory_event_id: 'event-2' },
                { memory_event_id: 'event-1' },
                { memory_event_id: 'missing' },
            ],
        }),
    });

    assert.deepEqual(synchronizedEntries.map(entry => entry.id), ['event-1', 'event-2']);
    assert.deepEqual(recalled, [events[1]]);
});
