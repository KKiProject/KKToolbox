import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addPhoneSticker,
    appendPhoneActivityEvent,
    appendPhoneMessage,
    buildPhoneAiSnapshot,
    buildPhonePromptContext,
    clearPreparedPhoneContext,
    commitQueuedPhoneMessages,
    consumePreparedPhoneContext,
    createEmptyPhoneStore,
    createPhoneConversation,
    createPhoneRoundId,
    createPhoneStickerGroup,
    formatPhoneContextMessage,
    formatPhoneMessageForAi,
    forwardPhoneMessages,
    getQueuedPhoneMessages,
    getRecentRoundMessages,
    loadPhoneStore,
    normalizePhoneStore,
    normalizePhoneIdentity,
    normalizePhoneProfile,
    normalizePhoneStickerGroups,
    normalizePhoneStickers,
    parsePhoneStickerLinkBatch,
    recordPhoneMemoryEvents,
    removePhoneConversation,
    removeLatestPhoneReply,
    removePhoneMessage,
    removePhoneStickerGroup,
    renamePhoneConversation,
    renamePhoneStickerGroup,
    savePhoneStore,
    setPhoneRoundSummary,
    splitGroupRedPacket,
    updatePhoneMessage,
    injectPhoneContext,
} from '../phone-store.js';
import { installNativeFetch } from './native-fetch-fixture.mjs';

test('phone profiles normalize independently before being stored in a chat scope', () => {
    assert.deepEqual(normalizePhoneProfile({ nickname: ' 夜酱 ', avatar: 'https://example.com/me.png' }), {
        accountId: '',
        isMask: false,
        nickname: '夜酱',
        avatar: 'https://example.com/me.png',
        bio: '',
        persona: '',
    });
    assert.deepEqual(normalizePhoneProfile(), {
        accountId: '',
        isMask: false,
        nickname: '我',
        avatar: '',
        bio: '',
        persona: '',
    });
});

test('phone conversations keep display names separate from real identities', () => {
    const store = createEmptyPhoneStore('identity-chat');
    const direct = createPhoneConversation(store, {
        type: 'direct',
        name: '死狐狸',
        identity: {
            mode: 'worldbook',
            sourceKey: 'worldbook:people::7',
            label: '世界书 · 经纪人沈越',
            persona: '沈越是经纪人。',
        },
    });
    assert.equal(direct.name, '死狐狸');
    assert.equal(direct.identity.label, '世界书 · 经纪人沈越');
    assert.equal(normalizePhoneIdentity().mode, 'unbound');
});

test('the complete phone profile and app state stay inside the chat-scoped file', async (context) => {
    const originalFetch = globalThis.fetch;
    const originalSillyTavern = globalThis.SillyTavern;
    context.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.SillyTavern = originalSillyTavern;
    });
    const fixture = installNativeFetch();
    globalThis.fetch = fixture.fetch;
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
    const chatContext = { getCurrentChatId: () => 'phone-persistence-test' };
    const store = createEmptyPhoneStore('phone-persistence-test');
    store.profile.nickname = '夜酱';
    store.phone.profile.nickname = '夜酱';
    store.phone.community = { forumThreads: [{ id: 'thread-1', title: '当前存档的话题' }] };
    createPhoneConversation(store, { type: 'direct', name: '经纪人' });

    await savePhoneStore(store, chatContext);
    const restored = await loadPhoneStore(chatContext, { force: true });

    assert.equal(restored.profile.nickname, '夜酱');
    assert.equal(restored.phone.profile.nickname, '夜酱');
    assert.equal(restored.phone.community.forumThreads[0].title, '当前存档的话题');
    assert.equal(restored.conversations[0].name, '经纪人');
    assert.equal(fixture.files.size, 1);
    assert.equal(Object.hasOwn([...fixture.files.values()][0], 'profile'), true);
});

