import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyCharacterDevelopmentUpdate,
    discardDevelopmentCandidate,
    formatCharacterDevelopmentMessage,
    getCharacterDevelopmentSnapshot,
    injectCharacterDevelopment,
    normalizeDevelopmentUpdate,
    setManualDevelopmentField,
} from '../character-development.js';

function makeContext(length = 20) {
    return {
        chat: Array.from({ length }, (_, id) => ({
            name: id % 2 ? '玩家' : '莉亚',
            is_user: id % 2 === 1,
            is_system: false,
            mes: `第${id}楼原文`,
        })),
        chatMetadata: {},
        extensionSettings: { 'st-memory-augment': { development: { enabled: true } } },
    };
}

function change(overrides = {}) {
    return {
        character: '莉亚',
        dimension: 'temperament',
        target: '',
        before: '开朗外向',
        after: '变得阴郁寡言，并习惯隐藏真实情绪',
        reason: '',
        source: 'observed',
        evidence: [],
        ...overrides,
    };
}

test('development parser accepts only supported durable dimensions', () => {
    const parsed = normalizeDevelopmentUpdate({ changes: [
        change({ dimension: '性格倾向' }),
        change({ dimension: '当前心情' }),
    ] });
    assert.equal(parsed.changes.length, 1);
    assert.equal(parsed.changes[0].dimension, 'temperament');
});

test('an explicit user setting immediately overrides the initial character card without inventing a cause', () => {
    const context = makeContext(4);
    context.chat[1].mes = '十年后，莉亚早已不再开朗，变得阴郁寡言。';
    const result = applyCharacterDevelopmentUpdate(context, 2, { changes: [change({
        source: 'user_direct',
        reason: '',
        evidence: [{ messageId: 1, quote: '十年后，莉亚早已不再开朗，变得阴郁寡言。' }],
    })] }, {
        status: { characters: [{ name: '玩家', role: 'user' }] },
        sourceHash: 'source',
    });

    assert.equal(result.confirmed, 1);
    const snapshot = getCharacterDevelopmentSnapshot(context);
    assert.equal(snapshot.profiles[0].fields[0].source, 'user_direct');
    assert.equal(snapshot.profiles[0].fields[0].reason, '');
    assert.match(formatCharacterDevelopmentMessage(context).mes, /角色卡是故事开始前的基础设定/);
    assert.match(formatCharacterDevelopmentMessage(context).mes, /变得阴郁寡言/);
});

test('a claimed direct setting is rejected unless its quote exists in a user floor', () => {
    const context = makeContext(4);
    const result = applyCharacterDevelopmentUpdate(context, 2, { changes: [change({
        source: 'user_direct',
        evidence: [{ messageId: 1, quote: '用户根本没有写过的句子' }],
    })] });
    assert.deepEqual(result, { confirmed: 0, observed: 0, rejected: 1 });
    assert.equal(getCharacterDevelopmentSnapshot(context).profiles.length, 0);
});

test('ordinary observations stay private until repeated across separate situations over time', () => {
    const context = makeContext(20);
    for (const id of [2, 8, 14]) context.chat[id].mes = '莉亚再次用沉默掩饰了自己的真实想法。';
    const observe = (ownerMessageId, evidenceId, activity) => applyCharacterDevelopmentUpdate(context, ownerMessageId, {
        changes: [change({
            evidence: [{ messageId: evidenceId, quote: '莉亚再次用沉默掩饰了自己的真实想法。' }],
        })],
    }, {
        status: {
            environment: { location: `地点${activity}` },
            characters: [{ name: '玩家', role: 'user' }],
            event: { activity },
        },
        timeline: { sceneAnchorId: `anchor-${activity}` },
    });

    observe(2, 2, '事件一');
    observe(8, 8, '事件二');
    assert.equal(getCharacterDevelopmentSnapshot(context).profiles.length, 0);
    assert.equal(getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates.length, 1);
    assert.equal(formatCharacterDevelopmentMessage(context), null, 'candidates must never enter the main prompt');

    const final = observe(14, 14, '事件三');
    assert.equal(final.confirmed, 1);
    assert.equal(getCharacterDevelopmentSnapshot(context).profiles.length, 1);
});

