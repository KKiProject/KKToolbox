const HTML_TRIGGER_PATTERN = /<(?:!doctype\s+html|html\b|head\b|body\b|div\b|span\b|style\b|script\b|table\b|iframe\b|svg\b|form\b)/i;
const RENDERED_SELECTOR = '.memory-augment-html-render';
const SOURCE_HASH_ATTRIBUTE = 'data-memory-augment-html-source';
const YIELDED_ATTRIBUTE = 'data-memory-augment-html-yielded';
const SCROLL_STYLE_MARKER = 'data-memory-augment-scroll-support';
const RENDER_SETTLE_DELAY = 120;

let rendererState = null;
const originalBlocks = new WeakMap();
const blockSignatures = new WeakMap();

export function containsRenderableHtml(value) {
    return HTML_TRIGGER_PATTERN.test(String(value ?? ''));
}

function stableHash(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeHtmlSource(value) {
    return String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/>\s+</g, '><')
        .trim();
}

export function getHtmlRenderFingerprint(value) {
    return `html-${stableHash(normalizeHtmlSource(value))}`;
}

export function addHtmlScrollSupport(value) {
    const html = String(value ?? '');
    if (!html || html.includes(SCROLL_STYLE_MARKER)) return html;
    const style = `<style ${SCROLL_STYLE_MARKER}>html,body{max-width:100%!important;overflow-x:hidden!important;overflow-y:auto!important;-webkit-overflow-scrolling:touch!important;overscroll-behavior-y:contain!important;touch-action:pan-y!important;}body{min-height:100%;}</style>`;
    if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${style}</head>`);
    if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${style}`);
    if (/<html(?:\s[^>]*)?>/i.test(html)) return html.replace(/<html(?:\s[^>]*)?>/i, match => `${match}<head>${style}</head>`);
    return `${style}${html}`;
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

function elementIsInside(node, parent) {
    return Boolean(node && parent && (node === parent || parent.contains?.(node)));
}

function buildHtmlSignature(html, documentRef) {
    const template = documentRef.createElement('template');
    template.innerHTML = html;
    const content = template.content;
    const elements = [
        ...(content?.children ? [...content.children] : []),
        ...(content?.querySelectorAll ? [...content.querySelectorAll('*')] : []),
    ];
    const ids = [...new Set(elements.map(element => String(element.id ?? '').trim()).filter(Boolean))].slice(0, 12);
    const shapes = [];
    for (const element of elements) {
        const classes = [...(element.classList ?? [])]
            .map(value => String(value).trim())
            .filter(value => value.length >= 4)
            .slice(0, 4);
        if (classes.length < 2 && !classes.some(value => value.length >= 10)) continue;
        shapes.push({ tag: String(element.tagName ?? '').toLowerCase(), classes });
        if (shapes.length >= 8) break;
    }
    return { hash: getHtmlRenderFingerprint(html), ids, shapes };
}

function isCandidateNode(node, excludedNode) {
    return !elementIsInside(node, excludedNode)
        && !node?.closest?.('pre')
        && !node?.closest?.(RENDERED_SELECTOR);
}

function hasEquivalentRenderedOutput(messageRoot, signature, excludedNode = null) {
    if (!messageRoot?.querySelectorAll || !signature) return false;
    for (const iframe of messageRoot.querySelectorAll('iframe')) {
        if (!isCandidateNode(iframe, excludedNode)) continue;
        const claimedHash = iframe.closest?.(`[${SOURCE_HASH_ATTRIBUTE}]`)?.getAttribute?.(SOURCE_HASH_ATTRIBUTE);
        if (claimedHash === signature.hash) return true;
        const srcdoc = iframe.getAttribute?.('srcdoc') ?? '';
        if (srcdoc && getHtmlRenderFingerprint(srcdoc) === signature.hash) return true;
    }
    for (const id of signature.ids) {
        for (const element of messageRoot.querySelectorAll('[id]')) {
            if (String(element.id ?? '') === id && isCandidateNode(element, excludedNode)) return true;
        }
    }
    for (const shape of signature.shapes) {
        const candidates = messageRoot.querySelectorAll(shape.tag || '*');
        for (const element of candidates) {
            if (!isCandidateNode(element, excludedNode)) continue;
            if (shape.classes.every(className => element.classList?.contains?.(className))) return true;
        }
    }
    return false;
}