test('phone store refuses to overwrite a different current chat', async (context) => {
    const originalFetch = globalThis.fetch;
    const originalSillyTavern = globalThis.SillyTavern;
    context.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.SillyTavern = originalSillyTavern;
    });
    const fixture = installNativeFetch();
    globalThis.fetch = fixture.fetch;
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
    const store = createEmptyPhoneStore('chat-a');
    createPhoneConversation(store, { type: 'direct', name: '只属于聊天A' });

    await assert.rejects(
        () => savePhoneStore(store, { getCurrentChatId: () => 'chat-b' }),
        /已阻止跨聊天覆盖/,
    );
    assert.equal(store.chatId, 'chat-a');
    assert.equal(fixture.files.size, 0);
});

test('phone store keeps direct and group chats in one lightweight list', () => {
    const store = createEmptyPhoneStore('chat-1');
    const direct = createPhoneConversation(store, { type: 'direct', name: '经纪人' });
    const group = createPhoneConversation(store, { type: 'group', name: '剧组群', members: ['导演', '主演'] });
    appendPhoneMessage(store, direct.id, { sender: '我', fromUser: true, type: 'voice', content: '马上到', duration: 3 });
    appendPhoneMessage(store, group.id, { sender: '导演', type: 'location', content: '一号摄影棚' });
    assert.equal(store.conversations.length, 2);
    assert.equal(direct.messages[0].type, 'voice');
    assert.deepEqual(group.members, ['导演', '主演']);
});

test('creating a group requires two distinct members besides the player', () => {
    const store = createEmptyPhoneStore('group-member-minimum');
    store.profile.nickname = '玩家';
    assert.throws(
        () => createPhoneConversation(store, { type: 'group', name: '不完整群聊', members: ['姐姐', '姐姐'] }),
        /至少需要2名不同的群成员/,
    );
    assert.equal(store.conversations.length, 0);
    assert.throws(
        () => createPhoneConversation(store, { type: 'group', name: '重复玩家', members: ['玩家', '姐姐', '弟弟'] }),
        /不需要重复填写玩家本人/,
    );
    assert.equal(store.conversations.length, 0);
});

test('phone conversations can be renamed and deleted with their online memories', () => {
    const store = createEmptyPhoneStore('manage-conversations');
    const direct = createPhoneConversation(store, { type: 'direct', name: '旧备注' });
    const message = appendPhoneMessage(store, direct.id, { sender: '好友', content: '以后见。' });
    recordPhoneMemoryEvents(store, direct.id, [{
        type: 'commitment',
        summary: '好友说以后见。',
        sourceMessageIds: [message.id],
        evidenceQuotes: ['以后见。'],
        status: 'active',
    }]);

    assert.equal(renamePhoneConversation(store, direct.id, '新昵称备注').name, '新昵称备注');
    assert.equal(removePhoneConversation(store, direct.id).id, direct.id);
    assert.equal(store.conversations.length, 0);
    assert.equal(store.onlineMemory.events.length, 0);
});

test('deleting one phone message clears stale round summaries and linked online memories only', () => {
    const store = createEmptyPhoneStore('delete-message');
    const direct = createPhoneConversation(store, { type: 'direct', name: '好友' });
    const roundId = createPhoneRoundId();
    const first = appendPhoneMessage(store, direct.id, { sender: '我', fromUser: true, content: '明天见。', roundId });
    const second = appendPhoneMessage(store, direct.id, { sender: '好友', content: '明天下午三点。', roundId });
    setPhoneRoundSummary(store, direct.id, roundId, '双方约定明天下午三点见面。');
    recordPhoneMemoryEvents(store, direct.id, [{
        type: 'commitment',
        summary: '约定明天下午三点见面。',
        sourceMessageIds: [second.id],
        evidenceQuotes: ['明天下午三点。'],
        status: 'active',
    }]);

    const result = removePhoneMessage(store, direct.id, second.id);
    assert.equal(result.message.id, second.id);
    assert.equal(result.removedMemoryEvents, 1);
    assert.deepEqual(direct.messages.map(message => message.id), [first.id]);
    assert.equal(direct.rounds[0].summary, '');
    assert.equal(store.onlineMemory.events.length, 0);
    removePhoneMessage(store, direct.id, first.id);
    assert.equal(direct.rounds.length, 0);
});

