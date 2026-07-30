import assert from 'node:assert/strict';
import test from 'node:test';
import {
    bindChatIngestionLifecycle,
    enqueueFinalizedMessages,
    getFinalizedTurnMessageIds,
    INGEST_QUEUE_METADATA_KEY,
    reconcileBufferedMessageQueue,
} from '../chat-lifecycle.js';

test('a sent user message finalizes the previous AI floor and includes the user floor', () => {
    const chat = [
        { is_user: true, mes: 'prompt' },
        { is_user: false, mes: 'selected swipe' },
        { is_user: true, mes: 'next prompt' },
    ];
    assert.deepEqual(getFinalizedTurnMessageIds(chat, 2), [1, 2]);
    assert.deepEqual(getFinalizedTurnMessageIds(chat, 1), []);
});

test('a finalized floor is released only after four later confirmed floors', () => {
    const metadata = {};
    const chat = Array.from({ length: 15 }, (_, index) => ({
        is_user: index % 2 === 0,
        mes: `message ${index}`,
    }));
    assert.deepEqual(enqueueFinalizedMessages(metadata, chat, 10).ready, []);
    assert.deepEqual(enqueueFinalizedMessages(metadata, chat, 12).ready, []);
    assert.deepEqual(enqueueFinalizedMessages(metadata, chat, 14).ready, [9, 10]);
    assert.deepEqual(metadata[INGEST_QUEUE_METADATA_KEY], {
        pendingMessageIds: [9, 10, 11, 12, 13, 14],
        lastConfirmedMessageIndex: 14,
    });
});

test('opening a chat rebuilds the four-floor buffer instead of ingesting recent messages', () => {
    const metadata = {};
    const shortChat = [
        { is_user: true, mes: 'floor 0' },
        { is_user: false, mes: 'floor 1' },
        { is_user: true, mes: 'floor 2' },
    ];
    assert.deepEqual(reconcileBufferedMessageQueue(metadata, shortChat), {
        ready: [],
        pending: [0, 1, 2],
        lastConfirmedMessageIndex: 2,
        readyThrough: -2,
    });

    const longChat = Array.from({ length: 9 }, (_, index) => ({
        is_user: index % 2 === 0,
        is_system: index === 1,
        mes: `floor ${index}`,
    }));
    assert.deepEqual(reconcileBufferedMessageQueue(metadata, longChat), {
        ready: [0, 2, 3, 4],
        pending: [5, 6, 7, 8],
        lastConfirmedMessageIndex: 8,
        readyThrough: 4,
    });
});

test('the persistent queue batches ready messages and chat loads reconcile only eligible floors', async () => {
    const handlers = new Map();
    const ingested = [];
    const reconciliations = [];
    const context = {
        chat: [
            { is_user: true, mes: 'prompt' },
            { is_user: false, mes: 'latest swipe' },
            { is_user: true, mes: 'next prompt' },
        ],
        chatMetadata: {},
        saveMetadata: async () => undefined,
        eventTypes: {
            MESSAGE_RECEIVED: 'received',
            MESSAGE_SENT: 'sent',
            MESSAGE_DELETED: 'deleted',
            CHAT_CHANGED: 'changed',
        },
        eventSource: { on: (event, handler) => handlers.set(event, handler) },
    };

    assert.equal(bindChatIngestionLifecycle(context, {
        getContext: () => context,
        ingestMessages: async ids => { ingested.push(ids); return { accepted: ids.length }; },
        reconcileChat: async ids => { reconciliations.push(ids); return { didIngest: ids.length > 0 }; },
    }), true);

    assert.equal(handlers.has('received'), false);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(reconciliations, [[]], 'the already-open chat keeps all three recent floors buffered');
    assert.deepEqual(context.chatMetadata[INGEST_QUEUE_METADATA_KEY].pendingMessageIds, [0, 1, 2]);
    handlers.get('sent')(2);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(ingested, [], 'freshly confirmed messages remain buffered');
    handlers.get('changed')();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(reconciliations, [[], []]);
    handlers.get('deleted')(context.chat.length);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(reconciliations, [[], [], []]);
});
