import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyPhoneWeiboBatch,
    parsePhoneWeiboAiBatch,
    PHONE_WEIBO_FEED_LIMIT,
} from '../phone-weibo-ai.js';

function comments(postId) {
    return Array.from({ length: 5 }, (_, index) => ({
        id: `${postId}-comment-${index}`,
        author: `网友${index}`,
        content: `针对 ${postId} 的具体评论 ${index}`,
        likes: 50 - index,
    }));
}

function aiPost(id, overrides = {}) {
    return {
        id,
        authorType: 'npc',
        author: `作者${id}`,
        content: `帖子${id}的独立正文`,
        metrics: { reposts: 1, comments: 5, likes: 10 },
        hotComments: comments(id),
        ...overrides,
    };
}

function emptyState() {
    return {
        posts: [],
        feedPostIds: [],
        hotTopics: [],
        commentReplies: [],
        likedPostIds: [],
        generationBatches: [],
        followerCount: 0,
    };
}

test('story role posts require an existing bound account and verbatim story evidence', () => {
    const request = {
        mode: 'story',
        batchId: 'batch-story',
        profile: { nickname: '玩家' },
        storyText: '雨停以后，林晚推开门，把伞放在走廊。',
        roleAccounts: [{
            id: 'role-lin',
            nickname: '晚风不熄',
            avatar: '',
            identity: { mode: 'custom', persona: '林晚，演员。' },
        }],
    };
    const raw = JSON.stringify({
        posts: [
            aiPost('role-post', {
                authorType: 'role',
                authorId: 'role-lin',
                storyEvidence: '林晚推开门',
            }),
            ...Array.from({ length: 4 }, (_, index) => aiPost(`npc-${index}`)),
        ],
        hotTopics: [],
        followerDelta: 1,
        followerReason: '剧情讨论带来少量关注',
    });
    const parsed = parsePhoneWeiboAiBatch(raw, request);
    assert.equal(parsed.posts[0].author, '晚风不熄');
    assert.equal(parsed.posts[0].hotComments.length, 5);

    const invalid = JSON.parse(raw);
    invalid.posts[0].storyEvidence = '正文里不存在的动作';
    assert.throws(() => parsePhoneWeiboAiBatch(JSON.stringify(invalid), request), /并非正文原句/);
});

test('player text is immutable and remains hidden when the generated package is invalid', () => {
    const request = {
        mode: 'player_post',
        batchId: 'batch-player',
        profile: { nickname: '玩家' },
        roleAccounts: [],
        operation: { content: '这是玩家写下的原文。' },
    };
    const invalid = JSON.stringify({
        posts: [aiPost('player-post', { authorType: 'player', content: '被 AI 改写的版本。' })],
        hotTopics: [],
        followerDelta: 0,
    });
    assert.throws(() => parsePhoneWeiboAiBatch(invalid, request), /改写了玩家输入/);
});

test('player post decorations must survive AI enrichment exactly', () => {
    const operation = {
        content: '原样发布。',
        customTopics: ['片场夜话', '收工'],
        imageDescription: '雨夜车窗',
        location: '星光影视城',
        mentions: [{ id: 'role-a', nickname: '晚风' }],
    };
    const request = {
        mode: 'player_post',
        batchId: 'batch-player-exact',
        profile: { nickname: '玩家' },
        roleAccounts: [],
        operation,
    };
    const raw = JSON.stringify({
        posts: [aiPost('player-exact', { authorType: 'player', ...operation })],
        hotTopics: [],
        followerDelta: 1,
        followerReason: '公开发帖',
    });
    const parsed = parsePhoneWeiboAiBatch(raw, request);
    assert.deepEqual(parsed.posts[0].customTopics, operation.customTopics);
    const changed = JSON.parse(raw);
    changed.posts[0].location = '被改掉的位置';
    assert.throws(() => parsePhoneWeiboAiBatch(JSON.stringify(changed), request), /改动或遗漏/);
});

test('feed keeps 30 newest posts, deletes evicted NPC posts, and preserves player and role archives', () => {
    const state = emptyState();
    const posts = [
        { ...aiPost('old-player', { authorType: 'player' }), createdAt: 1 },
        { ...aiPost('old-role', { authorType: 'role', authorId: 'role-a' }), createdAt: 2 },
        { ...aiPost('old-npc'), createdAt: 3 },
        ...Array.from({ length: 30 }, (_, index) => ({ ...aiPost(`new-npc-${index}`), createdAt: index + 4 })),
    ];
    const result = applyPhoneWeiboBatch(state, {
        posts,
        hotTopics: [{ id: 'old-hot', title: '旧路人热搜', postId: 'old-npc', heat: 10, mark: '' }],
        reply: null,
        followerDelta: 0,
        followerReason: '',
    }, {
        mode: 'story',
        batchId: 'batch-retention',
        sourceKey: 'chat:1:0:story',
        chatId: 'chat',
        messageId: '1',
        swipeIndex: 0,
        now: 100,
    });
    assert.equal(state.feedPostIds.length, PHONE_WEIBO_FEED_LIMIT);
    assert.equal(state.feedPostIds.includes('old-player'), false);
    assert.equal(state.feedPostIds.includes('old-role'), false);
    assert.equal(state.posts.some(post => post.id === 'old-player'), true);
    assert.equal(state.posts.some(post => post.id === 'old-role'), true);
    assert.equal(state.posts.some(post => post.id === 'old-npc'), false);
    assert.equal(state.hotTopics.some(topic => topic.postId === 'old-npc'), false);
    assert.deepEqual(result.deletedIds, ['old-npc']);
});

test('a new swipe replaces the old story batch and duplicate source keys do nothing', () => {
    const state = emptyState();
    const first = {
        posts: [{ ...aiPost('swipe-zero'), createdAt: 1 }],
        hotTopics: [],
        reply: null,
        followerDelta: 2,
        followerReason: '第一版',
    };
    const second = {
        posts: [{ ...aiPost('swipe-one'), createdAt: 2 }],
        hotTopics: [],
        reply: null,
        followerDelta: 3,
        followerReason: '第二版',
    };
    applyPhoneWeiboBatch(state, first, {
        mode: 'story', batchId: 'batch-0', sourceKey: 'chat:7:0:story', messageId: '7', swipeIndex: 0,
    });
    applyPhoneWeiboBatch(state, second, {
        mode: 'story', batchId: 'batch-1', sourceKey: 'chat:7:1:story', messageId: '7', swipeIndex: 1,
    });
    assert.deepEqual(state.posts.map(post => post.id), ['swipe-one']);
    assert.equal(state.followerCount, 3);
    const snapshot = JSON.stringify(state);
    const duplicate = applyPhoneWeiboBatch(state, second, {
        mode: 'story', batchId: 'batch-1-copy', sourceKey: 'chat:7:1:story', messageId: '7', swipeIndex: 1,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(JSON.stringify(state), snapshot);
});
