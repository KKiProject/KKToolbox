import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhoneUserContent } from '../browser-api-client.js';
import {
    getPhoneFieldValidationMessage,
    getForwardSourceLabel,
    getLuckyKingClaimIndex,
    isPhoneIdentityEntry,
    loadPhoneIdentitySources,
    parsePhoneAiBundle,
    parsePhoneAiResponse,
    parsePhoneGroupMembers,
    requestPhoneAiBundle,
} from '../phone-messages.js';

test('forward source labels collapse duplicate direct-chat names but keep group origins', () => {
    assert.equal(getForwardSourceLabel({ conversationName: '罗莎姐姐', sender: '罗莎姐姐' }), '罗莎姐姐');
    assert.equal(getForwardSourceLabel({ conversationName: '剧组群', sender: '罗莎姐姐' }), '剧组群 · 罗莎姐姐');
});

test('simulated red packets accept any positive amount with at most two decimal places', () => {
    const field = {
        name: 'amount',
        label: '金额',
        type: 'number',
        min: 0.01,
        step: 0.01,
        required: true,
    };
    assert.equal(getPhoneFieldValidationMessage(field, '0.01'), '');
    assert.equal(getPhoneFieldValidationMessage(field, '8'), '');
    assert.equal(getPhoneFieldValidationMessage(field, '8.8'), '');
    assert.equal(getPhoneFieldValidationMessage(field, '8.88'), '');
    assert.match(getPhoneFieldValidationMessage(field, '8.888'), /最多保留两位小数/);
    assert.match(getPhoneFieldValidationMessage(field, '0'), /不能小于 0\.01/);
});

test('group red packet marks only the highest claimant as lucky king', () => {
    assert.equal(getLuckyKingClaimIndex([{ amount: '1.20' }]), -1);
    assert.equal(getLuckyKingClaimIndex([
        { name: '我', amount: '8.88' },
        { name: '导演', amount: '16.66' },
        { name: '主演', amount: '9.99' },
    ]), 1);
});

test('phone identity picker excludes summaries and obvious non-character lore', () => {
    assert.equal(isPhoneIdentityEntry({ name: '[KKT摘要][第1-10楼]', content: '艾莉娅做了什么。' }), false);
    assert.equal(isPhoneIdentityEntry({ name: '世界地图与主要区域', content: '大陆由三块区域组成。' }), false);
    assert.equal(isPhoneIdentityEntry({ name: '经纪人沈越', content: '身份：经纪人。性格严厉，私下护短。' }), true);
});

test('phone identity sources include the current card and linked worldbook entries', async () => {
    const context = {
        characterId: 0,
        characters: [{
            name: '艾莉娅',
            description: '王城骑士。',
            personality: '坚定而温柔。',
            data: {},
        }],
    };
    const sources = await loadPhoneIdentitySources(context, async () => [{
        linkedToCharacter: true,
        name: '王城人物',
        entries: [{ key: '王城人物::7', name: '经纪人沈越', entryKey: '沈越, 经纪人', content: '沈越行事严厉，私下护短。' }],
    }]);
    assert.equal(sources[0].mode, 'character_card');
    assert.match(sources[0].persona, /艾莉娅/);
    assert.equal(sources[1].mode, 'worldbook');
    assert.match(sources[1].label, /经纪人沈越/);
});

test('phone AI response accepts every supported simulated message type', () => {
    const result = parsePhoneAiResponse(`\`\`\`json
    {"messages":[
        {"sender":"艾莉","type":"text","content":"到了"},
        {"sender":"艾莉","type":"voice","content":"开门","duration":4},
        {"sender":"艾莉","type":"image","content":"后台门口的夜景"},
        {"sender":"艾莉","type":"redpacket","content":"庆功","amount":8.88,"recipient":"夜酱"},
        {"sender":"艾莉","type":"group_redpacket","content":"大家辛苦了","amount":66,"count":5},
        {"sender":"艾莉","type":"location","content":"星光影视城 A3 棚"},
        {"sender":"艾莉","type":"sticker","stickerName":"猫猫震惊"}
    ]}
    \`\`\``);

    assert.deepEqual(result.map(item => item.type), [
        'text', 'voice', 'image', 'redpacket', 'group_redpacket', 'location', 'sticker',
    ]);
    assert.equal(result.at(-1).stickerName, '猫猫震惊');
    assert.equal(result[1].duration, 4);
    assert.equal(result[3].recipient, '夜酱');
});