test('editing a phone message reopens it for the story and invalidates old derived facts', () => {
    const store = createEmptyPhoneStore('edit-message');
    const direct = createPhoneConversation(store, { type: 'direct', name: '好友' });
    const message = appendPhoneMessage(store, direct.id, { sender: '好友', content: '明天见。', storyPending: false });
    setPhoneRoundSummary(store, direct.id, message.roundId, '约定明天见面。');
    recordPhoneMemoryEvents(store, direct.id, [{
        type: 'commitment', summary: '约定明天见面。', sourceMessageIds: [message.id],
        evidenceQuotes: ['明天见。'], status: 'active',
    }]);

    const result = updatePhoneMessage(store, direct.id, message.id, { content: '后天见。' });
    assert.equal(result.message.content, '后天见。');
    assert.equal(result.message.storyPending, true);
    assert.ok(result.message.editedAt > 0);
    assert.equal(result.removedMemoryEvents, 1);
    assert.equal(direct.rounds[0].summary, '');
});

test('multiple phone messages become one independent chat-record snapshot', () => {
    const store = createEmptyPhoneStore('forward-messages');
    store.profile.nickname = '玩家';
    const source = createPhoneConversation(store, { type: 'direct', name: '经纪人' });
    const target = createPhoneConversation(store, { type: 'group', name: '剧组群', members: ['导演', '主演'] });
    const first = appendPhoneMessage(store, source.id, { sender: '经纪人', content: '通告改到下午。' });
    const second = appendPhoneMessage(store, source.id, { sender: '玩家', fromUser: true, content: '收到。' });

    const forwarded = forwardPhoneMessages(store, source.id, target.id, [first.id, second.id], '玩家');
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].type, 'forward_bundle');
    assert.equal(forwarded[0].forwardBundle.title, '经纪人的聊天记录');
    assert.equal(forwarded[0].forwardBundle.messages.length, 2);
    assert.equal(forwarded[0].fromUser, true);
    assert.equal(forwarded[0].queued, true);
    assert.equal(forwarded[0].storyPending, false);
    assert.match(formatPhoneMessageForAi(forwarded[0]), /通告改到下午/);
    assert.match(formatPhoneMessageForAi(forwarded[0]), /收到/);

    first.content = '后来改掉的源消息';
    source.messages.splice(1, 1);
    assert.equal(forwarded[0].forwardBundle.messages[0].content, '通告改到下午。');
    assert.equal(forwarded[0].forwardBundle.messages.length, 2);
});

test('a single forwarded direct-chat message keeps one non-duplicated source name', () => {
    const store = createEmptyPhoneStore('forward-one-message');
    const source = createPhoneConversation(store, { type: 'direct', name: '罗莎姐姐' });
    const target = createPhoneConversation(store, { type: 'direct', name: '好友' });
    const message = appendPhoneMessage(store, source.id, { sender: '罗莎姐姐', content: '会议还有十分钟收尾。' });

    const [forwarded] = forwardPhoneMessages(store, source.id, target.id, [message.id], '玩家');
    assert.equal(forwarded.type, 'text');
    assert.equal(forwarded.forwardedFrom.conversationName, '罗莎姐姐');
    assert.match(formatPhoneMessageForAi(forwarded), /转发自罗莎姐姐】/);
    assert.doesNotMatch(formatPhoneMessageForAi(forwarded), /罗莎姐姐 · 罗莎姐姐/);
});

test('fragmented player bubbles stay queued until the whole batch is sent', () => {
    const store = createEmptyPhoneStore('fragmented-phone-chat');
    const direct = createPhoneConversation(store, { type: 'direct', name: '好友' });
    const roundId = createPhoneRoundId();
    const first = appendPhoneMessage(store, direct.id, {
        sender: '我', fromUser: true, content: '在吗？', roundId, queued: true,
    });
    const second = appendPhoneMessage(store, direct.id, {
        sender: '我', fromUser: true, content: '我有件事想跟你说。', roundId, queued: true,
    });

    assert.equal(first.storyPending, false);
    assert.equal(second.storyPending, false);
    assert.equal(getQueuedPhoneMessages(store, direct.id).length, 2);
    assert.deepEqual(buildPhoneAiSnapshot(store, direct.id).messages, []);
    assert.doesNotMatch(buildPhonePromptContext(store), /在吗/);

    const committed = commitQueuedPhoneMessages(store, direct.id);
    assert.equal(committed.roundId, roundId);
    assert.equal(committed.messages.length, 2);
    assert.equal(first.queued, false);
    assert.equal(second.queued, false);
    assert.equal(first.storyPending, true);
    assert.equal(second.storyPending, true);
    assert.equal(buildPhoneAiSnapshot(store, direct.id).messages.length, 2);
    assert.match(buildPhonePromptContext(store), /我有件事想跟你说/);
});

