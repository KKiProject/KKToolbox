import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneSession } from '../phone-session.js';
import { installNativeFetch } from './native-fetch-fixture.mjs';

test('legacy global phone data migrates once and every later chat receives an isolated phone', async (context) => {
    const originalFetch = globalThis.fetch;
    const originalSillyTavern = globalThis.SillyTavern;
    context.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.SillyTavern = originalSillyTavern;
    });
    const fixture = installNativeFetch();
    globalThis.fetch = fixture.fetch;
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
    let chatId = 'scoped-phone-a';
    const settings = {
        phone: {
            profile: { nickname: '旧大号' },
            weibo: { posts: [{ id: 'legacy-post', content: '只迁移一次' }] },
        },
    };
    const contextValue = () => ({
        getCurrentChatId: () => chatId,
        name1: chatId === 'scoped-phone-a' ? '玩家甲' : '玩家乙',
        saveSettingsDebounced() {},
    });
    const session = createPhoneSession(settings, contextValue);

    const first = await session.ensure();
    assert.equal(first.phone.profile.nickname, '旧大号');
    assert.equal(first.phone.weibo.posts[0].id, 'legacy-post');
    assert.deepEqual(settings.phone, { scopedStorageVersion: 1 });
    const weiboReference = first.phone.weibo;
    session.settings.phone.weibo.posts.push({ id: 'chat-a-post', content: 'A存档' });
    await session.save();
    assert.equal(first.phone.weibo, weiboReference, 'saving must not detach an open app from its state object');

    chatId = 'scoped-phone-b';
    session.invalidate();
    const second = await session.ensure();
    assert.equal(second.phone.profile.nickname, '玩家乙');
    assert.deepEqual(second.phone.weibo, {});
    session.settings.phone.weibo.posts = [{ id: 'chat-b-post', content: 'B存档' }];
    await session.save();

    chatId = 'scoped-phone-a';
    session.invalidate();
    const restored = await session.ensure({ force: true });
    assert.deepEqual(restored.phone.weibo.posts.map(post => post.id), ['legacy-post', 'chat-a-post']);
    assert.equal(settings.phoneScopedStorage.migratedChatId, 'scoped-phone-a');
});