test('phone AI keeps the original eight-message response cap', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
        sender: ['姐姐', '弟弟', '妈妈'][index % 3],
        type: 'text',
        content: `第${index + 1}条`,
    }));
    assert.equal(parsePhoneAiResponse(JSON.stringify({ messages })).length, 8);
});

test('phone AI response accepts one top-level JSON object in a code fence', () => {
    const result = parsePhoneAiResponse(`\`\`\`json
        {"messages":[{"sender":"艾莉","type":"text","content":"到了"}]}
    \`\`\``);
    assert.equal(result.length, 1);
    assert.equal(result[0].content, '到了');
});

test('phone group member input requires distinct names', () => {
    assert.deepEqual(parsePhoneGroupMembers('姐姐，弟弟\n姐姐, 妈妈'), ['姐姐', '弟弟', '妈妈']);
});

test('phone AI response does not mistake unrelated empty arrays for messages', () => {
    assert.throws(
        () => parsePhoneAiResponse('{"memory":{"events":[]},"roundSummary":"没有消息"}'),
        /没有返回消息列表/,
    );
});

test('malformed phone JSON reports the damaged line instead of hiding the response', () => {
    assert.throws(
        () => parsePhoneAiResponse(`{
  "messages": [
    {"sender":"姐姐","type":"text","content":"第一条"}
    {"sender":"弟弟","type":"text","content":"第二条"}
  ]
}`),
        error => {
            assert.match(error.message, /第 4 行第 5 列/);
            assert.match(error.message, /弟弟/);
            assert.match(error.rawResponse, /第一条/);
            return true;
        },
    );
});

test('phone AI sends one request and accepts a group reply from one member', async () => {
    let calls = 0;
    const bundle = await requestPhoneAiBundle(async () => {
        calls += 1;
        return { content: '{"messages":[{"sender":"姐姐","type":"text","content":"还在开会"}]}' };
    }, { snapshot: { conversation: { type: 'group', members: ['姐姐', '弟弟'] } } });
    assert.equal(calls, 1);
    assert.equal(bundle.messages[0].sender, '姐姐');
    assert.equal(bundle.messages[0].content, '还在开会');
});

test('phone prompt lets AI use named stickers but never asks it to read their images', () => {
    const prompt = buildPhoneUserContent({
        recentStory: ['[角色] 演出刚刚结束。'],
        snapshot: {
            profile: { nickname: '夜酱' },
            conversation: { type: 'group', name: '庆功群', members: ['夜酱', '艾莉', '西娅'] },
            messages: ['夜酱 [文字]: 今晚辛苦了'],
            stickers: ['猫猫震惊', '彻底疯狂'],
        },
    });

    assert.match(prompt, /允许发言者：艾莉、西娅/);
    assert.doesNotMatch(prompt, /允许发言者：[^\n]*夜酱/);
    assert.match(prompt, /只扮演对话中的联系人或群成员，不扮演玩家/);
    assert.match(prompt, /猫猫震惊、彻底疯狂/);
    assert.match(prompt, /必须逐字选择上面已有的表情包名称/);
    assert.match(prompt, /不需要也不得读取表情包图片内容/);
    assert.match(prompt, /图片内容描述/);
    assert.match(prompt, /群聊可由一个或多个群成员分别发言/);
    assert.doesNotMatch(prompt, /至少两名|每名参与者必须各发2至5条/);
});

test('an unbound phone nickname cannot inherit the card protagonist persona', () => {
    const prompt = buildPhoneUserContent({
        recentStory: ['[角色卡主角] 她刚刚结束演出。'],
        snapshot: {
            profile: { nickname: '夜酱' },
            conversation: {
                type: 'direct',
                name: '随手打的备注名',
                identity: { mode: 'unbound' },
            },
            messages: [],
            stickers: [],
        },
    });
    assert.match(prompt, /尚未绑定真实身份/);
    assert.match(prompt, /不得把角色卡主角或最近正文中的其他人物人格套给此联系人/);
    assert.match(prompt, /绑定人物设定 ＞ 手机聊天记录中已成立的信息 ＞ 最近正文/);
});