test('story context places earlier phone history before the newly added latest round', () => {
    const store = createEmptyPhoneStore('phone-context-order');
    const direct = createPhoneConversation(store, { type: 'direct', name: '姐姐' });
    const earlierRound = createPhoneRoundId();
    appendPhoneMessage(store, direct.id, {
        sender: '姐姐', content: '上来书房。', roundId: earlierRound,
        timestamp: 100, storyPending: false,
    });
    appendPhoneMessage(store, direct.id, {
        sender: '我', fromUser: true, content: '但是姐姐在开会。', roundId: earlierRound,
        timestamp: 110, storyPending: false,
    });
    const latestRound = createPhoneRoundId();
    appendPhoneMessage(store, direct.id, {
        sender: '我', fromUser: true, content: '为什么姐姐冷冰冰的。', roundId: latestRound,
        timestamp: 200, storyPending: true,
    });
    appendPhoneMessage(store, direct.id, {
        sender: '姐姐', content: '等我过去，当面纠正你的错误认知。', roundId: latestRound,
        timestamp: 210, storyPending: true,
    });

    const context = buildPhonePromptContext(store);
    assert.match(context, /按发生时间由旧到新，最后一轮为当前最新/);
    assert.match(context, /此前线上轮次 · 单聊·姐姐/);
    assert.match(context, /本次新增线上轮次 · 单聊·姐姐/);
    assert.doesNotMatch(context, /近期单聊/);
    assert.ok(context.indexOf('上来书房') < context.indexOf('为什么姐姐冷冰冰'));
    assert.ok(context.indexOf('为什么姐姐冷冰冰') < context.indexOf('当面纠正你的错误认知'));

    const injected = formatPhoneContextMessage(store).content;
    assert.ok(injected.indexOf('当面纠正你的错误认知') < injected.indexOf('最后一个线上轮次代表手机当前最新状态'));
    assert.match(injected, /正文应优先承接/);
});

test('editing an unsent phone bubble keeps it out of story context', () => {
    const store = createEmptyPhoneStore('edit-queued-message');
    const direct = createPhoneConversation(store, { type: 'direct', name: '好友' });
    const message = appendPhoneMessage(store, direct.id, {
        sender: '我', fromUser: true, content: '错字', queued: true,
    });
    updatePhoneMessage(store, direct.id, message.id, { content: '改好的句子' });
    assert.equal(message.queued, true);
    assert.equal(message.storyPending, false);
    assert.doesNotMatch(buildPhonePromptContext(store), /改好的句子/);
});

test('regenerating the latest phone reply removes it instead of keeping swipe alternatives', () => {
    const store = createEmptyPhoneStore('regenerate-phone-reply');
    const direct = createPhoneConversation(store, { type: 'direct', name: '好友' });
    const roundId = createPhoneRoundId();
    const player = appendPhoneMessage(store, direct.id, {
        sender: '我', fromUser: true, content: '今天见吗？', roundId,
    });
    const firstReply = appendPhoneMessage(store, direct.id, {
        sender: '好友', content: '不见。', roundId,
    });
    const secondReply = appendPhoneMessage(store, direct.id, {
        sender: '好友', content: '我还有事。', roundId,
    });
    setPhoneRoundSummary(store, direct.id, roundId, '好友拒绝了见面。');
    recordPhoneMemoryEvents(store, direct.id, [{
        type: 'explicit_action', summary: '好友说今天不见。',
        sourceMessageIds: [firstReply.id], evidenceQuotes: ['不见。'],
    }]);

    const removed = removeLatestPhoneReply(store, direct.id);
    assert.equal(removed.roundId, roundId);
    assert.deepEqual(removed.messages.map(message => message.id), [firstReply.id, secondReply.id]);
    assert.deepEqual(direct.messages.map(message => message.id), [player.id]);
    assert.equal(direct.rounds[0].summary, '');
    assert.equal(store.onlineMemory.events.length, 0);
});

