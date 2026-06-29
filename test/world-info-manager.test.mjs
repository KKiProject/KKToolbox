import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getWorldInfoEntryKey,
    loadAssociatedWorldInfoEntries,
    normalizeWorldInfoEntries,
    vectorizeSelectedWorldInfo,
} from '../world-info-manager.js';

const rawEntries = [
    {
        world: 'Book A',
        uid: 1,
        comment: 'Hidden City',
        key: ['secret-name'],
        content: 'A city exists above the clouds.',
        disable: false,
    },
    {
        world: 'Book A',
        uid: 2,
        comment: 'Disabled Entry',
        content: 'Do not index this.',
        disable: true,
    },
    {
        world: 'Book B',
        uid: 3,
        comment: '',
        key: ['moon gate'],
        content: 'The silver arch opens under starlight.',
    },
];

test('normalizes only enabled entries without modifying native trigger fields', async () => {
    const snapshot = structuredClone(rawEntries);
    const entries = normalizeWorldInfoEntries(rawEntries);
    const loaded = await loadAssociatedWorldInfoEntries(async () => rawEntries);

    assert.equal(entries.length, 2);
    assert.deepEqual(loaded, entries);
    assert.equal(entries[0].key, getWorldInfoEntryKey('Book A', 1));
    assert.equal(entries[0].name, 'Hidden City');
    assert.equal(entries[1].name, 'moon gate');
    assert.deepEqual(rawEntries, snapshot, 'native keyword and disable fields must remain untouched');
});

test('vectorization sends only checked entries to /embed payload', async () => {
    const entries = normalizeWorldInfoEntries(rawEntries);
    const selectedKey = getWorldInfoEntryKey('Book B', 3);
    const settings = {
        apis: {
            embedding: { url: 'https://embedding.example/v1/', apiKey: 'key', model: 'model' },
        },
        rag: { semanticWorldInfoEntries: [selectedKey] },
    };
    const context = { chatId: 'chat-1' };
    let payload;
    const result = await vectorizeSelectedWorldInfo(settings, context, entries, async (value) => {
        payload = value;
        return { stored: value.worldInfoEntries.length };
    });

    assert.equal(result.stored, 1);
    assert.equal(payload.embedding.baseUrl, 'https://embedding.example');
    assert.deepEqual(payload.input, ['The silver arch opens under starlight.']);
    assert.deepEqual(payload.worldInfoEntries, [{
        id: '3',
        name: 'moon gate',
        world: 'Book B',
        text: 'The silver arch opens under starlight.',
    }]);
});