function isIntentionallyHidden(element, documentRef) {
    if (!element) return true;
    if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return true;
    if (element.closest?.('[hidden], [aria-hidden="true"], details:not([open])')) return true;
    const getStyle = documentRef?.defaultView?.getComputedStyle;
    if (typeof getStyle !== 'function') return false;
    const style = getStyle.call(documentRef.defaultView, element);
    return style?.display === 'none'
        || style?.visibility === 'hidden'
        || style?.visibility === 'collapse'
        || style?.contentVisibility === 'hidden';
}

function yieldToExistingRenderer(pre, signature) {
    pre.setAttribute(YIELDED_ATTRIBUTE, signature.hash);
    pre.hidden = true;
}

function reconcileRenderedBlocks(root, documentRef) {
    root.querySelectorAll(RENDERED_SELECTOR).forEach((container) => {
        const state = originalBlocks.get(container);
        const messageRoot = container.closest?.('.mes_text');
        if (!state || !messageRoot || !hasEquivalentRenderedOutput(messageRoot, state.signature, container)) return;
        const original = state.original.cloneNode(true);
        yieldToExistingRenderer(original, state.signature);
        container.replaceWith(original);
    });
}

function restoreRenderedBlocks(root) {
    root.querySelectorAll(RENDERED_SELECTOR).forEach((container) => {
        const state = originalBlocks.get(container);
        if (state?.original) container.replaceWith(state.original.cloneNode(true));
    });
    root.querySelectorAll(`[${YIELDED_ATTRIBUTE}]`).forEach((pre) => {
        pre.hidden = false;
        pre.removeAttribute(YIELDED_ATTRIBUTE);
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
    reconcileRenderedBlocks(root, documentRef);
    let rendered = 0;

    root.querySelectorAll('.mes_text pre > code').forEach((codeBlock) => {
        const pre = codeBlock.parentElement;
        if (!pre || pre.closest(RENDERED_SELECTOR)) return;
        const html = getRenderableHtml(codeBlock, documentRef);
        if (!html) return;
        const signature = blockSignatures.get(pre) ?? buildHtmlSignature(html, documentRef);
        blockSignatures.set(pre, signature);
        const messageRoot = pre.closest?.('.mes_text');
        const yieldedHash = pre.getAttribute?.(YIELDED_ATTRIBUTE);
        if (yieldedHash) {
            if (messageRoot && hasEquivalentRenderedOutput(messageRoot, signature, pre)) return;
            pre.hidden = false;
            pre.removeAttribute(YIELDED_ATTRIBUTE);
        }
        if (isIntentionallyHidden(pre, documentRef)) return;
        if (messageRoot && hasEquivalentRenderedOutput(messageRoot, signature, pre)) {
            yieldToExistingRenderer(pre, signature);
            return;
        }

        const container = documentRef.createElement('div');
        container.className = 'memory-augment-html-render';
        container.setAttribute(SOURCE_HASH_ATTRIBUTE, signature.hash);
        const iframe = documentRef.createElement('iframe');
        iframe.className = 'memory-augment-html-frame';
        iframe.title = '聊天内嵌 HTML 内容';
        iframe.loading = 'lazy';
        iframe.referrerPolicy = 'no-referrer';
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
        iframe.setAttribute('scrolling', 'yes');
        iframe.srcdoc = addHtmlScrollSupport(html);
        container.append(iframe);
        originalBlocks.set(container, { original: pre.cloneNode(true), signature });
        pre.replaceWith(container);
        rendered += 1;
    });

    return rendered;
}

function scheduleRefresh() {
    if (!rendererState) return;
    if (rendererState.timer) rendererState.document?.defaultView?.clearTimeout?.(rendererState.timer);
    const run = () => {
        if (!rendererState) return;
        rendererState.timer = null;
        renderHtmlCodeBlocks(rendererState.chatRoot, rendererState.settings, {
            document: rendererState.document,
        });
    };
    const setTimer = rendererState.document?.defaultView?.setTimeout ?? globalThis.setTimeout;
    rendererState.timer = setTimer(run, RENDER_SETTLE_DELAY);
}

export function refreshHtmlRenderer() {
    scheduleRefresh();
}

export function destroyHtmlRenderer() {
    if (!rendererState) return;
    rendererState.observer?.disconnect();
    const clearTimer = rendererState.document?.defaultView?.clearTimeout ?? globalThis.clearTimeout;
    if (rendererState.timer) clearTimer(rendererState.timer);
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
        timer: null,
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