test('quoted phone messages survive normalization and are visible to the AI', () => {
    const store = createEmptyPhoneStore('quote-message');
    const direct = createPhoneConversation(store, { type: 'direct', name: '好友' });
    const quoted = appendPhoneMessage(store, direct.id, {
        sender: '玩家', fromUser: true, content: '那就这么定。',
        quote: { messageId: 'old', sender: '好友', content: '下午三点见。' },
    });
    assert.equal(quoted.quote.sender, '好友');
    assert.match(formatPhoneMessageForAi(quoted), /引用好友：下午三点见/);
});

test('group red packet allocation is stable, random-looking, and exact', () => {
    const names = ['我', '导演', '主演', '摄影'];
    const first = splitGroupRedPacket(88.88, names, 4, 'packet-1');
    const second = splitGroupRedPacket(88.88, names, 4, 'packet-1');
    assert.deepEqual(first, second);
    assert.equal(first.length, 4);
    assert.equal(first.reduce((sum, item) => sum + Math.round(Number(item.amount) * 100), 0), 8888);
    assert.equal(new Set(first.map(item => item.name)).size, 4);
    assert.deepEqual(new Set(first.map(item => item.name)), new Set(names));
});

test('a direct red packet inside a group keeps its named recipient', () => {
    const store = createEmptyPhoneStore('group-direct-packet');
    const group = createPhoneConversation(store, { type: 'group', name: '剧组群', members: ['导演', '主演'] });
    const packet = appendPhoneMessage(store, group.id, {
        sender: '我',
        fromUser: true,
        type: 'redpacket',
        recipient: '导演',
        amount: 8.88,
        content: '辛苦了',
    });
    assert.equal(packet.recipient, '导演');
    assert.match(formatPhoneMessageForAi(packet), /给导演 8\.88元/);
});

test('sticker names and phone events are exposed to AI without image reading', () => {
    const settings = { phone: { stickers: [] } };
    addPhoneSticker(settings, { name: '猫猫震惊', url: 'https://example.com/cat.gif' });
    const store = createEmptyPhoneStore('chat-2');
    const direct = createPhoneConversation(store, { type: 'direct', name: '好友' });
    appendPhoneMessage(store, direct.id, { sender: '我', fromUser: true, type: 'sticker', stickerName: '猫猫震惊' });
    const snapshot = buildPhoneAiSnapshot(store, direct.id, settings.phone.stickers);
    assert.deepEqual(snapshot.stickers, ['猫猫震惊']);
    assert.match(snapshot.messages[0], /表情包.*猫猫震惊/);
    assert.match(buildPhonePromptContext(store), /线上通讯与手机内容/);
    const generation = [
        { role: 'assistant', content: '正文' },
        { role: 'user', content: '玩家最新回复' },
    ];
    assert.equal(injectPhoneContext(generation, store), true);
    assert.equal(generation[1].name, 'KKToolbox Phone Activity');
    assert.equal(generation[2].content, '玩家最新回复');
});

test('legacy stickers migrate into the default group and custom groups remain reversible', () => {
    const settings = { phone: { stickers: [{ name: '旧表情', url: 'https://example.com/old.gif' }] } };
    assert.deepEqual(normalizePhoneStickerGroups(settings), [{ id: 'default', name: '默认' }]);
    assert.equal(normalizePhoneStickers(settings)[0].groupId, 'default');

    const group = createPhoneStickerGroup(settings, '猫猫');
    addPhoneSticker(settings, { name: '猫猫震惊', url: 'https://example.com/cat.gif', groupId: group.id });
    assert.equal(normalizePhoneStickers(settings).find(item => item.name === '猫猫震惊').groupId, group.id);
    assert.equal(renamePhoneStickerGroup(settings, group.id, '猫猫系列').name, '猫猫系列');
    assert.equal(removePhoneStickerGroup(settings, group.id), true);
    assert.equal(normalizePhoneStickers(settings).find(item => item.name === '猫猫震惊').groupId, 'default');
});

