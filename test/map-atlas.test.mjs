import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildRelevantMapText,
    getMapOwnerKey,
    injectMapAtlasContext,
    isMapEntryCandidate,
    normalizeMapAtlas,
    parseMapAtlasResponse,
    selectMapSourceBooks,
} from '../map-atlas.js';

function atlasFixture() {
    return {
        title: '北境地图册',
        rootPageId: 'north',
        pages: [
            {
                id: 'north',
                name: '北境',
                nodes: [
                    { id: 'silverpine', name: '银松城', type: '城市', note: '又称北境明珠', childPageId: 'silverpine-city' },
                    { id: 'frostpass', name: '霜隘', type: '关隘', note: '通往王都的山口' },
                ],
                edges: [
                    { from: 'silverpine', to: 'frostpass', label: '北境大道' },
                    { from: 'missing', to: 'silverpine', label: '无效连接' },
                ],
            },
            {
                id: 'silverpine-city',
                name: '银松城内',
                nodes: [
                    { id: 'palace', name: '雪松宫', type: '设施', note: '领主居所' },
                    { id: 'guild', name: '冒险者公会', type: '设施', note: '接受委托' },
                ],
                edges: [],
            },
        ],
    };
}

test('atlas parser keeps hierarchy, assigns positions, and removes invalid edges', () => {
    const atlas = parseMapAtlasResponse(`\`\`\`json\n${JSON.stringify(atlasFixture())}\n\`\`\``);
    assert.equal(atlas.rootPageId, 'north');
    assert.equal(atlas.pages[0].edges.length, 1);
    assert.equal(atlas.pages[0].nodes[0].childPageId, 'silverpine-city');
    assert.equal(Number.isFinite(atlas.pages[0].nodes[0].x), true);
    assert.equal(Number.isFinite(atlas.pages[0].nodes[0].y), true);
});

test('relevant map text contains the current node, direct route, and city facilities', () => {
    const text = buildRelevantMapText(atlasFixture(), '北境 → 银松城 → 鹿角酒馆');
    assert.match(text, /当前地点：银松城/);
    assert.match(text, /霜隘（北境大道）/);
    assert.match(text, /雪松宫/);
    assert.match(text, /冒险者公会/);
});

test('map atlas is scoped to the character and injected before the latest user message', () => {
    const character = { avatar: 'hero.png', name: 'Hero' };
    const persistentChat = [
        { mes: '开场', is_user: false },
        { mes: '去银松城', is_user: true },
        { mes: '抵达银松城', is_user: false },
        { mes: '看看附近', is_user: true },
    ];
    const key = 'character:hero.png';
    const settings = {
        map: { includeInPrompt: true, atlases: { [key]: normalizeMapAtlas(atlasFixture()) } },
    };
    const context = { characterId: 0, characters: [character], chat: persistentChat, chatMetadata: {} };
    const generationChat = structuredClone(persistentChat);

    assert.equal(getMapOwnerKey(context), key);
    assert.equal(injectMapAtlasContext(generationChat, settings, context), true);
    assert.equal(generationChat[3].extra.memory_augment_map_atlas, true);
    assert.equal(generationChat[4].mes, '看看附近');
});

test('automatic map source detection only looks for 地图 in the entry title', () => {
    assert.equal(isMapEntryCandidate({ name: '北境地图', entryKey: '地理' }), true);
    assert.equal(isMapEntryCandidate({ name: '王都', entryKey: '城市', content: '附有一张完整地图' }), false);
    assert.equal(isMapEntryCandidate({ name: '王都', entryKey: '地图' }), false);
});

test('map generation source contains only explicitly selected entries', () => {
    const books = [{
        id: 'world',
        name: '庞大世界书',
        entries: [
            { key: 'world::1', name: '世界地图', content: '地图内容' },
            { key: 'world::2', name: '人物设定', content: '绝不能发送' },
        ],
    }];
    const selected = selectMapSourceBooks(books, new Set(['world::1']));
    assert.equal(selected.length, 1);
    assert.deepEqual(selected[0].entries.map(entry => entry.key), ['world::1']);
    assert.equal(books[0].entries.length, 2);
});
