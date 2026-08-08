import test from 'node:test';
import assert from 'node:assert/strict';
import { beginPhoneStateTransaction } from '../phone-state.js';

test('phone state transaction restores nested mutations after a failed save', async () => {
    const store = { chatId: 'chat-a', conversations: [{ id: 'one', messages: ['old'] }] };
    const transaction = beginPhoneStateTransaction(store);
    store.conversations[0].messages.push('new');

    await assert.rejects(
        () => transaction.persist(async () => { throw new Error('save failed'); }),
        /save failed/,
    );
    assert.deepEqual(store, {
        chatId: 'chat-a',
        conversations: [{ id: 'one', messages: ['old'] }],
    });
});

test('committed phone state transaction cannot roll back a successful save', async () => {
    const store = { chatId: 'chat-a', conversations: [] };
    const transaction = beginPhoneStateTransaction(store);
    store.conversations.push({ id: 'new' });
    await transaction.persist(async target => target);
    transaction.rollback();
    assert.deepEqual(store.conversations, [{ id: 'new' }]);
});