test('batch sticker links accept spaces, hyphens, and bare URLs without a pipe character', () => {
    const result = parsePhoneStickerLinkBatch(`
猫猫震惊 https://img.example/cat.gif
狗狗开心-https://img.example/dog.webp
https://img.example/party_cat.png
这行没有链接
`, 'animals');
    assert.deepEqual(result.items.map(item => item.name), ['猫猫震惊', '狗狗开心', 'party cat']);
    assert.ok(result.items.every(item => item.groupId === 'animals'));
    assert.deepEqual(result.errors, [{ line: 5, message: '没有找到 http 或 https 图片链接。' }]);
});

test('online memory accepts only verbatim evidence and keeps unconfirmed reactions unknown', () => {
    const store = createEmptyPhoneStore('online-memory-chat');
    const direct = createPhoneConversation(store, { type: 'direct', name: '经纪人' });
    const message = appendPhoneMessage(store, direct.id, {
        sender: '经纪人',
        type: 'text',
        content: '明天下午三点在公司见，我会带合同。',
    });
    const result = recordPhoneMemoryEvents(store, direct.id, [
        {
            type: 'commitment',
            summary: '经纪人与玩家约定明天下午三点在公司见面，并会带合同。',
            evidenceQuotes: ['明天下午三点在公司见，我会带合同。'],
            sourceMessageIds: [message.id],
            status: 'active',
        },
        {
            type: 'confirmed_reaction',
            summary: '经纪人看到消息后非常感动。',
            evidenceQuotes: ['明天下午三点在公司见，我会带合同。'],
        },
    ]);
    assert.equal(result.added.length, 1);
    assert.equal(store.onlineMemory.events[0].type, 'commitment');
    assert.equal(store.onlineMemory.events[0].certainty, 'explicit');
    assert.match(buildPhonePromptContext(store), /不等于某人已经看见、理解、赞同或产生情绪/);
    assert.match(buildPhonePromptContext(store), /明天下午三点/);
});

test('pending phone facts are consumed only after a prepared story generation succeeds', async (context) => {
    const originalFetch = globalThis.fetch;
    const originalSillyTavern = globalThis.SillyTavern;
    context.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.SillyTavern = originalSillyTavern;
    });
    const fixture = installNativeFetch();
    globalThis.fetch = fixture.fetch;
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
    const chatContext = { getCurrentChatId: () => 'consume-phone-memory' };
    const store = createEmptyPhoneStore('consume-phone-memory');
    const direct = createPhoneConversation(store, { type: 'direct', name: '朋友' });
    const message = appendPhoneMessage(store, direct.id, { sender: '我', fromUser: true, content: '明天见。' });
    await savePhoneStore(store, chatContext);

    const generation = [{ role: 'user', content: '继续剧情' }];
    assert.equal(injectPhoneContext(generation, store), true);
    assert.equal(message.storyPending, true);
    assert.equal(await consumePreparedPhoneContext(chatContext), true);
    assert.equal(store.conversations[0].messages[0].storyPending, false);
});

test('public app activity accumulates per chat, excludes mask posts, and is consumed only after story success', async (context) => {
    const originalFetch = globalThis.fetch;
    const originalSillyTavern = globalThis.SillyTavern;
    context.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.SillyTavern = originalSillyTavern;
    });
    const fixture = installNativeFetch();
    globalThis.fetch = fixture.fetch;
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
    const chatContext = { getCurrentChatId: () => 'consume-public-phone-activity' };
    const store = createEmptyPhoneStore('consume-public-phone-activity');
    const mainPost = appendPhoneActivityEvent(store, {
        app: 'weibo', tier: 'public_personal', summary: '大号发布了公开微博。', accountId: 'main',
    });
    assert.equal(appendPhoneActivityEvent(store, {
        app: 'weibo', tier: 'public_personal', summary: '马甲发布了微博。', accountId: 'alt', isMask: true,
    }), null);
    const communityReply = appendPhoneActivityEvent(store, {
        app: 'community', tier: 'ambient_role', summary: '在角色讨论帖回复。', isMask: true, participants: ['艾莉娅'],
    });
    await savePhoneStore(store, chatContext);

    const generation = [{ role: 'user', content: '继续剧情' }];
    assert.equal(injectPhoneContext(generation, store), true);
    assert.match(generation[0].content, /大号发布了公开微博/);
    assert.match(generation[0].content, /在角色讨论帖回复/);
    assert.equal(await consumePreparedPhoneContext(chatContext), true);
    assert.equal(store.activity.events.find(event => event.id === mainPost.id).pending, false);
    assert.equal(store.activity.events.find(event => event.id === communityReply.id).pending, false);
});

