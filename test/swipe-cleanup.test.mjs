import test from 'node:test';
import assert from 'node:assert/strict';
import { hashStorySource } from '../story-status.js';
import { compactOldSwipes } from '../swipe-cleanup.js';

test('old assistant swipes keep the selected story text and remap its derived caches to swipe zero', async () => {
    const chat = Array.from({ length: 40 }, (_, index) => ({
        is_user: index % 2 === 0,
        is_system: false,
        mes: `message ${index}`,
    }));
    chat[5] = {
        is_user: false,
        is_system: false,
        mes: '采用的正文',
        swipe_id: 2,
        swipes: ['废案一', '废案二', '采用的正文'],
        swipe_info: [{ tag: 'one' }, { tag: 'two' }, { tag: 'chosen', extra: { old: true } }],
        extra: { chosen: true },
    };
    chat[35] = {
        is_user: false,
        is_system: false,
        mes: '最近采用正文',
        swipe_id: 1,
        swipes: ['最近废案', '最近采用正文'],
        swipe_info: [{}, {}],
    };
    const chosenHash = hashStorySource('采用的正文');
    let saves = 0;
    const context = {
        chat,
        chatMetadata: {
            memory_augment_barrages: {
                5: {
                    version: 3,
                    variants: {
                        'swipe:0': { content: '旧弹幕一', sourceHash: hashStorySource('废案一'), timestamp: 1 },
                        'swipe:2': { content: '采用正文弹幕', sourceHash: chosenHash, timestamp: 2 },
                    },
                },
            },
            memory_augment_side_results: {
                5: {
                    version: 1,
                    variants: {
                        'swipe:0': { sourceHash: hashStorySource('废案一'), statusProcessed: true },
                        'swipe:2': { sourceHash: chosenHash, statusProcessed: true, status: { environment: { time: '今天' } } },
                    },
                },
            },
            memory_augment_story_statuses: { 5: { sourceHash: chosenHash, status: { environment: { time: '今天' } } } },
        },
        async saveChat() { saves++; },
    };

    const result = await compactOldSwipes(context, { keepRecentFloors: 30 });
    assert.equal(result.compactedFloors, 1);
    assert.equal(result.removedAlternatives, 2);
    assert.equal(chat[5].mes, '采用的正文');
    assert.deepEqual(chat[5].swipes, ['采用的正文']);
    assert.equal(chat[5].swipe_id, 0);
    assert.equal(chat[5].swipe_info[0].tag, 'chosen');
    assert.deepEqual(chat[5].swipe_info[0].extra, { chosen: true });
    assert.deepEqual(chat[35].swipes, ['最近废案', '最近采用正文']);
    assert.equal(context.chatMetadata.memory_augment_barrages[5].variants['swipe:0'].content, '采用正文弹幕');
    assert.equal(context.chatMetadata.memory_augment_side_results[5].variants['swipe:0'].sourceHash, chosenHash);
    assert.equal(context.chatMetadata.memory_augment_story_statuses[5].sourceHash, chosenHash);
    assert.equal(saves, 1);
});

test('swipe cleanup never touches user messages or single selected replies', async () => {
    const chat = Array.from({ length: 35 }, (_, index) => ({
        is_user: true,
        is_system: false,
        mes: `user ${index}`,
        swipe_id: 1,
        swipes: ['a', 'b'],
    }));
    chat[1] = { is_user: false, is_system: false, mes: 'only', swipe_id: 0, swipes: ['only'] };
    const context = { chat, chatMetadata: {}, async saveChat() { throw new Error('must not save'); } };
    const result = await compactOldSwipes(context, { keepRecentFloors: 30 });
    assert.equal(result.removedAlternatives, 0);
    assert.deepEqual(chat[0].swipes, ['a', 'b']);
    assert.deepEqual(chat[1].swipes, ['only']);
});

test('hidden historical assistant floors are compacted without deleting their selected text', async () => {
    const chat = Array.from({ length: 35 }, (_, index) => ({
        is_user: index % 2 === 0,
        is_system: false,
        mes: `message ${index}`,
    }));
    chat[1] = {
        is_user: false,
        is_system: true,
        mes: '隐藏后仍采用的正文',
        swipe_id: 1,
        swipes: ['隐藏废案', '隐藏后仍采用的正文'],
        swipe_info: [{}, { extra: { hidden: true } }],
        extra: { hidden: true },
    };
    let saves = 0;
    const context = { chat, chatMetadata: {}, async saveChat() { saves++; } };

    const result = await compactOldSwipes(context, { keepRecentFloors: 30 });
    assert.equal(result.removedAlternatives, 1);
    assert.equal(chat[1].mes, '隐藏后仍采用的正文');
    assert.deepEqual(chat[1].swipes, ['隐藏后仍采用的正文']);
    assert.equal(chat[1].swipe_id, 0);
    assert.equal(saves, 1);
});
