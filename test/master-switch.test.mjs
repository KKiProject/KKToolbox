import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { bindMasterSwitch } from '../master-switch.js';
import { memoryAugmentInterceptor } from '../context-manager.js';

function controls(settings, save, reload) {
    const input = { addEventListener: (_, handler) => input.change = handler };
    const status = {};
    const action = { id: 'memory_augment_regenerate_summaries' };
    const addField = { id: 'memory_augment_add_status_custom_field' };
    const features = { querySelectorAll: () => [action, addField] };
    const nodes = {
        '#memory_augment_enabled': input,
        '#memory_augment_enabled_status': status,
        '#memory_augment_feature_settings': features,
    };
    bindMasterSwitch(settings, { documentRef: { querySelector: id => nodes[id] }, save, reload });
    return { input, status, features, action, addField };
}

test('master switch preserves feature preferences and waits for saving before reload', async () => {
    const settings = { barrage: { enabled: true }, phone: { maxTokens: 2048 } };
    const originalFeatures = structuredClone(settings);
    let finishSave;
    let reloads = 0;
    const { input, features } = controls(settings,
        () => new Promise(resolve => finishSave = resolve), () => reloads++);
    assert.equal(input.checked, true);
    assert.equal(features.hidden, false);
    input.checked = false;
    const pending = input.change();
    assert.equal(settings.enabled, false);
    assert.equal(input.disabled, true);
    assert.equal(reloads, 0);
    finishSave({ result: 'ok' });
    await pending;
    assert.equal(reloads, 1);
    assert.deepEqual(settings.barrage, originalFeatures.barrage);
    assert.deepEqual(settings.phone, originalFeatures.phone);
});

test('disabled settings stay visible, disable execution buttons and retain re-enable control', async () => {
    const settings = { enabled: false };
    let reloaded = false;
    const { input, features, action, addField } = controls(settings, async () => ({ result: 'ok' }), () => reloaded = true);
    assert.equal(features.hidden, false);
    assert.equal(action.disabled, true);
    assert.notEqual(addField.disabled, true);
    assert.equal(input.checked, false);
    input.checked = true;
    await input.change();
    assert.equal(settings.enabled, true);
    assert.equal(reloaded, true);
});

test('failed or deferred saves restore the switch without reloading', async () => {
    for (const save of [async () => { throw new Error('offline'); }, async () => undefined, async () => ({ error: 'disk full' })]) {
        const settings = { enabled: true };
        const { input, status } = controls(settings, save, () => assert.fail('must not reload'));
        input.checked = false;
        await input.change();
        assert.equal(settings.enabled, true);
        assert.equal(input.checked, true);
        assert.equal(input.disabled, false);
        assert.match(status.textContent, /切换未生效/);
    }
});

test('disabled generation interceptor neither sends requests nor changes prompt messages', async t => {
    const previousContext = globalThis.SillyTavern;
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.SillyTavern = previousContext; globalThis.fetch = previousFetch; });
    globalThis.fetch = () => assert.fail('disabled plugin must not request');
    globalThis.SillyTavern = { getContext: () => ({ extensionSettings: { 'st-memory-augment': { enabled: false } } }) };
    const chat = [{ mes: '正文', extra: { preserved: true } }];
    const before = structuredClone(chat);
    await memoryAugmentInterceptor(chat, 4096, () => assert.fail('must not abort main generation'), 'normal');
    assert.deepEqual(chat, before);
});

test('disabled startup loads editable settings but never starts features or generates on edits', async () => {
    let source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    source = source.replace(/^import[\s\S]*?;\r?$/gm, '')
        .replace(/\bexport /g, '')
        .replaceAll('import.meta.url', JSON.stringify('https://example.test/KKToolbox/index.js'));
    let initialize;
    let bound = false;
    let saves = 0;
    const inputs = ['barrage.enabled', 'status.enabled', 'development.enabled', 'customPanel.enabled',
        'customPanel.choicesEnabled', 'customPanel.customContentEnabled', 'customPanel.prompt',
        'htmlRenderer.enabled', 'apis.barrage.model', 'barrage.maxTokens'].map(path => ({
        dataset: { setting: path },
        type: path.endsWith('enabled') || path.endsWith('Enabled') ? 'checkbox' : path.endsWith('maxTokens') ? 'number' : 'text',
        handlers: {},
        addEventListener(event, callback) { this.handlers[event] = callback; },
    }));
    const sandbox = {
        URL, console,
        extension_settings: { 'st-memory-augment': { enabled: false } },
        SillyTavern: { getContext: () => ({ saveSettingsDebounced() { saves++; } }) },
        document: {
            querySelector: id => id === '#memory_augment_settings' ? {} : null,
            querySelectorAll: () => inputs,
        },
        memoryAugmentInterceptor,
        saveSettings() {},
        bindMasterSwitch: settings => { assert.equal(settings.enabled, false); bound = true; },
        jQuery: callback => initialize = callback,
    };
    // Feature entry points are intentionally absent: any attempted startup fails.
    vm.runInNewContext(source, sandbox);
    await initialize();
    assert.equal(bound, true);
    assert.equal(inputs.at(-1).value, '8064');
    const before = saves;
    for (const input of inputs) {
        input.checked = true;
        input.value = input.type === 'number' ? '9000' : '新的设置';
        input.handlers.input();
        input.handlers.change?.();
    }
    assert.equal(saves, before + inputs.length);
    const settings = sandbox.extension_settings['st-memory-augment'];
    assert.equal(settings.enabled, false);
    assert.equal(settings.barrage.enabled, true);
    assert.equal(settings.customPanel.prompt, '新的设置');
    assert.equal(settings.apis.barrage.model, '新的设置');
    assert.equal(settings.barrage.maxTokens, 9000);
});