test('semantically equivalent wording accumulates into one lasting change', () => {
    const context = makeContext(20);
    const observations = [
        [2, '莉亚今天显得脾气暴躁。', '脾气暴躁'],
        [8, '莉亚的脾气比过去火爆许多。', '脾气比过去火爆'],
        [14, '莉亚越来越容易动怒。', '越来越容易动怒'],
    ];
    let result;
    for (const [id, quote, after] of observations) {
        context.chat[id].mes = quote;
        result = applyCharacterDevelopmentUpdate(context, id, { changes: [change({
            after,
            evidence: [{ messageId: id, quote }],
        })] }, {
            status: { event: { activity: `事件${id}` }, characters: [{ name: '玩家', role: 'user' }] },
            timeline: { sceneAnchorId: `scene-${id}` },
        });
    }

    assert.equal(result.confirmed, 1);
    assert.equal(getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates.length, 0);
    assert.match(getCharacterDevelopmentSnapshot(context).profiles[0].fields[0].value, /动怒|火爆|暴躁/);
});

test('opposite personality directions are never merged merely because they share a field', () => {
    const context = makeContext(10);
    context.chat[2].mes = '莉亚待人越来越温和。';
    context.chat[4].mes = '莉亚在压力下变得十分暴躁。';
    applyCharacterDevelopmentUpdate(context, 2, { changes: [change({
        after: '待人越来越温和',
        evidence: [{ messageId: 2, quote: '莉亚待人越来越温和。' }],
    })] }, { status: { event: { activity: '休息' } } });
    applyCharacterDevelopmentUpdate(context, 4, { changes: [change({
        after: '在压力下变得十分暴躁',
        evidence: [{ messageId: 4, quote: '莉亚在压力下变得十分暴躁。' }],
    })] }, { status: { event: { activity: '争执' } } });

    assert.equal(getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates.length, 2);
});

test('the side API can explicitly attach different wording to an existing candidate id', () => {
    const context = makeContext(12);
    context.chat[2].mes = '莉亚开始回避任何亲密接触。';
    context.chat[8].mes = '莉亚不再愿意让别人真正靠近自己。';
    applyCharacterDevelopmentUpdate(context, 2, { changes: [change({
        trend: '回避亲密',
        after: '开始回避任何亲密接触',
        evidence: [{ messageId: 2, quote: '莉亚开始回避任何亲密接触。' }],
    })] }, { status: { event: { activity: '初次冲突' } } });
    const candidateId = getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates[0].id;
    applyCharacterDevelopmentUpdate(context, 8, { changes: [change({
        candidateId,
        trend: '回避亲密',
        after: '不再愿意让别人真正靠近自己',
        evidence: [{ messageId: 8, quote: '莉亚不再愿意让别人真正靠近自己。' }],
    })] }, { status: { event: { activity: '再次冲突' } } });

    const candidates = getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].evidence.length, 2);
});

test('side API merge suggestions consolidate old candidates while preserving their evidence', () => {
    const context = makeContext(12);
    context.chat[2].mes = '莉亚拒绝让别人触碰自己。';
    context.chat[4].mes = '莉亚总会避开他人的拥抱。';
    applyCharacterDevelopmentUpdate(context, 2, { changes: [change({
        after: '拒绝让别人触碰自己',
        evidence: [{ messageId: 2, quote: '莉亚拒绝让别人触碰自己。' }],
    })] }, { status: { event: { activity: '触碰' } } });
    applyCharacterDevelopmentUpdate(context, 4, { changes: [change({
        after: '总会避开他人的拥抱',
        evidence: [{ messageId: 4, quote: '莉亚总会避开他人的拥抱。' }],
    })] }, { status: { event: { activity: '拥抱' } } });
    const before = getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates;
    assert.equal(before.length, 2);

    applyCharacterDevelopmentUpdate(context, 6, {
        changes: [],
        merges: [{
            intoId: before[0].id,
            fromIds: [before[1].id],
            trend: '回避身体亲密',
            after: '持续回避他人的身体接触',
        }],
    });

    const after = getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates;
    assert.equal(after.length, 1);
    assert.equal(after[0].trend, '回避身体亲密');
    assert.equal(after[0].evidence.length, 2);
});

