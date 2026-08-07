import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addPhoneSticker,
    appendPhoneMessage,
    buildPhoneAiSnapshot,
    buildPhonePromptContext,
    consumePreparedPhoneContext,
    createEmptyPhoneStore,
    createPhoneConversation,
    createPhoneRoundId,
    formatPhoneContextMessage,
    getRecentRoundMessages,
    loadPhoneStore,
    normalizePhoneStore,
    normalizePhoneIdentity,
    normalizePhoneProfile,
    recordPhoneMemoryEvents,
    savePhoneStore,
    setPhoneRoundSummary,
    splitGroupRedPacket,
    injectPhoneContext,
} from '../phone-store.js';
import { installNativeFetch } from './native-fetch-fixture.mjs';

test('phone profile is a standalone setting and does not require a chat id', () => {
    assert.deepEqual(normalizePhoneProfile({ nickname: ' 夜酱 ', avatar: 'https://example.com/me.png' }), {
        nickname: '夜酱',
        avatar: 'https://example.com/me.png',
    });
    assert.deepEqual(normalizePhoneProfile(), { nickname: '我', avatar: '' });
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

test('phone conversation file persists with the current chat only', async (context) => {
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
    createPhoneConversation(store, { type: 'direct', name: '经纪人' });

    await savePhoneStore(store, chatContext);
    const restored = await loadPhoneStore(chatContext, { force: true });

    assert.equal(restored.profile.nickname, '夜酱');
    assert.equal(restored.conversations[0].name, '经纪人');
    assert.equal(fixture.files.size, 1);
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

test('group red packet allocation is stable, random-looking, and exact', () => {
    const names = ['我', '导演', '主演', '摄影'];
    const first = splitGroupRedPacket(88.88, names, 4, 'packet-1');
    const second = splitGroupRedPacket(88.88, names, 4, 'packet-1');
    assert.deepEqual(first, second);
    assert.equal(first.length, 4);
    assert.equal(first.reduce((sum, item) => sum + Math.round(Number(item.amount) * 100), 0), 8888);
    assert.equal(new Set(first.map(item => item.name)).size, 4);
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
