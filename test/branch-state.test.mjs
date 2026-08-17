import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BRANCH_STATE_KEY,
    prepareBranchState,
} from '../branch-state.js';

function chat(length) {
    return Array.from({ length }, (_, id) => ({
        is_user: id % 2 === 0,
        is_system: false,
        mes: `第${id}楼`,
        send_date: `2026-01-${String(id + 1).padStart(2, '0')}T12:00:00+08:00`,
    }));
}

test('a copied SillyTavern chat becomes an independent branch and drops derived future floors', () => {
    const parent = { chatId: 'parent-chat', chat: chat(8), chatMetadata: {} };
    prepareBranchState(parent);
    parent.chatMetadata.memory_augment_barrages = { 1: { value: 'keep' }, 5: { value: 'drop' } };
    parent.chatMetadata.memory_augment_side_results = { 2: { value: 'keep' }, 6: { value: 'drop' } };
    parent.chatMetadata.memory_augment_custom_panels = { 3: { value: 'drop' } };
    parent.chatMetadata.memory_augment_story_statuses = { 1: { value: 'keep' }, 4: { value: 'drop' } };
    parent.chatMetadata.memory_augment_character_development = {
        version: 2,
        profiles: {},
        candidates: { future: { firstSeenMessageId: 4, lastSeenMessageId: 5 } },
        processed: { 1: { sourceHash: 'keep' }, 4: { sourceHash: 'drop' } },
        dismissed: {},
    };

    const child = {
        chatId: 'Branch #2 - 2026-01-01',
        chat: chat(3),
        chatMetadata: structuredClone(parent.chatMetadata),
    };
    child.chatMetadata.main_chat = 'parent-chat';
    const result = prepareBranchState(child);

    assert.equal(result.createdBranch, true);
    assert.equal(result.state.kind, 'branch');
    assert.equal(result.state.parentChatId, 'parent-chat');
    assert.equal(result.state.forkMessageId, 2);
    assert.equal(result.state.summaryInitialized, false);
    assert.equal(result.state.phoneInitialized, false);
    assert.deepEqual(Object.keys(child.chatMetadata.memory_augment_barrages), ['1']);
    assert.deepEqual(Object.keys(child.chatMetadata.memory_augment_side_results), ['2']);
    assert.deepEqual(Object.keys(child.chatMetadata.memory_augment_custom_panels), []);
    assert.deepEqual(Object.keys(child.chatMetadata.memory_augment_story_statuses), ['1']);
    assert.deepEqual(Object.keys(child.chatMetadata.memory_augment_character_development.processed), ['1']);
    assert.deepEqual(child.chatMetadata.memory_augment_character_development.candidates, {});
});

test('an old default-named branch recovers its original fork floor after it has grown', () => {
    const context = {
        chatId: 'Branch #3 - old save',
        chat: chat(10),
        chatMetadata: { main_chat: 'parent-chat' },
    };
    const result = prepareBranchState(context);
    assert.equal(result.state.forkMessageId, 3);
});

test('renaming an initialized branch changes only its owner identity', () => {
    const context = {
        chatId: 'Branch #2 - old name',
        chat: chat(3),
        chatMetadata: { main_chat: 'parent-chat' },
    };
    const first = prepareBranchState(context).state;
    first.summaryInitialized = true;
    first.summaryTargetBookName = '角色-自动总结2';
    context.chatId = '我改过名字的分支';
    const renamed = prepareBranchState(context);

    assert.equal(renamed.createdBranch, false);
    assert.equal(renamed.state.ownerChatId, '我改过名字的分支');
    assert.equal(renamed.state.parentChatId, 'parent-chat');
    assert.equal(renamed.state.summaryInitialized, true);
    assert.equal(renamed.state.summaryTargetBookName, '角色-自动总结2');
    assert.equal(context.chatMetadata[BRANCH_STATE_KEY], renamed.state);
});
