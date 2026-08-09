import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PHONE_LIVE_CHANNELS,
    PHONE_LIVE_FORMATS,
    PHONE_LIVE_NATURES,
    advancePhoneLiveSceneIndex,
    normalizePhoneLiveState,
} from '../phone-live.js';

test('live app separates official broadcasts from private streams', () => {
    assert.deepEqual(PHONE_LIVE_CHANNELS.map(([, label]) => label), ['官方直播', '私人直播', '我的']);
    const settings = { phone: {} };
    const state = normalizePhoneLiveState(settings);
    const official = state.streams.filter(stream => stream.type === 'official');
    const privateStreams = state.streams.filter(stream => stream.type === 'private');
    assert.ok(official.length >= 2);
    assert.ok(privateStreams.length >= 2);
    assert.ok(state.streams.every(stream => stream.scene && stream.segment && stream.barrages.length >= 5 && stream.scenes.length >= 5));
    assert.ok(state.streams.every(stream => stream.scenes.every(scene => ['narration', 'dialogue'].includes(scene.kind) && scene.text && scene.segment)));
    assert.ok(official.every(stream => stream.scenes.filter(scene => scene.kind === 'narration').length >= stream.scenes.filter(scene => scene.kind === 'dialogue').length));
    assert.ok(privateStreams.every(stream => stream.scenes.filter(scene => scene.kind === 'dialogue').length > stream.scenes.filter(scene => scene.kind === 'narration').length));
    assert.ok(privateStreams.every(stream => Array.isArray(stream.chats)));
    assert.equal(state.ownLive.status, 'idle');
    assert.deepEqual(state.ownLive.phases, []);
    assert.deepEqual(state.ownLive.records, []);
    assert.ok(PHONE_LIVE_FORMATS.some(([id]) => id === 'gaming'));
    assert.deepEqual(PHONE_LIVE_NATURES.map(([, label]) => label), ['私人娱乐', '工作性质']);
});

test('live scene playback advances and loops back to the opening frame', () => {
    assert.equal(advancePhoneLiveSceneIndex(0, 6), 1);
    assert.equal(advancePhoneLiveSceneIndex(4, 6), 5);
    assert.equal(advancePhoneLiveSceneIndex(5, 6), 0);
    assert.equal(advancePhoneLiveSceneIndex(9, 0), 0);
});

test('live normalization preserves saved streams and removes duplicate follows', () => {
    const settings = {
        phone: {
            live: {
                streams: [{ id: 'saved-live', type: 'private', barrages: [] }],
                followedStreamIds: ['saved-live', 'saved-live'],
            },
        },
    };
    const state = normalizePhoneLiveState(settings);
    assert.equal(state.streams.length, 1);
    assert.equal(state.streams[0].id, 'saved-live');
    assert.equal(state.streams[0].type, 'private');
    assert.deepEqual(state.streams[0].barrages, []);
    assert.equal(state.streams[0].scenes.length, 1);
    assert.equal(state.streams[0].scenes[0].kind, 'narration');
    assert.deepEqual(state.followedStreamIds, ['saved-live']);
    assert.equal(state.ownLive.status, 'idle');
});

test('ended legacy own streams migrate into lightweight transcripts without barrage or gift data', () => {
    const settings = {
        phone: {
            live: {
                ownLive: {
                    status: 'ended',
                    sessionId: 'legacy-session',
                    title: '旧直播',
                    endedAt: 200,
                    phases: [{
                        id: 'legacy-phase',
                        summary: '结束了。',
                        scenes: [{ kind: 'dialogue', segment: '告别', speaker: '我', text: '晚安。' }],
                        barrages: [{ id: 'b1', author: '观众', content: '晚安' }],
                        gifts: [{ id: 'g1', label: '花' }],
                    }],
                },
            },
        },
    };
    const record = normalizePhoneLiveState(settings).ownLive.records[0];
    assert.equal(record.sessionId, 'legacy-session');
    assert.equal(record.phases[0].scenes[0].text, '晚安。');
    assert.equal('barrages' in record.phases[0], false);
    assert.equal('gifts' in record.phases[0], false);
});
