import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildCharacterBaselines,
    getDevelopmentBaselineSource,
    setDevelopmentBaselineSource,
} from '../character-baseline.js';

function makeContext(characterId, character) {
    return {
        characterId,
        characters: { [characterId]: character },
        saveSettingsDebounced() {},
    };
}

test('development baseline source is saved independently for each character card', () => {
    const settings = { development: { baselineSourcesByOwner: {} } };
    const first = makeContext(0, { name: '莉亚', avatar: 'liya.png' });
    const second = makeContext(1, { name: '艾尔诺', avatar: 'aiernuo.png' });

    setDevelopmentBaselineSource(settings, first, 'character');
    setDevelopmentBaselineSource(settings, second, 'worldbook');

    assert.equal(getDevelopmentBaselineSource(settings, first), 'character');
    assert.equal(getDevelopmentBaselineSource(settings, second), 'worldbook');
});

test('character-card baseline contains the actual starting description and personality', async () => {
    const settings = { development: { baselineSourcesByOwner: {} } };
    const context = makeContext(0, {
        name: '莉亚',
        avatar: 'liya.png',
        description: '她从不因平民身份而卑微。',
        personality: '平等地对待所有人，也始终保护艾尔诺。',
        scenario: '故事从王都开始。',
    });
    setDevelopmentBaselineSource(settings, context, 'character');

    const baseline = await buildCharacterBaselines(settings, context);
    assert.equal(baseline.known, true);
    assert.match(baseline.entries[0].text, /从不因平民身份而卑微/);
    assert.match(baseline.entries[0].text, /始终保护艾尔诺/);
});
