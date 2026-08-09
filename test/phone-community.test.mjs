import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PHONE_COMMUNITY_FANWORK_FILTERS,
    PHONE_COMMUNITY_FORUM_FILTERS,
    PHONE_COMMUNITY_TABS,
    bindClickSafeHorizontalStrip,
    normalizePhoneCommunityState,
} from '../phone-community.js';

test('community combines forum, CP chart, and fanworks into one app', () => {
    assert.deepEqual(PHONE_COMMUNITY_TABS.map(item => item.label), ['论坛', 'CP榜', '同人区']);
    assert.ok(PHONE_COMMUNITY_FORUM_FILTERS.some(([, label]) => label === '匿名爆料'));
    assert.ok(PHONE_COMMUNITY_FORUM_FILTERS.some(([, label]) => label === '剧情分析'));
    assert.deepEqual(PHONE_COMMUNITY_FANWORK_FILTERS.map(([, label]) => label), ['全部', '同人文', '画作', '剪辑', 'AU', '讨论']);
});

test('community seeds complete lightweight content without overwriting saved content', () => {
    const settings = { phone: {} };
    const seeded = normalizePhoneCommunityState(settings);
    assert.ok(seeded.forumThreads.length >= 4);
    assert.ok(seeded.cpRankings.length >= 5);
    assert.ok(seeded.fanWorks.length >= 5);
    assert.ok(seeded.forumThreads.every(thread => thread.body && thread.comments.length === 5));
    assert.ok(seeded.cpRankings.every(item => item.name && item.weekly && item.trend && item.comments.length === 5));
    assert.ok(seeded.fanWorks.every(work => work.preview && work.commentsList.length === 5));
    const article = seeded.fanWorks.find(work => work.type === 'article');
    assert.ok(article.preview.length >= 80);
    assert.ok(seeded.cpRankings.every(item => item.name !== item.series));
    assert.ok(seeded.cpRankings.every(item => item.pairing && item.series && item.kind && item.kindLabel));
    assert.deepEqual(new Set(seeded.cpRankings.map(item => item.kind)), new Set(['directional', 'group', 'pun', 'allx']));
    assert.ok(seeded.cpRankings.every(item => !('reverse' in item) && !('group' in item) && !('tags' in item)));
    assert.equal(seeded.cpRankings.find(item => item.id === 'cp-starlight').name, '星遥');
    assert.ok(seeded.fanWorks.every(work => [work.series, ...work.characters, work.cpName].every(tag => work.tags.includes(tag))));

    const saved = { phone: { community: { forumThreads: [{ id: 'saved' }], cpRankings: [{ id: 'cp' }], fanWorks: [{ id: 'fan' }] } } };
    const normalized = normalizePhoneCommunityState(saved);
    assert.equal(normalized.forumThreads[0].id, 'saved');
    assert.equal(normalized.cpRankings[0].id, 'cp');
    assert.equal(normalized.fanWorks[0].id, 'fan');
    assert.equal(normalized.fanWorks[0].series, '原创世界');
    assert.ok(normalized.fanWorks[0].tags.includes('未命名CP'));
});

test('community keeps player comment replies and drops incomplete records', () => {
    const settings = { phone: { community: { commentReplies: [
        { id: 'ok', targetType: 'forum', targetId: 'thread-1', commentId: 'comment-1', content: '我也觉得。', createdAt: 123 },
        { id: 'empty', targetId: 'thread-1', commentId: 'comment-1', content: '   ' },
    ] } } };
    const state = normalizePhoneCommunityState(settings);
    assert.deepEqual(state.commentReplies, [{
        id: 'ok', targetType: 'forum', targetId: 'thread-1', commentId: 'comment-1', accountId: '', author: '我', content: '我也觉得。', createdAt: 123,
    }]);
});

test('horizontal strips distinguish a tap from an actual drag', () => {
    const listeners = new Map();
    const classes = new Set();
    const strip = {
        scrollLeft: 20,
        addEventListener(type, listener) { listeners.set(type, listener); },
        classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
        setPointerCapture() {},
        hasPointerCapture() { return true; },
        releasePointerCapture() {},
    };
    assert.equal(bindClickSafeHorizontalStrip(strip), true);

    listeners.get('pointerdown')({ button: 0, isPrimary: true, pointerId: 1, clientX: 100, clientY: 20 });
    let tapPrevented = false;
    listeners.get('pointerup')({ pointerId: 1 });
    listeners.get('click')({ preventDefault() { tapPrevented = true; }, stopImmediatePropagation() {} });
    assert.equal(tapPrevented, false);

    listeners.get('pointerdown')({ button: 0, isPrimary: true, pointerId: 2, clientX: 100, clientY: 20 });
    listeners.get('pointermove')({ pointerId: 2, clientX: 70, clientY: 22, preventDefault() {} });
    assert.equal(strip.scrollLeft, 50);
    assert.equal(classes.has('is-dragging'), true);
    listeners.get('pointerup')({ pointerId: 2 });
    let dragClickPrevented = false;
    listeners.get('click')({ preventDefault() { dragClickPrevented = true; }, stopImmediatePropagation() {} });
    assert.equal(dragClickPrevented, true);
});