test('phone response can carry evidence-backed online memory separately from messages', () => {
    const bundle = parsePhoneAiBundle(JSON.stringify({
        messages: [{ sender: '经纪人', type: 'text', content: '明天下午三点见。' }],
        roundSummary: '经纪人明确约好明天下午三点见面。',
        memory: {
            events: [{
                type: 'commitment',
                summary: '约定明天下午三点见面。',
                participants: ['经纪人'],
                evidenceQuotes: ['明天下午三点见。'],
                status: 'active',
            }],
        },
    }));
    assert.equal(bundle.messages.length, 1);
    assert.equal(bundle.roundSummary, '经纪人明确约好明天下午三点见面。');
    assert.equal(bundle.memoryEvents[0].type, 'commitment');
    assert.deepEqual(bundle.memoryEvents[0].evidenceQuotes, ['明天下午三点见。']);
});

test('phone prompt keeps round markers and never drops its hard rules when trimmed', () => {
    const prompt = buildPhoneUserContent({
        recentStory: ['最新正文'],
        storyContext: {
            storyStatus: '状态'.repeat(20_000),
            storyFoundation: '设定'.repeat(20_000),
            retrievedContext: '召回'.repeat(20_000),
        },
        snapshot: {
            profile: { nickname: '我' },
            conversation: { type: 'direct', name: '朋友', identity: { mode: 'unbound' } },
            messageRecords: Array.from({ length: 80 }, (_, index) => ({
                id: `msg-${index}`,
                roundId: `round-${Math.floor(index / 4)}`,
                text: `朋友 [文字]: ${'消息'.repeat(200)}`,
            })),
            olderRoundSummaries: [{ id: 'old-round', summary: '较早轮次概括' }],
            activeMemory: [],
            stickers: [],
        },
    });
    assert.ok(prompt.length <= 50_000);
    assert.match(prompt, /【较早手机轮次概括】/);
    assert.match(prompt, /【最近手机轮次原文】/);
    assert.match(prompt, /\[轮次 round-19\]\[msg-79\]/);
    assert.match(prompt, /视觉上拆成多个气泡仍然是一轮/);
    assert.match(prompt, /roundSummary 只概括本轮真实出现的对话事实/);
});

test('phone prompt reserves space for the latest story before old round summaries', () => {
    const prompt = buildPhoneUserContent({
        recentStory: ['LATEST_STORY_SENTINEL'],
        snapshot: {
            profile: { nickname: '我' },
            conversation: { type: 'direct', name: '朋友', identity: { mode: 'unbound' } },
            messageRecords: Array.from({ length: 100 }, (_, index) => ({
                id: `msg-${index}`,
                roundId: `round-${index}`,
                text: `朋友 [文字]: ${'消息'.repeat(200)}`,
            })),
            olderRoundSummaries: Array.from({ length: 1000 }, (_, index) => ({
                id: `old-round-${index}`,
                summary: '旧摘要'.repeat(300),
            })),
            activeMemory: [],
            stickers: [],
        },
    });

    assert.ok(prompt.length <= 50_000);
    assert.match(prompt, /LATEST_STORY_SENTINEL/);
    assert.match(prompt, /roundSummary 只概括本轮真实出现的对话事实/);
});

test('short phone conversations keep every round raw even when they run for a long time', () => {
    const prompt = buildPhoneUserContent({
        snapshot: {
            profile: { nickname: '我' },
            conversation: { type: 'direct', name: '朋友', identity: { mode: 'unbound' } },
            messageRecords: Array.from({ length: 200 }, (_, index) => ({
                id: `short-${index}`,
                roundId: `short-round-${Math.floor(index / 2)}`,
                text: index % 2 === 0 ? `我 [文字]: 第${index / 2 + 1}轮` : '朋友 [文字]: 收到',
            })),
            activeMemory: [],
            stickers: [],
        },
    });
    assert.match(prompt, /\[轮次 short-round-0\]\[short-0\]/);
    assert.match(prompt, /\[轮次 short-round-99\]\[short-199\]/);
    assert.doesNotMatch(prompt, /【较早手机轮次概括】/);
});

test('phone prompt forbids inferring views or reactions from platform presence', () => {
    const prompt = buildPhoneUserContent({
        recentStory: [],
        snapshot: {
            profile: { nickname: '我' },
            conversation: { type: 'direct', name: '经纪人', identity: { mode: 'unbound' } },
            messageRecords: [{ id: 'msg-1', text: '我 [文字]: 热搜上出现了一篇同人文。' }],
            activeMemory: [],
            stickers: [],
        },
    });
    assert.match(prompt, /都不代表任何角色已经看见、读完、理解、赞同、讨厌或产生情绪/);
    assert.match(prompt, /只有角色在消息里明确说出的反应才能记为 confirmed_reaction/);
    assert.match(prompt, /逐字存在于本次输出消息或上面的手机聊天记录/);
});
