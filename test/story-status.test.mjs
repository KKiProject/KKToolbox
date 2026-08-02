import assert from 'node:assert/strict';
import test from 'node:test';
import {
    STORY_STATUS_METADATA_KEY,
    STORY_TIMELINE_METADATA_KEY,
    applyStoryTimelineUpdate,
    applyStoryStatusOptions,
    correctLatestStoryTime,
    getLatestStoryStatus,
    getMessageTimelineMetadata,
    hashStorySource,
    injectLatestStoryStatus,
    parseSideResponse,
    saveStoryStatus,
    shouldCloseStoryPanelForPointer,
    shouldShowStoryFloatingButton,
} from '../story-status.js';

function status(label) {
    return {
        environment: { time: label, location: '王城 → 酒馆', season: '冬季', weather: '雪' },
        characters: [
            { name: '玩家', role: 'user', emotion: '警觉' },
            { name: '角色', role: 'char', innerThoughts: '不能让玩家发现秘密' },
        ],
        event: { activity: '交谈', situation: '局势紧张', goals: ['找到线索'] },
    };
}

test('confirmation popups do not close the floating story panel', () => {
    const panel = { hidden: false };
    const popupTarget = { closest: selector => selector.includes('.popup') ? {} : null };
    const ordinaryOutsideTarget = { closest: () => null };
    const root = { contains: target => target === root };

    assert.equal(shouldCloseStoryPanelForPointer(root, panel, popupTarget), false);
    assert.equal(shouldCloseStoryPanelForPointer(root, panel, ordinaryOutsideTarget), true);
    assert.equal(shouldCloseStoryPanelForPointer(root, panel, root), false);
});

test('the floating story button can be hidden independently from status generation', () => {
    assert.equal(shouldShowStoryFloatingButton(undefined), true);
    assert.equal(shouldShowStoryFloatingButton({}), true);
    assert.equal(shouldShowStoryFloatingButton({ showFloatingButton: true }), true);
    assert.equal(shouldShowStoryFloatingButton({ showFloatingButton: false }), false);
});

test('combined side response separates barrage text from structured status', () => {
    const parsed = parseSideResponse(`\`\`\`json\n${JSON.stringify({
        barrage: '围观！',
        status: status('午夜'),
        timeline: {
            transition: 'jump',
            currentTime: '十年后',
            segments: [{ messageId: 9, startQuote: '十年后', time: '十年后', mode: 'mainline' }],
        },
        development: { changes: [{ character: '角色', dimension: 'belief', after: '开始相信玩家' }] },
    })}\n\`\`\``);
    assert.equal(parsed.barrage, '围观！');
    assert.equal(parsed.status.environment.time, '午夜');
    assert.equal(parsed.status.characters[1].innerThoughts, '不能让玩家发现秘密');
    assert.equal(parsed.timeline.transition, 'jump');
    assert.equal(parsed.timeline.segments[0].messageId, 9);
    assert.equal(parsed.development.changes[0].after, '开始相信玩家');
});

test('story timeline preserves unchanged time, supports jumps and keeps flashbacks off the mainline', () => {
    const chat = Array.from({ length: 7 }, (_, id) => ({
        mes: `message ${id}`,
        is_user: id % 2 === 1,
        is_system: false,
    }));
    const context = { chat, chatMetadata: {} };

    let result = applyStoryTimelineUpdate(context, 0, status('王历100年春'), {
        transition: 'unknown',
        currentTime: '王历100年春',
    }, hashStorySource(chat[0].mes));
    saveStoryStatus(context, 0, result.status, hashStorySource(chat[0].mes));

    result = applyStoryTimelineUpdate(context, 2, status('王历100年夏（模型误猜）'), {
        transition: 'unchanged',
        currentTime: '王历100年夏（模型误猜）',
    }, hashStorySource(chat[2].mes));
    assert.equal(result.status.environment.time, '王历100年春');
    saveStoryStatus(context, 2, result.status, hashStorySource(chat[2].mes));

    result = applyStoryTimelineUpdate(context, 4, status('王历110年春'), {
        transition: 'jump',
        currentTime: '王历110年春',
        elapsed: '十年后',
    }, hashStorySource(chat[4].mes));
    saveStoryStatus(context, 4, result.status, hashStorySource(chat[4].mes));
    assert.equal(getMessageTimelineMetadata(context, 0).relationToCurrent, '十年后');

    result = applyStoryTimelineUpdate(context, 6, status('王历100年冬'), {
        transition: 'enter_flashback',
        currentTime: '王历100年冬',
        elapsed: '主线九年三个月前',
    }, hashStorySource(chat[6].mes));
    saveStoryStatus(context, 6, result.status, hashStorySource(chat[6].mes));
    const flashback = getMessageTimelineMetadata(context, 6);
    assert.equal(flashback.sceneTime, '王历100年冬');
    assert.equal(flashback.mainlineTime, '王历110年春');
    assert.match(flashback.relationToCurrent, /主线九年三个月前/);

    assert.equal(correctLatestStoryTime(context, '王历100年冬月初三'), true);
    assert.equal(getLatestStoryStatus(context).status.environment.time, '王历100年冬月初三');
    assert.equal(context.chatMetadata[STORY_TIMELINE_METADATA_KEY].anchors[flashback.mainlineAnchorId].label, '王历110年春');
});

test('only player-defined and enabled custom character fields survive', () => {
    const source = status('午夜');
    source.characters[0].extras = [
        { label: '伤势', value: '手臂擦伤' },
        { label: 'AI自己编的状态', value: '不应出现' },
    ];
    const filtered = applyStoryStatusOptions(source, {
        customFields: [
            { label: '伤势', enabled: true },
            { label: '疲惫', enabled: false },
        ],
    });
    assert.deepEqual(filtered.characters[0].extras, [{ label: '伤势', value: '手臂擦伤' }]);
});

test('latest valid snapshot follows the remaining chat timeline', () => {
    const chat = [
        { mes: '开场', is_user: false },
        { mes: '玩家一', is_user: true },
        { mes: '角色一', is_user: false },
        { mes: '玩家二', is_user: true },
        { mes: '角色二', is_user: false },
    ];
    const context = {
        chat,
        chatMetadata: {
            [STORY_STATUS_METADATA_KEY]: {
                2: { status: status('第一天'), sourceHash: hashStorySource(chat[2].mes) },
                4: { status: status('第二天'), sourceHash: hashStorySource(chat[4].mes) },
                8: { status: status('已删除的未来') },
            },
        },
    };

    assert.equal(getLatestStoryStatus(context).status.environment.time, '第二天');
    context.chat = chat.slice(0, 4);
    assert.equal(getLatestStoryStatus(context).status.environment.time, '第一天');
});

test('status is injected immediately before the latest user message', () => {
    const persistentChat = [
        { mes: '开场', is_user: false },
        { mes: '玩家一', is_user: true },
        { mes: '角色一', is_user: false },
        { mes: '玩家二', is_user: true },
    ];
    const context = {
        chat: persistentChat,
        extensionSettings: {
            'st-memory-augment': { status: { enabled: true, showGoals: true, customFields: [] } },
        },
        chatMetadata: {
            [STORY_STATUS_METADATA_KEY]: {
                2: { status: status('第一天'), sourceHash: hashStorySource(persistentChat[2].mes) },
            },
        },
    };
    const generationChat = structuredClone(persistentChat);

    assert.equal(injectLatestStoryStatus(generationChat, context), true);
    assert.equal(generationChat[3].extra.memory_augment_story_status, true);
    assert.match(generationChat[3].mes, /第一天/);
    assert.equal(generationChat[4].mes, '玩家二');
});
