import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    findLatestPhoneStoryMessageId,
    formatPhoneClockMinutes,
    getPhoneWorldStatusPresentation,
    parsePhoneClockMinutes,
    PHONE_APP_SHELLS,
} from '../phone-shell.js';

test('phone shell exposes a small removable app registry without story data', () => {
    assert.deepEqual(PHONE_APP_SHELLS.map(app => app.label), ['消息', '微博', '社区', '直播', '设置']);
    assert.equal(PHONE_APP_SHELLS.every(app => app.id && app.icon && app.tone), true);
    assert.deepEqual(Object.fromEntries(PHONE_APP_SHELLS.map(app => [app.id, app.icon])), {
        messages: 'fa-comments',
        weibo: 'fa-fire',
        community: 'fa-people-group',
        live: 'fa-video',
        settings: 'fa-gear',
    });
});

test('phone home keeps the KK PHONE watermark and reports real world-update modules', async () => {
    const source = await readFile(new URL('../phone-shell.js', import.meta.url), 'utf8');
    assert.match(source, /<span>KK PHONE<\/span>/);
    assert.doesNotMatch(source, />娱乐圈</);
    assert.deepEqual(getPhoneWorldStatusPresentation({ status: 'generating' }), {
        state: 'generating', icon: 'fa-spinner', text: '手机内容更新中…',
    });
    assert.equal(getPhoneWorldStatusPresentation({
        status: 'ready', modules: ['messages', 'weibo', 'messages'],
    }).text, '有新的消息 · 微博有新内容');
    assert.deepEqual(getPhoneWorldStatusPresentation({
        status: 'ready', modules: ['weibo'], dismissed: true,
    }), { state: 'idle', icon: '', text: '' });
    assert.deepEqual(getPhoneWorldStatusPresentation({ status: 'idle' }), {
        state: 'idle', icon: '', text: '',
    });
    assert.equal(getPhoneWorldStatusPresentation({
        status: 'error', lastError: '社区模块没有返回内容。',
    }).text, '手机更新失败：社区模块没有返回内容。');
    assert.match(source, /memory-augment-phone-device'\)\?\.addEventListener\('click'/);
    assert.match(source, /currentStore\.worldGeneration\.dismissed = true/);
    assert.match(source, /if \(!getPhoneChatId\(getCurrentContext\(\)\)\)/);
    assert.match(source, /lastError: error\?\.message/);
    assert.match(source, /textContent = '重试'/);
    assert.match(source, /textContent = '忽略'/);
    assert.match(source, /data-phone-world-regenerate/);
    assert.match(source, /<span>接收消息<\/span>/);
    assert.doesNotMatch(source, />重新生成<\/span>/);
    assert.match(source, /requestPhoneWorldStoryUpdate\(phoneSession, current, messageId, \{ force: true \}\)/);
    assert.match(source, /上一次手机更新已中断，可以重新尝试/);
});

test('manual phone regeneration targets the newest usable assistant story floor', () => {
    assert.equal(findLatestPhoneStoryMessageId({
        chat: [
            { is_user: false, mes: '第一段正文' },
            { is_user: true, mes: '继续' },
            { is_user: false, mes: '' },
            { is_user: false, mes: '最新正文' },
            { is_user: true, mes: '最新回复' },
        ],
    }), 3);
    assert.equal(findLatestPhoneStoryMessageId({ chat: [{ is_user: true, mes: '只有玩家消息' }] }), null);
});

test('phone clock reads the saved story time without waiting for the next status request', () => {
    assert.equal(parsePhoneClockMinutes('2026年8月11日 星期二 23:58'), 23 * 60 + 58);
    assert.equal(parsePhoneClockMinutes('王历100年春月三日 7时05分'), 7 * 60 + 5);
    assert.equal(parsePhoneClockMinutes('时间未明确'), null);
    assert.equal(formatPhoneClockMinutes(23 * 60 + 59 + 2), '00:01');
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
    assert.match(source, /createPhoneWeiboController/);
    assert.match(source, /createPhoneCommunityController/);
    assert.match(source, /createPhoneLiveController/);
    assert.match(source, /createPhoneSettingsController/);
    assert.match(source, /syncPhoneAccountProfiles/);
    assert.match(source, /runtime\.powerUser/);
    assert.match(source, /appControllers\[activeApp\]\?\.close\?\.\(\)/);
    assert.match(source, /CHAT_CHANGED/);
    assert.match(source, /phoneSession\.invalidate\(\)/);
    assert.match(source, /appControllers\[activeApp\]\?\.open\?\.\(content\)/);
});

test('the empty phone list stays concise when no character chat is open', async () => {
    const source = await readFile(new URL('../phone-messages.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /请先在酒馆中打开一个角色卡聊天/);
    assert.match(source, /add\.disabled = !store\.chatId/);
});

test('phone story context is cleared on failed, stopped, and abandoned generations', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(source, /GENERATION_STOPPED/);
    assert.match(source, /GENERATION_ENDED/);
    assert.match(source, /CHAT_CHANGED/);
    assert.match(source, /clearPreparedPhoneContext/);
    assert.doesNotMatch(source, /setTimeout\(\(\) => \{\s*void consumePreparedPhoneContext/);
});
