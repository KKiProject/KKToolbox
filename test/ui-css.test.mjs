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
    const panelRule = css.match(/\.memory-augment-barrage\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const actionsRule = css.match(/\.memory-augment-barrage-actions\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const rule = css.match(/\.memory-augment-barrage-regenerate\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    assert.match(panelRule, /box-sizing:\s*border-box/);
    assert.match(panelRule, /max-width:\s*100%/);
    assert.match(panelRule, /width:\s*100%/);
    assert.match(actionsRule, /justify-content:\s*center/);
    assert.match(actionsRule, /width:\s*100%/);
    assert.match(rule, /justify-content:\s*center/);
    assert.match(rule, /text-align:\s*center/);
    assert.match(rule, /white-space:\s*nowrap/);
    assert.match(rule, /writing-mode:\s*horizontal-tb/);
});

test('the story status regeneration control remains horizontal', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const rule = css.match(/#memory_augment_story_status_regenerate\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    assert.match(rule, /display:\s*inline-flex/);
    assert.match(rule, /white-space:\s*nowrap/);
    assert.match(rule, /writing-mode:\s*horizontal-tb/);
});

test('the floating story launcher cannot be hidden behind mobile themes', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const rootRule = css.match(/#memory_augment_story_status_root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const ballRule = css.match(/#memory_augment_story_status_ball\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    assert.match(rootRule, /display:\s*block\s*!important/);
    assert.match(rootRule, /position:\s*fixed\s*!important/);
    assert.match(rootRule, /visibility:\s*visible\s*!important/);
    assert.match(rootRule, /z-index:\s*2147483000/);
    assert.match(ballRule, /display:\s*flex\s*!important/);
});

test('the per-character card type control lives in character development instead of global settings', async () => {
    const settings = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
    const development = await readFile(new URL('../character-development.js', import.meta.url), 'utf8');
    assert.doesNotMatch(settings, /memory_augment_development_baseline_source/);
    assert.match(development, /memory_augment_development_baseline_source/);
    assert.match(development, /当前角色卡的人物设定/);
    assert.match(development, /单人角色卡/);
    assert.match(development, /世界／群像卡/);
});

test('all KKToolbox menu buttons are globally protected from vertical Chinese text', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const rule = css.match(/\.memory-augment-settings \.menu_button,[\s\S]*?\.memory-augment-popup \.menu_button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    assert.match(rule, /flex-shrink:\s*0\s*!important/);
    assert.match(rule, /min-inline-size:\s*max-content\s*!important/);
    assert.match(rule, /white-space:\s*nowrap\s*!important/);
    assert.match(rule, /word-break:\s*keep-all\s*!important/);
    assert.match(rule, /writing-mode:\s*horizontal-tb\s*!important/);
});
