import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    addHtmlScrollSupport,
    containsRenderableHtml,
    getHtmlRenderFingerprint,
    getRegexDisplayHtml,
} from '../html-renderer.js';

test('HTML compatibility detection keeps the legacy supported tag set', () => {
    assert.equal(containsRenderableHtml('<!DOCTYPE html><html><body>phone</body></html>'), true);
    assert.equal(containsRenderableHtml('<DIV class="phone">phone</DIV>'), true);
    assert.equal(containsRenderableHtml('<script>document.body.textContent = "ok"</script>'), true);
    assert.equal(containsRenderableHtml('普通文本和 `code`'), false);
    assert.equal(containsRenderableHtml('<strong>普通 HTML 教学片段</strong>'), false);
});

test('HTML compatibility renderer is event-driven, fully functional, and silent', async () => {
    const source = await readFile(new URL('../html-renderer.js', import.meta.url), 'utf8');
    assert.match(source, /\.mes_text pre > code/);
    assert.match(source, /renderRegexDisplayMessages/);
    assert.match(source, /MutationObserverRef/);
    assert.match(source, /hasEquivalentRenderedOutput/);
    assert.match(source, /isIntentionallyHidden/);
    assert.match(source, /RENDER_SETTLE_DELAY/);
    assert.match(source, /scrolling', 'yes'/);
    assert.doesNotMatch(source, /setAttribute\('sandbox'/);
    assert.doesNotMatch(source, /referrerPolicy/);
    assert.doesNotMatch(source, /setInterval/);
    assert.doesNotMatch(source, /toastr/);
});

test('HTML compatibility renders the HTML produced only by display regex without changing chat text', () => {
    const chat = [
        { mes: '前文', is_user: true },
        { mes: '[状态栏]', name: '角色', is_user: false },
    ];
    let received;
    const html = getRegexDisplayHtml(chat[1], 1, chat, (source, options) => {
        received = { source, options };
        return '<!doctype html><html><body><script>document.body.dataset.ready = "1"</script><div>状态栏</div></body></html>';
    });

    assert.match(html, /document\.body\.dataset\.ready/);
    assert.equal(chat[1].mes, '[状态栏]');
    assert.equal(received.source, '[状态栏]');
    assert.equal(received.options.message, chat[1]);
    assert.equal(received.options.depth, 0);
    assert.equal(getRegexDisplayHtml(chat[1], 1, chat, source => source), '');
    assert.equal(getRegexDisplayHtml({ mes: '[状态栏]', is_system: true }, 0, [], () => html), '');
});

test('HTML compatibility removes a complete HTML fence before creating srcdoc', () => {
    const message = { mes: '[手机屏幕]', name: '角色', is_user: false };
    const html = getRegexDisplayHtml(message, 0, [message], () => [
        '```html',
        '<!doctype html><html><body><div>手机</div></body></html>',
        '```',
    ].join('\n'));

    assert.equal(html, '<!doctype html><html><body><div>手机</div></body></html>');
});

test('HTML compatibility fingerprints equivalent formatting and injects mobile scrolling once', () => {
    const compact = '<div id="status-root"><span>状态</span></div>';
    const spaced = '<div id="status-root">\n  <span>状态</span>\n</div>';
    assert.equal(getHtmlRenderFingerprint(compact), getHtmlRenderFingerprint(spaced));
    const supported = addHtmlScrollSupport(`<!doctype html><html><head></head><body>${compact}</body></html>`);
    assert.match(supported, /data-memory-augment-scroll-support/);
    assert.match(supported, /overflow-y:auto!important/);
    assert.match(supported, /-webkit-overflow-scrolling:touch!important/);
    assert.match(supported, /touch-action:pan-y!important/);
    assert.equal(addHtmlScrollSupport(supported), supported);
});

test('HTML compatibility support is enabled by default and remains optional', async () => {
    const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const settings = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
    assert.match(index, /htmlRenderer:\s*\{\s*enabled:\s*true/);
    assert.match(settings, /data-setting="htmlRenderer\.enabled"/);
    assert.match(settings, /不会弹出启动提示/);
});
