import test from 'node:test';
import assert from 'node:assert/strict';
import { PHONE_LIVE_CHANNELS, normalizePhoneLiveState } from '../phone-live.js';

test('live app separates official broadcasts from private streams', () => {
    assert.deepEqual(PHONE_LIVE_CHANNELS.map(([, label]) => label), ['官方直播', '私人直播']);
    const settings = { phone: {} };
    const state = normalizePhoneLiveState(settings);
    const official = state.streams.filter(stream => stream.type === 'official');
    const privateStreams = state.streams.filter(stream => stream.type === 'private');
    assert.ok(official.length >= 2);
    assert.ok(privateStreams.length >= 2);
    assert.ok(state.streams.every(stream => stream.scene && stream.segment && stream.barrages.length >= 5));
    assert.ok(privateStreams.every(stream => Array.isArray(stream.chats)));
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
    assert.deepEqual(state.streams, [{ id: 'saved-live', type: 'private', barrages: [] }]);
    assert.deepEqual(state.followedStreamIds, ['saved-live']);
});
