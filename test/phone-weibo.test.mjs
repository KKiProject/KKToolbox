import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPhoneWeiboComments,
    buildPhoneWeiboFeed,
    buildPhoneWeiboRoleAccounts,
    createPhoneWeiboCommentReply,
    createPhoneWeiboPost,
    createPhoneWeiboRepost,
    getPhoneWeiboRelationship,
    normalizePhoneWeiboState,
    PHONE_WEIBO_INTERESTS,
} from '../phone-weibo.js';

test('weibo keeps only known distinct interests and valid local posts', () => {
    const settings = {
        phone: {
            profile: { nickname: '聊天昵称', avatar: 'https://example.com/chat-avatar.png' },
            weibo: {
                interests: ['film', 'film', 'not-real', 'music'],
                posts: [
                    { id: 'mine-1', content: '第一条微博', topic: 'film', customTopic: '#旧话题#', createdAt: 12 },
                    { id: 'empty', content: '   ', topic: 'music' },
                ],
                likedPostIds: ['sample-film-night', 'sample-film-night'],
            },
        },
    };
    const state = normalizePhoneWeiboState(settings);
    assert.deepEqual(state.interests, ['film', 'music']);
    assert.equal(state.posts.length, 1);
    assert.equal(state.posts[0].topic, 'film');
    assert.deepEqual(state.posts[0].customTopics, ['旧话题']);
    assert.deepEqual(state.likedPostIds, ['sample-film-night']);
    assert.deepEqual(state.commentReplies, []);
    assert.deepEqual(state.roleAccounts, []);
    assert.deepEqual(state.followingRoleIds, []);
    assert.deepEqual(state.followerRoleIds, []);
    assert.deepEqual(state.profile, {
        accountId: '',
        isMask: false,
        nickname: '聊天昵称',
        avatar: 'https://example.com/chat-avatar.png',
        bio: '记录故事里正在发生的新鲜事。',
        persona: '',
    });
    settings.phone.profile.nickname = '后来修改的聊天昵称';
    const renormalized = normalizePhoneWeiboState(settings);
    assert.equal(renormalized.profile.nickname, '聊天昵称');
    assert.equal(settings.phone.weibo, renormalized);
});

test('weibo role accounts use a shared explicit registry with separate public nicknames', () => {
    const accounts = buildPhoneWeiboRoleAccounts([
        {
            id: 'role-a',
            nickname: '晚风不熄',
            bio: '偶尔分享片场生活。',
            identity: { mode: 'worldbook', label: '世界书 · 林晚', persona: '真实身份是演员林晚。' },
        },
        { id: 'role-b', nickname: '凌晨三点半', identity: { mode: 'custom', persona: '独立音乐人。' } },
        { id: 'role-a', nickname: '重复账号' },
    ]);
    assert.deepEqual(accounts.map(account => account.nickname), ['晚风不熄', '凌晨三点半']);
    assert.equal(accounts[0].identity.mode, 'worldbook');
    assert.match(accounts[0].identity.persona, /林晚/);
});

test('following and follower lists remain independent and combine into mutual following', () => {
    const state = { followingRoleIds: ['role-a'], followerRoleIds: [] };
    assert.equal(getPhoneWeiboRelationship(state, 'role-a'), 'following');
    state.followerRoleIds.push('role-a');
    assert.equal(getPhoneWeiboRelationship(state, 'role-a'), 'mutual');
    state.followingRoleIds.length = 0;
    assert.equal(getPhoneWeiboRelationship(state, 'role-a'), 'follower');
    assert.equal(getPhoneWeiboRelationship(state, 'role-b'), 'none');
});

test('sample posts expose five post-specific comments ordered by heat', () => {
    const animePost = buildPhoneWeiboFeed({ interests: ['anime'] })
        .find(post => post.id === 'sample-anime-season');
    const comments = buildPhoneWeiboComments(animePost);
    assert.equal(comments.length, 5);
    assert.equal(comments.every(comment => comment.id && comment.author && comment.content), true);
    assert.match(comments.map(comment => comment.content).join('\n'), /第三集|片尾曲|第一集/);
    assert.deepEqual(
        comments.map(comment => comment.likes),
        comments.map(comment => comment.likes).sort((left, right) => right - left),
    );
});

