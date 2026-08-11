import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
    CUSTOM_PANEL_METADATA_KEY,
    fillStoryChoiceIntoComposer,
    handleCustomPanelGeneration,
    parseCustomPanelResponse,
    stripCustomPanelCodeFence,
} from '../custom-panel.js';

function createSettings() {
    return {
        apis: {
            barrage: { url: 'https://side.example/v1', apiKey: 'secret', model: 'model' },
        },
        customPanel: {
            enabled: true,
            choicesEnabled: true,
            customContentEnabled: true,
            title: '剧情仪表盘',
            prompt: '生成一张剧情仪表盘。',
            recentMessages: 2,
            maxTokens: 2048,
            renderHtml: true,
        },
    };
}

function createContext() {
    let saves = 0;
    const context = {
        chatId: 'custom-panel-chat',
        chatMetadata: {},
        chat: [
            { is_user: true, is_system: false, name: '玩家', mes: '先去推门。' },
            { is_user: false, is_system: false, name: '角色', mes: '门后是花园。' },
            { is_user: true, is_system: false, name: '玩家', mes: '走进去。' },
            {
                is_user: false,
                is_system: false,
                name: '角色',
                mes: '第一个回复',
                swipes: ['第一个回复', '第二个回复'],
                swipe_id: 0,
            },
        ],
        async saveMetadata() { saves++; },
        get saves() { return saves; },
    };
    return context;
}

test('custom panel strips optional HTML fences without changing plain output', () => {
    assert.equal(stripCustomPanelCodeFence('```html\n<div>仪表盘</div>\n```'), '<div>仪表盘</div>');
    assert.equal(stripCustomPanelCodeFence('纯文本内容'), '纯文本内容');
});

test('custom panel parses the four fixed moral routes separately from custom HTML', () => {
    const parsed = parseCustomPanelResponse([
        'KK_CHOICES_JSON={"choices":[{"tone":"善良","text":"“我来帮你。”我伸出手。"},{"tone":"邪恶","text":"“求我。”我故意后退一步。"},{"tone":"中立","text":"“先说条件。”我停在原地。"},{"tone":"沙雕","text":"“先拜个早年？”我一本正经地拱手。"}]}',
        '<div>剧情卡片</div>',
    ].join('\n'), { choicesEnabled: true, customContentEnabled: true });
    assert.deepEqual(parsed.choices.map(choice => choice.tone), ['善良', '邪恶', '中立', '沙雕']);
    assert.match(parsed.choices[0].text, /我来帮你/);
    assert.equal(parsed.content, '<div>剧情卡片</div>');
});

test('clicking a story choice inserts it at the composer cursor without sending', () => {
    const events = [];
    const textarea = {
        value: '我先想想。',
        selectionStart: 6,
        selectionEnd: 6,
        dispatchEvent: event => events.push(event.type),
        focus() {},
        setSelectionRange(start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        },
    };
    const documentRef = {
        querySelector: selector => selector === '#send_textarea' ? textarea : null,
        defaultView: { Event },
    };
    assert.equal(fillStoryChoiceIntoComposer('“让我来。”我卷起袖口。', documentRef), true);
    assert.match(textarea.value, /我先想想。\n“让我来。”/);
    assert.deepEqual(events, ['input']);
});

test('custom panel calls its own generator and stores each swipe independently', async () => {
    const settings = createSettings();
    const context = createContext();
    const requests = [];
    const renders = [];
    const dependencies = {
        getCurrentContext: () => context,
        render: (messageId, content, state) => {
            renders.push({ messageId, content, state });
            return true;
        },
        generate: async (payload) => {
            requests.push(payload);
            return { content: `KK_CHOICES_JSON={"choices":[{"tone":"善良","text":"善良选项"},{"tone":"邪恶","text":"邪恶选项"},{"tone":"中立","text":"中立选项"},{"tone":"沙雕","text":"沙雕选项"}]}\n<div>第${requests.length}张卡片</div>` };
        },
    };

    const first = await handleCustomPanelGeneration(3, settings, context, dependencies);
    assert.equal(first.generated, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].renderHtml, true);
    assert.equal(requests[0].choicesEnabled, true);
    assert.equal(requests[0].recentMessages.at(-1).text, '第一个回复');
    assert.equal(
        context.chatMetadata[CUSTOM_PANEL_METADATA_KEY]['3'].variants['swipe:0'].content,
        '<div>第1张卡片</div>',
    );
    assert.deepEqual(
        context.chatMetadata[CUSTOM_PANEL_METADATA_KEY]['3'].variants['swipe:0'].choices.map(choice => choice.tone),
        ['善良', '邪恶', '中立', '沙雕'],
    );

    context.chat[3].swipe_id = 1;
    context.chat[3].mes = '第二个回复';
    const second = await handleCustomPanelGeneration(3, settings, context, dependencies);
    assert.equal(second.generated, true);
    assert.equal(requests.length, 2);
    assert.equal(context.chatMetadata[CUSTOM_PANEL_METADATA_KEY]['3'].variants['swipe:1'].content, '<div>第2张卡片</div>');

    const cached = await handleCustomPanelGeneration(3, settings, context, dependencies);
    assert.equal(cached.cached, true);
    assert.equal(requests.length, 2);
    assert.equal(context.saves, 2);
    assert.equal(renders.at(-1).state, 'ready');
});

test('custom panel HTML runs in its own sandbox and does not depend on正文 HTML setting', async () => {
    const [source, settings] = await Promise.all([
        readFile(new URL('../custom-panel.js', import.meta.url), 'utf8'),
        readFile(new URL('../settings.html', import.meta.url), 'utf8'),
    ]);
    assert.match(source, /sandbox', 'allow-scripts allow-forms'/);
    assert.match(source, /addHtmlScrollSupport/);
    assert.match(settings, /data-setting="customPanel\.renderHtml"/);
    assert.doesNotMatch(source, /htmlRenderer\.enabled/);
});
