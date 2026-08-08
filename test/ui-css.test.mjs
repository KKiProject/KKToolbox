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

test('every simulated phone page supports direct vertical touch scrolling', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const homeRule = css.match(/\.memory-augment-phone-home\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const touchSection = css.slice(css.indexOf('/* Every scrollable layer inside the simulated phone'));
    const touchRule = touchSection.match(/\.memory-augment-phone-home,\s*[\s\S]*?\.memory-augment-phone-memory-list\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    assert.match(homeRule, /overflow-y:\s*auto/);
    assert.match(homeRule, /min-height:\s*0/);
    assert.match(touchRule, /-webkit-overflow-scrolling:\s*touch/);
    assert.match(touchRule, /touch-action:\s*pan-y/);
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

test('world-info quick selection controls stay in a horizontal row', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const actions = css.match(/\.memory-augment-worldinfo-book-actions\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const button = css.match(/\.memory-augment-worldinfo-book-actions \.menu_button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    assert.match(actions, /display:\s*flex/);
    assert.match(actions, /flex-direction:\s*row/);
    assert.match(button, /white-space:\s*nowrap\s*!important/);
    assert.match(button, /writing-mode:\s*horizontal-tb\s*!important/);
});

test('KKToolbox never falls back to native browser dialogs', async () => {
    const sources = await Promise.all([
        readFile(new URL('../phone-messages.js', import.meta.url), 'utf8'),
        readFile(new URL('../phone-weibo.js', import.meta.url), 'utf8'),
        readFile(new URL('../map-atlas.js', import.meta.url), 'utf8'),
    ]);
    const combined = sources.join('\n');
    assert.doesNotMatch(combined, /globalThis\.(?:confirm|alert|prompt)/);
    assert.doesNotMatch(combined, /window\.(?:confirm|alert|prompt)/);
});

test('weibo keeps its three main views, interest picker, and composer inside the phone', async () => {
    const [source, css] = await Promise.all([
        readFile(new URL('../phone-weibo.js', import.meta.url), 'utf8'),
        readFile(new URL('../style.css', import.meta.url), 'utf8'),
    ]);
    assert.match(source, /\['home', '首页'/);
    assert.match(source, /\['hot', '热搜'/);
    assert.match(source, /\['profile', '我的'/);
    assert.match(source, /你想看些什么/);
    assert.match(source, /分享此刻的新鲜事/);
    assert.match(source, /按热度排序 · 展示 5 条/);
    assert.match(source, /createPhoneWeiboCommentReply/);
    assert.match(source, /createPhoneWeiboRepost/);
    assert.match(source, /topic\.postId/);
    assert.match(source, /还没有评论/);
    assert.match(source, /buildPhoneWeiboRoleAccounts/);
    assert.match(source, /loadPhoneIdentitySources/);
    assert.match(source, /新建微博角色账号/);
    assert.match(source, /互相关注/);
    assert.match(source, /路人 NPC 已折叠/);
    assert.match(source, /添加微博话题/);
    assert.match(source, /没有话题也可以直接发布/);
    assert.match(source, /删除话题/);
    assert.match(source, /customTopics\.splice/);
    assert.match(source, /选择要提及的人/);
    assert.match(source, /😀/);
    assert.match(source, /添加图片描述/);
    assert.match(source, /添加位置/);
    assert.match(source, /编辑微博资料/);
    assert.match(source, /state\(\)\.profile = result/);
    assert.doesNotMatch(source, /renderInterestStrip|enableHorizontalStrip/);
    assert.doesNotMatch(css, /\.memory-augment-weibo-interest-strip/);
    assert.doesNotMatch(source, /memory-augment-weibo-compose-button/);
    const likeHandler = source.match(/function toggleLike\([\s\S]*?\n    \}/)?.[0] ?? '';
    assert.doesNotMatch(likeHandler, /renderMain/);
    assert.match(likeHandler, /control\.classList\.toggle/);
    assert.match(css, /\.memory-augment-phone-app-content\.is-weibo/);
    assert.match(css, /\.memory-augment-weibo-interest-grid/);
    assert.match(css, /\.memory-augment-weibo-composer/);
    assert.match(css, /\.memory-augment-weibo-comment-list/);
    assert.match(css, /\.memory-augment-weibo-repost-card/);
    assert.match(css, /\.memory-augment-weibo-comment-empty/);
    assert.match(css, /\.memory-augment-weibo-role-row/);
    assert.match(css, /\.memory-augment-weibo-role-relation/);
    assert.match(css, /caret-color:\s*#ff6f00/);
    assert.match(css, /\.memory-augment-weibo-compose-tool-panel/);
    assert.match(css, /\.memory-augment-weibo-post-mentions/);
    assert.match(css, /\.memory-augment-weibo-topic-label/);
    assert.match(css, /\.memory-augment-weibo-compose-topic-empty/);
});

test('desktop phone view grows and scales its contents without changing the mobile full-screen rule', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const desktop = css.match(/@media \(min-width: 601px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const mobile = css.match(/@media \(max-width: 600px\)\s*\{([\s\S]*?)$/)?.[1] ?? '';
    assert.match(desktop, /max-width:\s*27rem/);
    assert.match(desktop, /transform:\s*scale\(1\.12\)/);
    assert.match(mobile, /\.memory-augment-phone-device[\s\S]*?max-width:\s*none/);
});

test('phone forms keep validation inside the simulated phone and conversation headers stay immersive', async () => {
    const source = await readFile(new URL('../phone-messages.js', import.meta.url), 'utf8');
    assert.match(source, /form\.noValidate = true/);
    assert.match(source, /min: 0\.01, step: 0\.01, value: 8\.88/);
    assert.match(source, /min: 0\.01, step: 0\.01, value: 88\.88/);
    assert.doesNotMatch(source, /昵称备注 · \$\{/);
    assert.doesNotMatch(source, /人 · 长按消息可多选/);
});

test('phone red packets use a bright yuan seal instead of an email label', async () => {
    const [source, css] = await Promise.all([
        readFile(new URL('../phone-messages.js', import.meta.url), 'utf8'),
        readFile(new URL('../style.css', import.meta.url), 'utf8'),
    ]);
    assert.doesNotMatch(source, /fa-envelope/);
    assert.doesNotMatch(source, /title\.textContent = message\.type === 'group_redpacket'/);
    assert.match(source, /memory-augment-phone-redpacket-seal/);
    assert.match(css, /\.memory-augment-phone-redpacket-seal\s*\{/);
    assert.match(css, /#f9d36c/);
});

test('sticker group and import controls stay horizontal and scrollable on phones', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const toolbar = css.match(/\.memory-augment-phone-sticker-toolbar\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const groups = css.match(/\.memory-augment-phone-sticker-groups\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const buttons = css.match(/\.memory-augment-phone-sticker-toolbar > button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    assert.match(toolbar, /display:\s*flex/);
    assert.match(toolbar, /overflow-x:\s*auto/);
    assert.match(groups, /display:\s*flex/);
    assert.match(groups, /overflow-x:\s*auto/);
    assert.match(buttons, /white-space:\s*nowrap/);
    assert.match(buttons, /writing-mode:\s*horizontal-tb/);
});

test('phone text fields opt out of browser autofill and forwarding uses an explicit multi-target list', async () => {
    const source = await readFile(new URL('../phone-messages.js', import.meta.url), 'utf8');
    assert.match(source, /input\.autocomplete = 'off'/);
    assert.match(source, /form\.autocomplete = 'off'/);
    assert.match(source, /memory-augment-phone-forward-targets/);
    assert.match(source, /selectedTargets = new Set/);
    assert.doesNotMatch(source, /label: '选择接收聊天'[\s\S]{0,180}type: 'select'/);
});

test('phone message selection preserves its reading position and staged text restores focus', async () => {
    const source = await readFile(new URL('../phone-messages.js', import.meta.url), 'utf8');
    assert.match(source, /renderConversation\(\{ preserveScroll: true \}\)/);
    assert.match(source, /messageList\.scrollTop = preserveScroll \? previousScrollTop : messageList\.scrollHeight/);
    assert.match(source, /sendPlayerMessage\(\{ type: 'text', content \}, \{ focusComposer: true \}\)/);
    assert.match(source, /nextInput\?\.focus\(\{ preventScroll: true \}\)/);
});

test('phone selection mode sends taps on every message card to the row selector', async () => {
    const [source, css] = await Promise.all([
        readFile(new URL('../phone-messages.js', import.meta.url), 'utf8'),
        readFile(new URL('../style.css', import.meta.url), 'utf8'),
    ]);
    assert.match(source, /wrapper\.classList\.toggle\('is-selecting', selectedMessageIds\.size > 0\)/);
    const rule = css.match(/\.memory-augment-phone-conversation\.is-selecting \.memory-augment-phone-message-bubble \*\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    assert.match(rule, /pointer-events:\s*none/);
});

test('text and voice keep generic bubbles while other message types use their own cards', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const rule = css.match(/\.memory-augment-phone-message-row \.memory-augment-phone-message-bubble\.is-image,[\s\S]*?\.memory-augment-phone-message-row \.memory-augment-phone-message-bubble\.is-forward_bundle\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    assert.match(rule, /background:\s*transparent/);
    assert.match(rule, /border:\s*0/);
    assert.match(rule, /box-shadow:\s*none/);
    assert.match(rule, /padding:\s*0/);
    for (const type of ['image', 'location', 'sticker', 'redpacket', 'group_redpacket', 'forward_bundle']) {
        assert.match(css, new RegExp(`\\.memory-augment-phone-message-row \\.memory-augment-phone-message-bubble\\.is-${type}`));
    }
    assert.doesNotMatch(css, /\.memory-augment-phone-message-row \.memory-augment-phone-message-bubble\.is-voice,/);
    const imageCard = css.match(/\.memory-augment-phone-message-bubble\.is-image \.memory-augment-phone-sim-card\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    assert.match(imageCard, /background:/);
    assert.match(imageCard, /border:\s*1px solid/);
    assert.match(imageCard, /border-radius:/);
});

test('group red packets expose lucky king without changing their random participant pool', async () => {
    const [messages, store] = await Promise.all([
        readFile(new URL('../phone-messages.js', import.meta.url), 'utf8'),
        readFile(new URL('../phone-store.js', import.meta.url), 'utf8'),
    ]);
    assert.match(messages, /手气王/);
    assert.match(messages, /\[store\.profile\.nickname \|\| '我', \.\.\.conversation\.members\]/);
    assert.match(store, /splitGroupRedPacket\(total, names, requestedCount/);
});
