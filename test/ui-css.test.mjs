import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('a hidden map page cannot leak into the story status view', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const visibleRule = css.indexOf('#memory_augment_story_map_view {');
    const hiddenRule = css.indexOf('#memory_augment_story_map_view[hidden] {\n    display: none;');

    assert.ok(visibleRule >= 0);
    assert.ok(hiddenRule > visibleRule);
});

test('the barrage regeneration control is forced to remain horizontal', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const actionsRule = css.match(/\.memory-augment-barrage-actions\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const rule = css.match(/\.memory-augment-barrage-regenerate\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    assert.match(actionsRule, /justify-content:\s*center/);
    assert.match(actionsRule, /width:\s*100%/);
    assert.match(rule, /justify-content:\s*center/);
    assert.match(rule, /text-align:\s*center/);
    assert.match(rule, /white-space:\s*nowrap/);
    assert.match(rule, /writing-mode:\s*horizontal-tb/);
});