test('cancelled story generation discards its prepared phone context without consuming facts', async (context) => {
    const originalFetch = globalThis.fetch;
    const originalSillyTavern = globalThis.SillyTavern;
    context.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.SillyTavern = originalSillyTavern;
    });
    const fixture = installNativeFetch();
    globalThis.fetch = fixture.fetch;
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
    const chatContext = { getCurrentChatId: () => 'cancelled-phone-memory' };
    const store = createEmptyPhoneStore('cancelled-phone-memory');
    const direct = createPhoneConversation(store, { type: 'direct', name: '朋友' });
    const message = appendPhoneMessage(store, direct.id, { sender: '我', fromUser: true, content: '稍后见。' });
    await savePhoneStore(store, chatContext);

    assert.equal(injectPhoneContext([{ role: 'user', content: '继续剧情' }], store), true);
    assert.equal(clearPreparedPhoneContext(store.chatId), true);
    assert.equal(await consumePreparedPhoneContext(chatContext), false);
    assert.equal(message.storyPending, true);
});

test('failed phone-context consumption rolls back and remains retryable', async (context) => {
    const originalFetch = globalThis.fetch;
    const originalSillyTavern = globalThis.SillyTavern;
    context.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.SillyTavern = originalSillyTavern;
    });
    const fixture = installNativeFetch();
    globalThis.fetch = fixture.fetch;
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
    const chatContext = { getCurrentChatId: () => 'retry-phone-memory' };
    const store = createEmptyPhoneStore('retry-phone-memory');
    const direct = createPhoneConversation(store, { type: 'direct', name: '朋友' });
    const message = appendPhoneMessage(store, direct.id, { sender: '我', fromUser: true, content: '记得回信。' });
    await savePhoneStore(store, chatContext);
    assert.equal(injectPhoneContext([{ role: 'user', content: '继续剧情' }], store), true);

    let rejectNextUpload = true;
    globalThis.fetch = async (url, options) => {
        if (rejectNextUpload && String(url) === '/api/files/upload') {
            rejectNextUpload = false;
            return { ok: false, status: 500 };
        }
        return fixture.fetch(url, options);
    };
    await assert.rejects(() => consumePreparedPhoneContext(chatContext), /保存手机数据失败/);
    assert.equal(message.storyPending, true);
    assert.equal(await consumePreparedPhoneContext(chatContext), true);
    assert.equal(store.conversations[0].messages[0].storyPending, false);
});

test('legacy phone bubbles migrate into logical player-and-reply rounds', () => {
    const store = normalizePhoneStore({
        version: 2,
        chatId: 'legacy-rounds',
        conversations: [{
            id: 'conversation-1',
            type: 'direct',
            name: '朋友',
            messages: [
                { id: 'm1', sender: '我', fromUser: true, content: '第一轮' },
                { id: 'm2', sender: '朋友', content: '回复气泡一' },
                { id: 'm3', sender: '朋友', content: '回复气泡二' },
                { id: 'm4', sender: '我', fromUser: true, content: '第二轮' },
                { id: 'm5', sender: '朋友', content: '第二轮回复' },
            ],
        }],
    });
    const conversation = store.conversations[0];
    assert.equal(conversation.messages[0].roundId, conversation.messages[1].roundId);
    assert.equal(conversation.messages[1].roundId, conversation.messages[2].roundId);
    assert.equal(conversation.messages[3].roundId, conversation.messages[4].roundId);
    assert.notEqual(conversation.messages[0].roundId, conversation.messages[3].roundId);
    assert.equal(conversation.rounds.length, 2);
});

