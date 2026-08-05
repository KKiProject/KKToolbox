const HTML_TRIGGER_PATTERN = /<(?:!doctype\s+html|html\b|head\b|body\b|div\b|span\b|style\b|script\b|table\b|iframe\b|svg\b|form\b)/i;
const RENDERED_SELECTOR = '.memory-augment-html-render';

let rendererState = null;
const originalBlocks = new WeakMap();

export function containsRenderableHtml(value) {
    return HTML_TRIGGER_PATTERN.test(String(value ?? ''));
}

function decodeHtmlEntities(value, documentRef) {
    const decoder = documentRef.createElement('textarea');
    decoder.innerHTML = String(value ?? '');
    return decoder.value;
}

function getRenderableHtml(codeBlock, documentRef) {
    const rawText = String(codeBlock?.textContent ?? '');
    const decodedText = decodeHtmlEntities(rawText, documentRef);
    return containsRenderableHtml(decodedText) ? decodedText : '';
}

function restoreRenderedBlocks(root) {
    root.querySelectorAll(RENDERED_SELECTOR).forEach((container) => {
        const original = originalBlocks.get(container);
        if (original) container.replaceWith(original.cloneNode(true));
    });
}

export function renderHtmlCodeBlocks(root, settings, options = {}) {
    if (!root?.querySelectorAll) return 0;
    if (settings?.htmlRenderer?.enabled === false) {
        restoreRenderedBlocks(root);
        return 0;
    }

    const documentRef = options.document ?? root.ownerDocument ?? globalThis.document;
    if (!documentRef?.createElement) return 0;
    let rendered = 0;

    root.querySelectorAll('.mes_text pre > code').forEach((codeBlock) => {
        const pre = codeBlock.parentElement;
        if (!pre || pre.closest(RENDERED_SELECTOR)) return;
        const html = getRenderableHtml(codeBlock, documentRef);
        if (!html) return;

        const container = documentRef.createElement('div');
        container.className = 'memory-augment-html-render';
        const iframe = documentRef.createElement('iframe');
        iframe.className = 'memory-augment-html-frame';
        iframe.title = '聊天内嵌 HTML 内容';
        iframe.loading = 'lazy';
        iframe.referrerPolicy = 'no-referrer';
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
        iframe.srcdoc = html;
        container.append(iframe);
        originalBlocks.set(container, pre.cloneNode(true));
        pre.replaceWith(container);
        rendered += 1;
    });

    return rendered;
}

function scheduleRefresh() {
    if (!rendererState || rendererState.scheduled) return;
    rendererState.scheduled = true;
    const run = () => {
        if (!rendererState) return;
        rendererState.scheduled = false;
        renderHtmlCodeBlocks(rendererState.chatRoot, rendererState.settings, {
            document: rendererState.document,
        });
    };
    const requestFrame = rendererState.document?.defaultView?.requestAnimationFrame;
    if (typeof requestFrame === 'function') requestFrame.call(rendererState.document.defaultView, run);
    else queueMicrotask(run);
}

export function refreshHtmlRenderer() {
    scheduleRefresh();
}

export function destroyHtmlRenderer() {
    if (!rendererState) return;
    rendererState.observer?.disconnect();
    rendererState = null;
}

export function initializeHtmlRenderer(settings, options = {}) {
    destroyHtmlRenderer();
    const documentRef = options.document ?? globalThis.document;
    const chatRoot = options.chatRoot ?? documentRef?.querySelector?.('#chat');
    const MutationObserverRef = options.MutationObserver
        ?? documentRef?.defaultView?.MutationObserver
        ?? globalThis.MutationObserver;
    if (!chatRoot || typeof MutationObserverRef !== 'function') return false;

    const observer = new MutationObserverRef(scheduleRefresh);
    rendererState = {
        chatRoot,
        document: documentRef,
        observer,
        scheduled: false,
        settings,
    };
    observer.observe(chatRoot, {
        childList: true,
        subtree: true,
        characterData: true,
    });
    renderHtmlCodeBlocks(chatRoot, settings, { document: documentRef });
    return true;
}
