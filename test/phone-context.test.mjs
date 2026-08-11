import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhoneRetrievalQuery, preparePhoneStoryContext } from '../phone-context.js';
import { buildPhoneUserContent } from '../browser-api-client.js';
import { hashStorySource } from '../story-status.js';

function phoneSnapshot() {
    return {
        profile: { nickname: '夜酱' },
        conversation: {
            type: 'direct',
            name: '沈越',
            identity: { mode: 'worldbook', label: '经纪人沈越', persona: '沈越是严格的经纪人。' },
        },
        messageRecords: [
            { id: 'msg-1', text: '夜酱 [文字]: 昨晚的合同还在你那里吗？' },
            { id: 'msg-2', text: '沈越 [文字]: 在我这里。' },
        ],
        activeMemory: [],
        stickers: [],
    };
}

test('phone retrieval query is centered on the current phone conversation', () => {
    const query = buildPhoneRetrievalQuery(phoneSnapshot(), [
        '[角色] 她刚从发布会回到酒店。',
        '[玩家] 她拿起手机联系经纪人。',
    ]);
    assert.match(query, /手机会话：沈越/);
    assert.match(query, /昨晚的合同还在你那里吗/);
    assert.match(query, /拿起手机联系经纪人/);
});

test('phone story context combines main RAG, keyword world info, status and card foundations', async () => {
    const aiText = '她回到酒店，桌上放着合同副本。';
    const context = {
        name1: '夜酱',
        name2: '艾莉娅',
        characterId: 0,
        characters: [{
            name: '艾莉娅',
            description: '当红演员，也是故事当前主角。',
            personality: '谨慎认真。',
            scenario: '娱乐圈故事。',
            data: {},
        }],
        chatId: 'phone-context-chat',
        chat: [
            { is_user: true, is_system: false, mes: '回酒店。' },
            { is_user: false, is_system: false, mes: aiText },
        ],
        chatMetadata: {
            memory_augment_story_statuses: {
                1: {
                    sourceHash: hashStorySource(aiText),
                    status: {
                        environment: { time: '周五深夜', location: '星河酒店' },
                        event: { activity: '核对合同', situation: '发布会刚结束', goals: [] },
                    },
                },
            },
        },
    };
    const settings = {
        apis: { embedding: { url: 'https://embedding.example/v1', apiKey: 'key', model: 'model' } },
        status: { enabled: true },
        development: { enabled: false },
        map: { includeInPrompt: false },
    };
    let scanned;
    const result = await preparePhoneStoryContext({
        settings,
        context,
        store: {
            chatId: 'phone-context-chat',
            onlineMemory: { events: [{
                id: 'old-phone-event',
                type: 'commitment',
                status: 'resolved',
                conversationId: 'direct-shen',
                summary: '沈越曾答应保留旧合同原件。',
            }] },
        },
        snapshot: phoneSnapshot(),
        recentStory: ['[角色] 她刚从发布会回到酒店。'],
    }, {
        getPowerUser: () => ({ persona_description: '夜酱是艾莉娅的助理。' }),
        getMaxContextSize: () => 65536,
        async getWorldInfoPrompt(messages, maximum, dryRun, globalScanData) {
            scanned = { messages, maximum, dryRun, globalScanData };
            return {
                worldInfoBefore: '{{char}}所属公司规定合同必须由经纪人保管。',
                worldInfoAfter: '',
                worldInfoExamples: [],
                worldInfoDepth: [],
                anBefore: [],
                anAfter: [],
            };
        },
        async retrieveAndInject(chat) {
            chat.unshift({
                role: 'system',
                content: '【历史上下文参考】三十楼前曾签过补充合同。',
                extra: { memory_augment_recall_type: 'history' },
            });
            chat.splice(1, 0, {
                role: 'system',
                content: '[设定召回-娱乐圈] 合同副本由艺人持有。',
                extra: { memory_augment_recall_type: 'worldinfo' },
            });
        },
        async syncPhoneMemory(payload) {
            assert.equal(payload.entries[0].id, 'old-phone-event');
            return { embedded: 1 };
        },
        async searchPhoneMemory(payload) {
            assert.match(payload.query, /昨晚的合同/);
            return { results: [{ memory_event_id: 'old-phone-event' }] };
        },
    });

    assert.match(result.storyFoundation, /夜酱是艾莉娅的助理/);
    assert.match(result.storyFoundation, /当红演员/);
    assert.match(result.retrievedContext, /三十楼前曾签过补充合同/);
    assert.match(result.retrievedContext, /合同副本由艺人持有/);
    assert.match(result.activatedWorldInfo, /艾莉娅所属公司规定/);
    assert.match(result.storyStatus, /周五深夜/);
    assert.match(result.storyStatus, /星河酒店/);
    assert.match(result.phoneMemoryContext, /沈越曾答应保留旧合同原件/);
    assert.equal(scanned.maximum, 65536);
    assert.equal(scanned.dryRun, true);
    assert.match(scanned.messages[0], /手机会话：沈越/);
    assert.equal(scanned.globalScanData.characterDescription, '当红演员，也是故事当前主角。');

    const prompt = buildPhoneUserContent({
        snapshot: phoneSnapshot(),
        recentStory: ['[角色] 她刚从发布会回到酒店。'],
        storyContext: result,
    });
    assert.match(prompt, /酒馆关键词触发的世界书设定/);
    assert.match(prompt, /相关历史总结、正文细节与语义设定召回/);
    assert.match(prompt, /当前剧情状态与时间线/);
    assert.match(prompt, /与本次通讯相关的旧手机记忆/);
    assert.match(prompt, /玩家刚刚发送的手机消息及最新用户正文/);
});

