import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PHONE_COMMUNITY_FANWORK_FILTERS,
    PHONE_COMMUNITY_FORUM_FILTERS,
    PHONE_COMMUNITY_TABS,
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
    assert.ok(seeded.forumThreads.every(thread => thread.body && Array.isArray(thread.comments)));
    assert.ok(seeded.cpRankings.every(item => item.name && item.weekly && item.trend));
    assert.ok(seeded.fanWorks.every(work => work.preview && Array.isArray(work.commentsList)));
    const article = seeded.fanWorks.find(work => work.type === 'article');
    assert.ok(article.preview.length >= 80);

    const saved = { phone: { community: { forumThreads: [{ id: 'saved' }], cpRankings: [{ id: 'cp' }], fanWorks: [{ id: 'fan' }] } } };
    const normalized = normalizePhoneCommunityState(saved);
    assert.deepEqual(normalized.forumThreads, [{ id: 'saved' }]);
    assert.deepEqual(normalized.cpRankings, [{ id: 'cp' }]);
    assert.deepEqual(normalized.fanWorks, [{ id: 'fan' }]);
});
