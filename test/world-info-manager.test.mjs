import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getWorldInfoEntryKey,
    loadAssociatedWorldInfoBooks,
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
    const books = await loadAssociatedWorldInfoBooks(async () => rawEntries, {});
    assert.deepEqual(books.map(book => [book.id, book.entries.length]), [['Book A', 1], ['Book B', 1]]);
});

test('vectorization groups checked entries by book for isolated synchronization', async () => {
    const books = await loadAssociatedWorldInfoBooks(async () => rawEntries, {});
    const selectedKey = getWorldInfoEntryKey('Book B', 3);
    const settings = {
        apis: {
            embedding: { url: 'https://embedding.example/v1/', apiKey: 'key', model: 'model' },
        },
        rag: { semanticWorldInfoEntries: [selectedKey] },
    };
    const context = { chatId: 'chat-1' };
    const payloads = [];
    const result = await vectorizeSelectedWorldInfo(settings, context, books, async (value) => {
        payloads.push(value);
        return { entries: value.entries.length, chunks: value.entries.length, embedded: value.entries.length };
    });

    assert.equal(result.entries, 1);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].book_id, 'Book A');
    assert.deepEqual(payloads[0].entries, []);
    assert.equal(payloads[1].book_id, 'Book B');
    assert.equal(payloads[1].embedding.baseUrl, 'https://embedding.example');
    assert.deepEqual(payloads[1].entries.map(entry => ({
        entry_uid: entry.entry_uid,
        entry_key: entry.entry_key,
        text: entry.text,
    })), [{
        entry_uid: '3',
        entry_key: 'moon gate',
        text: 'The silver arch opens under starlight.',
    }]);
    assert.match(payloads[1].entries[0].content_hash, /^[a-f0-9]{8}$/);
});
