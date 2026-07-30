'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildMessageSegmentDrafts, splitMessageText } = require('../index');

test('keeps short messages whole and splits long messages at natural sentence boundaries', () => {
    assert.deepEqual(splitMessageText('你好。', 400), ['你好。']);

    const first = `${'甲'.repeat(389)}。`;
    const second = `${'乙'.repeat(389)}。`;
    const tail = '丙'.repeat(50);
    const segments = splitMessageText(`${first}${second}${tail}`, 400);
    assert.equal(segments.length, 2);
    assert.equal(Array.from(segments[0]).length, 390);
    assert.equal(Array.from(segments[1]).length, 440, 'a tail shorter than 100 chars merges backward');
});

test('extends past the target to punctuation and uses comma boundaries for overlong sentences', () => {
    const text = `${'甲'.repeat(410)}，${'乙'.repeat(300)}`;
    const segments = splitMessageText(text, 400);
    assert.equal(segments.length, 2);
    assert.ok(segments[0].endsWith('，'));
    assert.equal(Array.from(segments[0]).length, 411);
    assert.equal(Array.from(segments[1]).length, 300);
});

test('builds one-message segment records with stable ids and required metadata', () => {
    const text = `${'甲'.repeat(410)}。${'乙'.repeat(200)}`;
    const drafts = buildMessageSegmentDrafts('chat-7', [{
        id: 10,
        role: 'assistant',
        text,
        timestamp: 1700000000,
    }], 400, 'signature');

    assert.equal(drafts.length, 2);
    assert.deepEqual(drafts.map(draft => draft.id), ['msg10_seg0', 'msg10_seg1']);
    assert.deepEqual(drafts.map(draft => draft.segment_index), [0, 1]);
    assert.ok(drafts.every(draft => draft.chat_id === 'chat-7'));
    assert.ok(drafts.every(draft => draft.message_id === 10));
    assert.ok(drafts.every(draft => draft.role === 'assistant'));
    assert.ok(drafts.every(draft => draft.char_count === Array.from(draft.text).length));
    assert.ok(drafts.every(draft => draft.timestamp === 1700000000));
    assert.ok(drafts.every(draft => !Object.hasOwn(draft, 'message_ids')));
});
