import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PHONE_APP_SHELLS } from '../phone-shell.js';

test('phone shell exposes a small removable app registry without story data', () => {
    assert.deepEqual(PHONE_APP_SHELLS.map(app => app.label), ['消息', '微博', '社区', '直播', '设置']);
    assert.equal(PHONE_APP_SHELLS.every(app => app.id && app.icon && app.tone), true);
});

test('floating panel provides a real phone page and keeps every top tab horizontal', async () => {
    const story = await readFile(new URL('../story-status.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(story, /data-story-view="phone">手机/);
    assert.match(story, /data-story-page="phone"/);
    assert.match(css, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
    assert.match(css, /\.memory-augment-phone-device/);
    assert.match(css, /\.memory-augment-phone-app-grid/);
});

test('phone shell delegates message data and API work to the message controller', async () => {
    const source = await readFile(new URL('../phone-shell.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /fetch\s*\(/);
    assert.doesNotMatch(source, /generatePhoneCompletion|loadPhoneStore|savePhoneStore/);
    assert.match(source, /createPhoneMessagesController/);
});

test('the empty phone list clearly asks for a SillyTavern character chat', async () => {
    const source = await readFile(new URL('../phone-messages.js', import.meta.url), 'utf8');
    assert.match(source, /请先在酒馆中打开一个角色卡聊天/);
    assert.match(source, /add\.disabled = !store\.chatId/);
});
