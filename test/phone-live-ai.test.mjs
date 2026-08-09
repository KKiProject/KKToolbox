import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyPhoneLiveAiPhase,
    buildPhoneLiveAiRequest,
    parsePhoneLiveAiPhase,
    requestPhoneLiveOperation,
} from '../phone-live-ai.js';
import { normalizePhoneLiveState } from '../phone-live.js';

function rawPhase({ room = null, id = 'phase-1', viewerDelta = 3, followerDelta = 2 } = {}) {
    return JSON.stringify({
        room,
        phase: {
            id,
            scenes: [
                { kind: 'narration', segment: '开场', text: '镜头亮起，直播正式开始。' },
                { kind: 'dialogue', segment: '开场', speaker: '嘉宾甲', speakerRole: '参与者', speakerType: 'participant', text: '晚上好。' },
            ],
            barrages: Array.from({ length: 8 }, (_, index) => ({
                id: `${id}-b-${index + 1}`,
                author: `观众${index + 1}`,
                content: `与本阶段相关的弹幕${index + 1}`,
                likes: index,
                replyable: true,
            })),
            gifts: [{ id: `${id}-gift`, author: '送礼观众', label: '小花束', icon: '🌷', value: 10 }],
            viewerDelta,
            followerDelta,
            summary: `阶段 ${id} 已完成。`,
        },
        sessionSummary: `直播已经推进到 ${id}。`,
    });
}

test('start phase preserves exact player speech and starts an own live session atomically', () => {
    const settings = { phone: {} };
    const state = normalizePhoneLiveState(settings);
    const request = {
        mode: 'start',
        now: 1000,
        profile: { nickname: '小K' },
        operation: { sessionId: 'own-1', title: '今晚聊天', speech: '大家晚上好，一字不改。', format: 'chat' },
    };
    const batch = parsePhoneLiveAiPhase(rawPhase({
        room: { title: '今晚聊天', summary: '轻松聊天直播。', cover: '卧室', initialViewers: 12 },
    }), request);
    assert.equal(batch.phase.scenes[0].speaker, '小K');
    assert.equal(batch.phase.scenes[0].text, '大家晚上好，一字不改。');
    applyPhoneLiveAiPhase(state, batch, request);
    assert.equal(state.ownLive.status, 'live');
    assert.equal(state.ownLive.sessionId, 'own-1');
    assert.equal(state.ownLive.viewerCount, 15);
    assert.equal(state.ownLive.peakViewers, 15);
    assert.equal(state.ownLive.followerDelta, 2);
    assert.equal(state.ownLive.giftTotal, 10);
    assert.equal(state.ownLive.phases.length, 1);
});

test('next and end phases preserve selected barrage ids and finish the session', () => {
    const settings = { phone: {} };
    const state = normalizePhoneLiveState(settings);
    const startRequest = { mode: 'start', now: 1000, profile: { nickname: '我' }, operation: { sessionId: 'own-2', title: '游戏夜' } };
    applyPhoneLiveAiPhase(state, parsePhoneLiveAiPhase(rawPhase({
        room: { title: '游戏夜', summary: '打游戏。', cover: '桌面', initialViewers: 20 },
        id: 'start',
    }), startRequest), startRequest);

    const nextRequest = {
        mode: 'next',
        now: 2000,
        profile: { nickname: '我' },
        operation: { selectedBarrages: [{ id: 'start-b-2', author: '观众2', content: '问题' }] },
    };
    const nextBatch = parsePhoneLiveAiPhase(rawPhase({ id: 'next', viewerDelta: -5, followerDelta: 1 }), nextRequest);
    applyPhoneLiveAiPhase(state, nextBatch, nextRequest);
    assert.deepEqual(state.ownLive.phases.at(-1).selectedBarrageIds, ['start-b-2']);
    assert.equal(state.ownLive.status, 'live');

    const endRequest = { mode: 'end', now: 3000, profile: { nickname: '我' }, operation: {} };
    applyPhoneLiveAiPhase(state, parsePhoneLiveAiPhase(rawPhase({ id: 'end', viewerDelta: -25, followerDelta: 0 }), endRequest), endRequest);
    assert.equal(state.ownLive.status, 'ended');
    assert.equal(state.ownLive.viewerCount, 0);
    assert.equal(state.ownLive.endedAt, 3000);
    assert.equal(state.ownLive.records.length, 1);
    assert.equal(state.ownLive.records[0].phases.length, 3);
    assert.equal('barrages' in state.ownLive.records[0].phases[0], false);
    assert.equal('gifts' in state.ownLive.records[0].phases[0], false);
});

test('phase parser rejects undersized generated barrage batches', () => {
    const broken = JSON.parse(rawPhase({ room: { title: '测试', summary: '测试', cover: '测试', initialViewers: 1 } }));
    broken.phase.barrages = broken.phase.barrages.slice(0, 7);
    assert.throws(
        () => parsePhoneLiveAiPhase(JSON.stringify(broken), { mode: 'start', operation: { title: '测试' } }),
        /8–20 条弹幕/,
    );
});

test('live request only includes selected bound role accounts and uses the selected live identity', () => {
    const settings = {
        phone: {
            profile: { nickname: '旧昵称' },
            weibo: {
                roleAccounts: [
                    { id: 'bound', nickname: '可参与', identity: { mode: 'custom', label: '角色', persona: '人设' } },
                    { id: 'unbound', nickname: '未绑定', identity: { mode: 'unbound' } },
                ],
            },
            live: {
                profile: { nickname: '直播昵称', bio: '直播简介', persona: '直播马甲人设' },
            },
        },
    };
    const request = buildPhoneLiveAiRequest(settings, { chatId: 'chat', chat: [] }, {
        type: 'start',
        participantIds: ['bound', 'unbound'],
    }, { now: 10 });
    assert.equal(request.profile.nickname, '直播昵称');
    assert.equal(request.userPersona, '直播马甲人设');
    assert.deepEqual(request.participants.map(item => item.id), ['bound']);
});

test('async live operation writes the generated phase into the current settings state', async () => {
    const settings = {
        apis: { barrage: { url: 'https://example.invalid', apiKey: 'test', model: 'test' } },
        phone: { live: {} },
    };
    await requestPhoneLiveOperation(settings, { chat: [] }, {
        type: 'start',
        sessionId: 'async-session',
        title: '异步测试',
        topic: '验证状态引用',
    }, {
        now: 5000,
        generateLive: async () => ({ content: rawPhase({
            room: { title: '异步测试', summary: '状态测试。', cover: '测试页', initialViewers: 5 },
            id: 'async-start',
        }) }),
    });
    assert.equal(settings.phone.live.ownLive.status, 'live');
    assert.equal(settings.phone.live.ownLive.sessionId, 'async-session');
    assert.equal(settings.phone.live.ownLive.phases.at(-1).id, 'async-start');
    assert.equal(settings.phone.live.ownLive.generating, false);
});