test('phone history limit counts logical rounds instead of visual bubbles', () => {
    const store = createEmptyPhoneStore('many-rounds');
    const conversation = createPhoneConversation(store, { type: 'direct', name: '朋友' });
    for (let roundIndex = 0; roundIndex < 35; roundIndex += 1) {
        const roundId = createPhoneRoundId();
        appendPhoneMessage(store, conversation.id, {
            sender: '我', fromUser: true, content: `第${roundIndex + 1}轮提问`, roundId,
        });
        for (let bubbleIndex = 0; bubbleIndex < 5; bubbleIndex += 1) {
            appendPhoneMessage(store, conversation.id, {
                sender: '朋友', content: `第${roundIndex + 1}轮回复${bubbleIndex + 1}`, roundId,
            });
        }
        setPhoneRoundSummary(store, conversation.id, roundId, `第${roundIndex + 1}轮概括`);
    }

    const recent = getRecentRoundMessages(conversation, 30);
    const snapshot = buildPhoneAiSnapshot(store, conversation.id, [], 30);
    assert.equal(recent.length, 30 * 6);
    assert.equal(new Set(recent.map(message => message.roundId)).size, 30);
    assert.equal(snapshot.messageRecords.length, 30 * 6);
    assert.equal(snapshot.olderRoundSummaries.length, 5);
});

test('returning to the story carries and consumes every pending phone round', async (context) => {
    const originalFetch = globalThis.fetch;
    const originalSillyTavern = globalThis.SillyTavern;
    context.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.SillyTavern = originalSillyTavern;
    });
    const fixture = installNativeFetch();
    globalThis.fetch = fixture.fetch;
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
    const chatContext = { getCurrentChatId: () => 'all-pending-rounds' };
    const store = createEmptyPhoneStore('all-pending-rounds');
    const conversation = createPhoneConversation(store, { type: 'direct', name: '朋友' });
    for (let roundIndex = 0; roundIndex < 40; roundIndex += 1) {
        const roundId = createPhoneRoundId();
        appendPhoneMessage(store, conversation.id, {
            sender: '我', fromUser: true, content: `待回流第${roundIndex + 1}轮`, roundId,
        });
        appendPhoneMessage(store, conversation.id, {
            sender: '朋友', content: `收到第${roundIndex + 1}轮`, roundId,
        });
    }
    await savePhoneStore(store, chatContext);

    const generation = [{ role: 'user', content: '回到线下剧情' }];
    assert.equal(injectPhoneContext(generation, store), true);
    assert.match(generation[0].content, /待回流第1轮/);
    assert.match(generation[0].content, /收到第40轮/);
    assert.equal(generation[0].extra.phone_message_ids.length, 80);
    assert.equal(await consumePreparedPhoneContext(chatContext), true);
    assert.equal(store.conversations[0].messages.filter(message => message.storyPending).length, 0);
});

test('an oversized pending phone session summarizes old rounds and keeps recent raw rounds', () => {
    const store = createEmptyPhoneStore('oversized-pending');
    const conversation = createPhoneConversation(store, { type: 'direct', name: '朋友' });
    for (let roundIndex = 0; roundIndex < 45; roundIndex += 1) {
        const roundId = createPhoneRoundId();
        appendPhoneMessage(store, conversation.id, {
            sender: '我', fromUser: true, content: `第${roundIndex + 1}轮-${'甲'.repeat(900)}`, roundId,
        });
        appendPhoneMessage(store, conversation.id, {
            sender: '朋友', content: `第${roundIndex + 1}轮回复-${'乙'.repeat(900)}`, roundId,
        });
        setPhoneRoundSummary(store, conversation.id, roundId, `第${roundIndex + 1}轮双方明确聊过计划。`);
    }

    const message = formatPhoneContextMessage(store);
    assert.ok(message);
    assert.ok(message.content.length <= 50_000);
    assert.match(message.content, /较早线上轮次概括/);
    assert.match(message.content, /最近线上轮次原文/);
    assert.match(message.content, /第45轮回复/);
    assert.equal(message.extra.phone_message_ids.length, 90);
});