test('legacy detailed candidate backlog is consolidated during migration', () => {
    const context = makeContext(120);
    const candidates = {};
    const variants = ['今天显得脾气暴躁', '脾气比以前火爆', '越来越容易动怒'];
    for (let index = 0; index < 60; index++) {
        candidates[`legacy-${index}`] = {
            id: `legacy-${index}`,
            character: '莉亚',
            dimension: 'temperament',
            target: '',
            before: '从前较为平和',
            after: `${variants[index % variants.length]}，这是第${index}次非常详细的描述`,
            reason: '',
            evidence: [{ messageId: index + 2, quote: `证据${index}` }],
            sceneKeys: [`scene-${index}`],
            firstSeenMessageId: index + 2,
            lastSeenMessageId: index + 2,
        };
    }
    context.chatMetadata.memory_augment_character_development = {
        version: 1,
        profiles: {},
        candidates,
        processed: {},
        dismissed: {},
    };

    const snapshot = getCharacterDevelopmentSnapshot(context, { includeCandidates: true });
    assert.equal(snapshot.candidates.length, 0);
    assert.equal(snapshot.profiles.length, 1, 'the merged backlog already satisfies the original confirmation threshold');
    assert.match(snapshot.profiles[0].fields[0].value, /动怒|火爆|暴躁/);
    assert.equal(context.chatMetadata.memory_augment_character_development.version, 2);
});

test('the plugin never infers a player character personality change from observed behavior', () => {
    const context = makeContext(5);
    context.chat[3].mes = '玩家这次选择了沉默。';
    const result = applyCharacterDevelopmentUpdate(context, 4, { changes: [change({
        character: '玩家',
        after: '变得沉默寡言',
        evidence: [{ messageId: 3, quote: '玩家这次选择了沉默。' }],
    })] }, { status: { characters: [{ name: '玩家', role: 'user' }] } });
    assert.equal(result.rejected, 1);
    assert.equal(getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates.length, 0);
});

test('discarding an observation prevents the same unwanted proposal from returning', () => {
    const context = makeContext(6);
    context.chat[2].mes = '莉亚短暂地保持沉默。';
    const update = { changes: [change({
        after: '变得沉默寡言',
        evidence: [{ messageId: 2, quote: '莉亚短暂地保持沉默。' }],
    })] };
    applyCharacterDevelopmentUpdate(context, 2, update, {
        status: { event: { activity: '谈话' } },
    });
    const candidate = getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates[0];
    assert.equal(discardDevelopmentCandidate(context, candidate.id), true);
    applyCharacterDevelopmentUpdate(context, 4, update, {
        status: { event: { activity: '另一场谈话' } },
    });
    assert.equal(getCharacterDevelopmentSnapshot(context, { includeCandidates: true }).candidates.length, 0);
});

test('manual changes are injected before the latest user message and remain editable', () => {
    const context = makeContext(4);
    assert.equal(setManualDevelopmentField(context, {
        character: '莉亚',
        dimension: 'relationship',
        target: '玩家',
        value: '已经愿意把后背交给玩家',
    }), true);
    const generationChat = structuredClone(context.chat);
    assert.equal(injectCharacterDevelopment(generationChat, context), true);
    assert.equal(generationChat.at(-2).extra.memory_augment_character_development, true);
    assert.match(generationChat.at(-2).mes, /已经愿意把后背交给玩家/);
    assert.equal(generationChat.at(-1).is_user, true);
});
