import test from 'node:test';
import assert from 'node:assert/strict';

import { applyWorldInfoVectorStatuses } from '../world-info-manager.js';

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