test('phone context still returns card foundations when retrieval sources are empty', async () => {
    const context = {
        characterId: 0,
        characters: [{ name: '艾莉娅', description: '演员。', data: {} }],
        chat: [],
        chatMetadata: {},
    };
    const result = await preparePhoneStoryContext({
        settings: { development: { enabled: false }, map: { includeInPrompt: false } },
        context,
        snapshot: phoneSnapshot(),
        recentStory: [],
    }, {
        getPowerUser: () => ({}),
        async getWorldInfoPrompt() { return {}; },
        async retrieveAndInject() {},
    });
    assert.match(result.storyFoundation, /演员/);
    assert.equal(result.retrievedContext, '');
    assert.equal(result.activatedWorldInfo, '');
});

test('public-world context can skip the unused online-memory retrieval', async () => {
    const result = await preparePhoneStoryContext({
        settings: {
            apis: { embedding: { url: 'https://embedding.example/v1', apiKey: 'key', model: 'model' } },
            development: { enabled: false },
            map: { includeInPrompt: false },
        },
        context: {
            characterId: 0,
            characters: [{ name: '艾莉娅', description: '演员。', data: {} }],
            chatMetadata: {},
        },
        store: {
            chatId: 'public-world-chat',
            onlineMemory: { events: [{ id: 'event-1', summary: '不应检索。' }] },
        },
        snapshot: phoneSnapshot(),
        recentStory: ['正文继续。'],
        includePhoneMemory: false,
    }, {
        getPowerUser: () => ({}),
        async getWorldInfoPrompt() { return {}; },
        async retrieveAndInject() {},
        async syncPhoneMemory() { throw new Error('unused phone memory should be skipped'); },
        async searchPhoneMemory() { throw new Error('unused phone memory should be skipped'); },
    });
    assert.equal(result.phoneMemoryContext, '');
});

test('a broken story index or worldbook scan never blocks phone messaging context', async (testContext) => {
    const originalWarn = console.warn;
    console.warn = () => undefined;
    testContext.after(() => { console.warn = originalWarn; });
    const context = {
        characterId: 0,
        characters: [{ name: '艾莉娅', description: '仍可使用的基础人物设定。', data: {} }],
        chat: [],
        chatMetadata: {},
    };
    const result = await preparePhoneStoryContext({
        settings: { development: { enabled: false }, map: { includeInPrompt: false } },
        context,
        snapshot: phoneSnapshot(),
        recentStory: ['[玩家] 这条最近正文仍然会直接传给手机 API。'],
    }, {
        getPowerUser: () => ({}),
        async getWorldInfoPrompt() { throw new Error('worldbook unavailable'); },
        async retrieveAndInject() { throw new Error('rag unavailable'); },
    });
    assert.match(result.storyFoundation, /仍可使用的基础人物设定/);
    assert.equal(result.retrievedContext, '');
    assert.equal(result.activatedWorldInfo, '');
});
