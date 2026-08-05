import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { containsRenderableHtml } from '../html-renderer.js';

test('HTML compatibility detection keeps the legacy supported tag set', () => {
    assert.equal(containsRenderableHtml('<!DOCTYPE html><html><body>phone</body></html>'), true);
    assert.equal(containsRenderableHtml('<DIV class="phone">phone</DIV>'), true);
    assert.equal(containsRenderableHtml('<script>document.body.textContent = "ok"</script>'), true);
    assert.equal(containsRenderableHtml('普通文本和 `code`'), false);
    assert.equal(containsRenderableHtml('<strong>普通 HTML 教学片段</strong>'), false);
});

test('HTML compatibility renderer is event-driven, isolated, and silent', async () => {
    const source = await readFile(new URL('../html-renderer.js', import.meta.url), 'utf8');
    assert.match(source, /\.mes_text pre > code/);
    assert.match(source, /MutationObserverRef/);
    assert.match(source, /sandbox', 'allow-scripts allow-forms'/);
    assert.doesNotMatch(source, /setInterval/);
    assert.doesNotMatch(source, /toastr/);
});

test('HTML compatibility support is enabled by default and remains optional', async () => {
    const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const settings = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
    assert.match(index, /htmlRenderer:\s*\{\s*enabled:\s*true/);
    assert.match(settings, /data-setting="htmlRenderer\.enabled"/);
    assert.match(settings, /不会弹出启动提示/);
});