test('a new player post with zero replies has an empty comment area', () => {
    const state = { posts: [] };
    const post = createPhoneWeiboPost(state, {
        id: 'mine-empty-comments',
        content: '今天也来打卡。',
        topic: 'anime',
    }, 1234);
    assert.equal(post.comments, 0);
    assert.deepEqual(buildPhoneWeiboComments(post), []);
});

test('player replies stay attached to one post and one hot comment', () => {
    const state = { commentReplies: [] };
    const reply = createPhoneWeiboCommentReply(state, {
        id: 'reply-1',
        postId: 'post-1',
        commentId: 'comment-1',
        content: '我也注意到这个细节了。',
    }, 4567);
    assert.equal(state.commentReplies[0], reply);
    assert.equal(reply.createdAt, 4567);
    assert.equal(reply.commentId, 'comment-1');
    assert.throws(() => createPhoneWeiboCommentReply(state, {
        postId: 'post-1', commentId: 'comment-1', content: ' ',
    }), /不能为空/);
});

test('reposting creates a distinct player post with a preserved source card', () => {
    const state = { posts: [] };
    const repost = createPhoneWeiboRepost(state, {
        id: 'repost-1',
        content: '这个我也看到了。',
        source: {
            postId: 'sample-anime-season',
            author: '次元放送站',
            badge: '动漫博主',
            content: '本季新番第三集讨论。',
            topic: 'anime',
        },
    }, 8910);
    assert.equal(repost.kind, 'repost');
    assert.equal(repost.source.author, '次元放送站');
    assert.equal(repost.source.postId, 'sample-anime-season');
    assert.equal(repost.createdAt, 8910);
    assert.equal(state.posts[0], repost);
});

test('weibo recommendation feed places selected interests before general samples', () => {
    const feed = buildPhoneWeiboFeed({ interests: ['pets'] });
    assert.equal(feed.length, 11);
    assert.equal(feed[0].topics.includes('pets'), true);
    assert.equal(feed.every(post => buildPhoneWeiboComments(post).length === 5), true);
    const filmFeed = buildPhoneWeiboFeed({ interests: ['pets'] }, 'film');
    assert.equal(filmFeed[0].topics.includes('film'), true);
});

test('publishing a local weibo post preserves its topic and rejects empty text', () => {
    const state = { posts: [] };
    const post = createPhoneWeiboPost(state, {
        id: 'mine-2',
        content: '终于开始做微博了。🌙',
        topic: 'entertainment',
        customTopics: ['#片场夜话#', '收工日记', '片场夜话'],
        imageDescription: '雨夜车窗外的霓虹灯。',
        location: '星光影视城',
        mentions: [{ id: 'role-a', nickname: '月亮不营业' }],
    }, 1234);
    assert.equal(state.posts[0], post);
    assert.equal(post.createdAt, 1234);
    assert.equal(post.topic, 'entertainment');
    assert.deepEqual(post.customTopics, ['片场夜话', '收工日记']);
    assert.equal(post.imageDescription, '雨夜车窗外的霓虹灯。');
    assert.equal(post.location, '星光影视城');
    assert.deepEqual(post.mentions, [{ id: 'role-a', nickname: '月亮不营业' }]);
    assert.throws(() => createPhoneWeiboPost(state, { content: ' ' }), /不能为空/);
});

test('weibo onboarding offers a broad but finite interest catalog', () => {
    assert.equal(PHONE_WEIBO_INTERESTS.length, 17);
    assert.equal(new Set(PHONE_WEIBO_INTERESTS.map(item => item.id)).size, 17);
    assert.equal(PHONE_WEIBO_INTERESTS.some(item => item.id === 'anime' && item.label === '二次元'), true);
});
