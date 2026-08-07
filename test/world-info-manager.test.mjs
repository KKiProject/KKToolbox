import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyWorldInfoVectorStatuses,
    isManagedSummaryWorldInfoBook,
    normalizeWorldInfoEntries,
    rebuildAllCurrentWorldInfo,
    vectorizeSelectedWorldInfo,
} from '../world-info-manager.js';

test('world info vector status accepts native direct status maps', () => {
    const books = [
        { id: '🎮炮灰万人迷', vectorizedEntries: 0 },
        { id: '自动总结', vectorizedEntries: 99 },
    ];

    applyWorldInfoVectorStatuses(books, {
        '🎮炮灰万人迷': { entryCount: 14, chunkCount: 53 },
        '自动总结': { entryCount: 0, chunkCount: 0 },
    });

    assert.equal(books[0].vectorizedEntries, 14);
    assert.equal(books[1].vectorizedEntries, 0);
});

test('world info vector status still accepts legacy wrapped responses', () => {
    const books = [{ id: '主世界书', vectorizedEntries: 0 }];

    applyWorldInfoVectorStatuses(books, {
        statuses: { '主世界书': { entryCount: 8 } },
    });

    assert.equal(books[0].vectorizedEntries, 8);
});

test('automatic summary lorebooks are recognized by suffix or managed entry keys', () => {
    assert.equal(isManagedSummaryWorldInfoBook({ id: '角色A-自动总结', entries: [] }), true);
    const [entry] = normalizeWorldInfoEntries([{
        world: '旧名称摘要书',
        uid: 3,
        content: '剧情摘要',
        key: ['[KKT摘要][第1-15楼]'],
    }]);
    assert.equal(entry.managedBySummaryRag, true);
    assert.equal(isManagedSummaryWorldInfoBook({ id: '旧名称摘要书', entries: [entry] }), true);
    assert.equal(isManagedSummaryWorldInfoBook({ id: '普通世界书', entries: [{ managedBySummaryRag: false }] }), false);
});

test('automatic summary lorebooks cannot be duplicated into ordinary world-info vectors', async () => {
    const calls = [];
    const settings = {
        apis: { embedding: { url: 'https://example.com/v1', apiKey: 'test', model: 'embedding' } },
        rag: {
            segmentTargetChars: 400,
            semanticWorldInfoBooks: ['角色A-自动总结', '主世界书'],
            semanticWorldInfoEntries: [],
        },
    };
    const books = [
        { id: '角色A-自动总结', entries: [{ uid: '1', key: '角色A-自动总结::1', entryKey: '摘要', content: '摘要正文' }] },
        { id: '主世界书', entries: [{ uid: '2', key: '主世界书::2', entryKey: '王城', content: '王城正文' }] },
    ];
    await vectorizeSelectedWorldInfo(settings, {}, books, async payload => {
        calls.push(payload);
        return { entries: payload.entries.length, chunks: payload.entries.length };
    });

    assert.equal(calls[0].book_id, '角色A-自动总结');
    assert.equal(calls[0].entries.length, 0);
    assert.equal(calls[0].sync_mode, 'replace');
    assert.equal(calls[1].entries.length, 1);
    assert.equal(calls[1].sync_mode, 'merge');
});

test('ordinary world info updates merge selected entries while rebuilding all current books ignores selection', async () => {
    const calls = [];
    const settings = {
        apis: { embedding: { url: 'https://example.com/v1', apiKey: 'test', model: 'embedding' } },
        rag: {
            segmentTargetChars: 400,
            semanticWorldInfoBooks: [],
            semanticWorldInfoEntries: ['主世界书::2'],
        },
    };
    const books = [{
        id: '主世界书',
        entries: [
            { uid: '1', key: '主世界书::1', entryKey: '旧条目', content: '没有修改' },
            { uid: '2', key: '主世界书::2', entryKey: '新条目', content: '刚刚修改' },
        ],
    }];
    const client = async payload => {
        calls.push(payload);
        return { entries: payload.entries.length, chunks: payload.entries.length };
    };

    await vectorizeSelectedWorldInfo(settings, {}, books, client);
    await rebuildAllCurrentWorldInfo(settings, {}, books, client);

    assert.equal(calls[0].sync_mode, 'merge');
    assert.deepEqual(calls[0].entries.map(entry => entry.entry_uid), ['2']);
    assert.equal(calls[1].sync_mode, 'replace');
    assert.deepEqual(calls[1].entries.map(entry => entry.entry_uid), ['1', '2']);
});
