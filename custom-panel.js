import { normalizeBaseUrl } from './api-utils.js';
import { collectRecentMessages, findLatestEligibleAssistantMessageId } from './barrage-ui.js';
import { addHtmlScrollSupport, containsRenderableHtml } from './html-renderer.js';
import { generateCustomPanel } from './rag-client.js';
import { hashStorySource } from './story-status.js';

const CUSTOM_PANEL_METADATA_KEY = 'memory_augment_custom_panels';
const CUSTOM_PANEL_RECOVERY_DELAYS = Object.freeze([250, 1200, 4000]);
const CUSTOM_PANEL_DOM_DELAYS = Object.freeze([180, 800, 2400]);
const STORY_CHOICE_TONES = Object.freeze(['善良', '邪恶', '中立', '沙雕']);
const inFlight = new Map();
const recoveryTimers = new Set();
let lifecycleBound = false;
let controlsBound = false;
let domObserver = null;
let domTimer = null;

function clampInteger(value, fallback, minimum, maximum) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function getChatId(context) {
    return context?.getCurrentChatId?.() ?? context?.chatId;
}

function customPanelHasOutput(settings) {
    const choicesEnabled = settings?.customPanel?.choicesEnabled === true;
    const customReady = settings?.customPanel?.customContentEnabled !== false
        && Boolean(String(settings?.customPanel?.prompt ?? '').trim());
    return choicesEnabled || customReady;
}

function completeApiConfig(config) {
    const normalized = {
        baseUrl: normalizeBaseUrl(config?.url ?? config?.baseUrl),
        apiKey: String(config?.apiKey ?? '').trim(),
        model: String(config?.model ?? '').trim(),
    };
    return normalized.baseUrl && normalized.apiKey && normalized.model ? normalized : null;
}

function getVariantKey(message) {
    const swipeId = Math.trunc(Number(message?.swipe_id));
    if (Number.isInteger(swipeId) && swipeId >= 0) return `swipe:${swipeId}`;
    const current = String(message?.mes ?? '').trim();
    const matched = Array.isArray(message?.swipes)
        ? message.swipes.findIndex(value => String(value ?? '').trim() === current)
        : -1;
    return `swipe:${matched >= 0 ? matched : 0}`;
}

function getValidVariantKeys(message) {
    const count = Array.isArray(message?.swipes) && message.swipes.length > 0
        ? message.swipes.length
        : 1;
    return new Set(Array.from({ length: count }, (_, index) => `swipe:${index}`));
}

function getStore(metadata, create = false) {
    const existing = metadata?.[CUSTOM_PANEL_METADATA_KEY];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing;
    if (create && metadata && typeof metadata === 'object') {
        metadata[CUSTOM_PANEL_METADATA_KEY] = {};
        return metadata[CUSTOM_PANEL_METADATA_KEY];
    }
    return {};
}

function getRecord(metadata, messageId, message) {
    return getStore(metadata)?.[String(messageId)]?.variants?.[getVariantKey(message)] ?? null;
}

function setRecord(metadata, messageId, message, record) {
    const store = getStore(metadata, true);
    const key = String(messageId);
    if (!store[key]?.variants || typeof store[key].variants !== 'object') {
        store[key] = { version: 1, variants: {} };
    }
    store[key].variants[getVariantKey(message)] = record;
}

function deleteCurrentRecord(metadata, messageId, message) {
    const store = getStore(metadata);
    const bucket = store[String(messageId)];
    if (!bucket?.variants) return false;
    const removed = delete bucket.variants[getVariantKey(message)];
    if (Object.keys(bucket.variants).length === 0) delete store[String(messageId)];
    return removed;
}

export function stripCustomPanelCodeFence(value) {
    const text = String(value ?? '').trim();
    const match = text.match(/^```(?:html?)?\s*\n?([\s\S]*?)\n?```$/i);
    return String(match?.[1] ?? text).trim();
}

export function parseCustomPanelResponse(value, options = {}) {
    const raw = String(value ?? '').replace(/\r\n?/g, '\n').trim();
    const choicesEnabled = options.choicesEnabled === true;
    const customContentEnabled = options.customContentEnabled !== false;
    if (!choicesEnabled) {
        return {
            choices: [],
            content: customContentEnabled ? stripCustomPanelCodeFence(raw) : '',
        };
    }

    const lines = raw.split('\n');
    const markerIndex = lines.findIndex(line => /^\s*KK_CHOICES_JSON\s*=/.test(line));
    if (markerIndex < 0) throw new Error('副 API 没有返回可用的剧情选项。');
    const jsonText = lines[markerIndex].replace(/^\s*KK_CHOICES_JSON\s*=\s*/, '').trim();
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        throw new Error('剧情选项格式损坏，请重新生成。');
    }
    const sourceChoices = Array.isArray(parsed?.choices) ? parsed.choices : [];
    const choices = STORY_CHOICE_TONES.map((tone, index) => {
        const matched = sourceChoices.find(choice => String(choice?.tone ?? '').trim() === tone)
            ?? sourceChoices[index];
        const text = typeof matched === 'string'
            ? matched.trim()
            : String(matched?.text ?? matched?.content ?? '').trim();
        return text ? { tone, text } : null;
    }).filter(Boolean);
    if (choices.length !== STORY_CHOICE_TONES.length) {
        throw new Error('剧情选项不完整，需要善良、邪恶、中立和沙雕四项。');
    }
    const contentLines = lines.slice(markerIndex + 1);
    if (contentLines[0]?.trim() === '```') contentLines.shift();
    return {
        choices,
        content: customContentEnabled ? stripCustomPanelCodeFence(contentLines.join('\n')) : '',
    };
}

function fingerprint(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function createPanel(documentRef) {
    const panel = documentRef.createElement('details');
    panel.className = 'memory-augment-custom-panel';
    panel.innerHTML = `
        <summary class="memory-augment-custom-panel-toggle">
            <span class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></span>
            <span class="memory-augment-custom-panel-title"></span>
            <span class="memory-augment-custom-panel-status"></span>
        </summary>
        <div class="memory-augment-custom-panel-content" aria-live="polite"></div>
        <div class="memory-augment-custom-panel-actions">
            <button type="button" class="menu_button memory-augment-custom-panel-regenerate">重新生成</button>
        </div>`;
    return panel;
}

function renderPanelBody(body, content, renderHtml, documentRef, title, choices = []) {
    const source = stripCustomPanelCodeFence(content);
    const mode = renderHtml && containsRenderableHtml(source) ? 'html' : 'text';
    const normalizedChoices = Array.isArray(choices)
        ? choices.map(choice => ({
            tone: String(choice?.tone ?? '').trim(),
            text: String(choice?.text ?? choice?.content ?? choice ?? '').trim(),
        })).filter(choice => choice.text)
        : [];
    const signature = `${mode}:${fingerprint(source)}:${fingerprint(JSON.stringify(normalizedChoices))}`;
    if (body.dataset.customPanelSignature === signature) {
        const existingFrame = body.querySelector?.('.memory-augment-custom-panel-frame');
        if (existingFrame) existingFrame.title = `${title}内容`;
        return;
    }
    body.replaceChildren();
    body.dataset.customPanelSignature = signature;
    body.classList.toggle('has-choices', normalizedChoices.length > 0);
    if (normalizedChoices.length > 0) {
        const choiceGrid = documentRef.createElement('div');
        choiceGrid.className = 'memory-augment-custom-panel-choices';
        const choiceHeading = documentRef.createElement('div');
        choiceHeading.className = 'memory-augment-custom-panel-choice-heading';
        choiceHeading.textContent = '剧情选项';
        choiceGrid.append(choiceHeading);
        normalizedChoices.forEach((choice, index) => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.className = 'memory-augment-custom-panel-choice';
            button.dataset.choiceText = choice.text;
            button.dataset.choiceTone = choice.tone;
            const badge = documentRef.createElement('span');
            badge.className = 'memory-augment-custom-panel-choice-tone';
            badge.textContent = choice.tone || STORY_CHOICE_TONES[index] || `选项${index + 1}`;
            const choiceText = documentRef.createElement('span');
            choiceText.className = 'memory-augment-custom-panel-choice-text';
            choiceText.textContent = choice.text;
            button.append(badge, choiceText);
            choiceGrid.append(button);
        });
        body.append(choiceGrid);
    }
    if (!source) {
        body.classList.remove('is-html');
        return;
    }
    const output = documentRef.createElement('div');
    output.className = 'memory-augment-custom-panel-output';
    if (mode === 'html') {
        const frame = documentRef.createElement('iframe');
        frame.className = 'memory-augment-custom-panel-frame';
        frame.title = `${title}内容`;
        frame.loading = 'lazy';
        frame.referrerPolicy = 'no-referrer';
        frame.setAttribute('sandbox', 'allow-scripts allow-forms');
        frame.setAttribute('scrolling', 'yes');
        frame.srcdoc = addHtmlScrollSupport(source);
        output.classList.add('is-html');
        output.append(frame);
        body.append(output);
        return;
    }
    output.textContent = source;
    body.append(output);
}

export function renderCustomPanel(messageId, content, state, settings, choices = [], documentRef = globalThis.document) {
    const numericId = Number(messageId);
    if (!Number.isInteger(numericId) || !documentRef?.querySelector) return false;
    const messageElement = documentRef.querySelector(`#chat .mes[mesid="${numericId}"]`);
    const messageBlock = messageElement?.querySelector('.mes_block');
    if (!messageBlock) return false;
    const host = messageBlock.querySelector('.mes_text') ?? messageBlock;
    let panel = messageBlock.querySelector('.memory-augment-custom-panel');
    if (!panel) panel = createPanel(documentRef);
    if (panel.parentElement !== host) host.append(panel);

    const title = String(settings?.customPanel?.title ?? '').trim() || '自定义';
    panel.hidden = settings?.customPanel?.enabled !== true || !customPanelHasOutput(settings);
    panel.classList.toggle('is-loading', state === 'loading');
    panel.classList.toggle('is-error', state === 'error');
    const titleNode = panel.querySelector('.memory-augment-custom-panel-title');
    const statusNode = panel.querySelector('.memory-augment-custom-panel-status');
    const body = panel.querySelector('.memory-augment-custom-panel-content');
    if (titleNode) titleNode.textContent = title;
    if (statusNode) statusNode.textContent = state === 'loading' ? '生成中…' : state === 'error' ? '生成失败' : '';
    if (body) renderPanelBody(
        body,
        content,
        settings?.customPanel?.renderHtml === true,
        documentRef,
        title,
        choices,
    );
    return true;
}

function safeRender(messageId, content, state, settings, choices = [], render = renderCustomPanel) {
    try {
        return render(messageId, content, state, settings, choices);
    } catch (error) {
        console.warn('[Memory Augment] Custom panel rendering failed.', error);
        return false;
    }
}

export async function handleCustomPanelGeneration(messageId, settings, context, dependencies = {}, options = {}) {
    const numericId = Number(messageId);
    const message = Number.isInteger(numericId) ? context?.chat?.[numericId] : null;
    const text = String(message?.mes ?? '').trim();
    const prompt = String(settings?.customPanel?.prompt ?? '').trim();
    const enabled = settings?.customPanel?.enabled === true;
    const choicesEnabled = settings?.customPanel?.choicesEnabled === true;
    const customContentEnabled = settings?.customPanel?.customContentEnabled !== false;
    const hasRequestedOutput = customPanelHasOutput(settings);
    const hasPriorUser = Number.isInteger(numericId)
        && context?.chat?.slice(0, numericId).some(item => item?.is_user);
    if (!enabled || !hasRequestedOutput || !message || message.is_user || message.is_system
        || !text || text === '...' || !hasPriorUser) {
        return { generated: false, reason: 'disabled-or-ineligible' };
    }

    const render = dependencies.render ?? renderCustomPanel;
    const cached = getRecord(context.chatMetadata, numericId, message);
    if (!options.force && (cached?.content || cached?.choices?.length)) {
        safeRender(numericId, cached.content, 'ready', settings, cached.choices, render);
        return { generated: false, cached: true, content: cached.content, choices: cached.choices ?? [] };
    }
    const barrage = completeApiConfig(settings?.apis?.barrage);
    if (!barrage) {
        const detail = '自定义栏生成失败：副 API 的地址、Key 或模型没有填完整。';
        safeRender(numericId, detail, 'error', settings, [], render);
        return { generated: false, reason: 'missing-config' };
    }

    const chatId = getChatId(context);
    const variantKey = getVariantKey(message);
    const sourceHash = hashStorySource(text);
    const requestKey = `${chatId}:${numericId}:${variantKey}`;
    if (inFlight.has(requestKey)) return inFlight.get(requestKey);

    const task = (async () => {
        safeRender(numericId, '正在生成…', 'loading', settings, [], render);
        const recentMessages = collectRecentMessages(
            context.chat,
            numericId,
            clampInteger(settings?.customPanel?.recentMessages, 3, 1, 20),
        );
        const request = dependencies.generate ?? generateCustomPanel;
        const response = await request({
            barrage,
            prompt,
            recentMessages,
            choicesEnabled,
            customContentEnabled,
            renderHtml: customContentEnabled && settings?.customPanel?.renderHtml === true,
            maxTokens: settings?.customPanel?.maxTokens,
        });
        const parsed = parseCustomPanelResponse(response?.content, { choicesEnabled, customContentEnabled });
        const content = parsed.content;
        const choices = parsed.choices;
        if (!content && choices.length === 0) throw new Error('副 API 没有返回可显示的内容。');

        const currentContext = dependencies.getCurrentContext?.()
            ?? globalThis.SillyTavern?.getContext?.()
            ?? context;
        const currentMessage = currentContext?.chat?.[numericId];
        if (getChatId(currentContext) !== chatId
            || getVariantKey(currentMessage) !== variantKey
            || hashStorySource(currentMessage?.mes) !== sourceHash) {
            return { generated: false, discarded: true };
        }
        setRecord(currentContext.chatMetadata, numericId, currentMessage, {
            content,
            choices,
            renderHtml: customContentEnabled && settings?.customPanel?.renderHtml === true,
            sourceHash,
            timestamp: Math.floor(Date.now() / 1000),
        });
        await currentContext.saveMetadata?.();
        safeRender(numericId, content, 'ready', settings, choices, render);
        if (render === renderCustomPanel && typeof document !== 'undefined') {
            const panel = document.querySelector(`#chat .mes[mesid="${numericId}"] .memory-augment-custom-panel`);
            if (panel && choices.length > 0) panel.open = true;
        }
        scheduleDomRestore(settings, chatId);
        return { generated: true, content, choices };
    })().catch(async (error) => {
        const currentContext = dependencies.getCurrentContext?.()
            ?? globalThis.SillyTavern?.getContext?.()
            ?? context;
        const currentMessage = currentContext?.chat?.[numericId];
        if (getChatId(currentContext) === chatId && getVariantKey(currentMessage) === variantKey) {
            const detail = String(error?.message ?? error ?? '未知错误').trim();
            setRecord(currentContext.chatMetadata, numericId, currentMessage, {
                state: 'error',
                error: detail,
                sourceHash,
                timestamp: Math.floor(Date.now() / 1000),
            });
            try {
                await currentContext.saveMetadata?.();
            } catch (saveError) {
                console.warn('[Memory Augment] Custom panel error record save failed.', saveError);
            }
            safeRender(numericId, `自定义栏生成失败：${detail}`, 'error', settings, [], render);
        }
        console.warn('[Memory Augment] Custom panel generation failed.', error);
        return { generated: false, error };
    }).finally(() => inFlight.delete(requestKey));

    inFlight.set(requestKey, task);
    return task;
}

export function restoreStoredCustomPanels(context, settings, render = renderCustomPanel) {
    if (settings?.customPanel?.enabled !== true || !customPanelHasOutput(settings)) return 0;
    const store = getStore(context?.chatMetadata);
    let rendered = 0;
    let changed = false;
    for (const [messageId, bucket] of Object.entries(store)) {
        const message = context?.chat?.[Number(messageId)];
        if (!message || message.is_user || message.is_system || !bucket?.variants) {
            delete store[messageId];
            changed = true;
            continue;
        }
        const validKeys = getValidVariantKeys(message);
        for (const key of Object.keys(bucket.variants)) {
            if (!validKeys.has(key)) {
                delete bucket.variants[key];
                changed = true;
            }
        }
        if (Object.keys(bucket.variants).length === 0) {
            delete store[messageId];
            changed = true;
            continue;
        }
        const record = bucket.variants[getVariantKey(message)];
        if (!record) continue;
        const isError = record.state === 'error';
        const content = isError
            ? `自定义栏生成失败：${String(record.error ?? '未知错误')}\n点击下方“重新生成”可重试本楼。`
            : String(record.content ?? '').trim();
        const recordSettings = isError || typeof record.renderHtml !== 'boolean'
            ? settings
            : {
                ...settings,
                customPanel: { ...settings.customPanel, renderHtml: record.renderHtml },
            };
        const choices = isError || !Array.isArray(record.choices) ? [] : record.choices;
        if ((content || choices.length > 0)
            && safeRender(messageId, content, isError ? 'error' : 'ready', recordSettings, choices, render)) rendered++;
    }
    if (changed) {
        void Promise.resolve(context.saveMetadata?.())
            .catch(error => console.warn('[Memory Augment] Custom panel metadata cleanup failed.', error));
    }
    return rendered;
}

export function clearDeletedCustomPanelRecords(context, firstDeletedMessageId, { save = true } = {}) {
    const numericId = Number(firstDeletedMessageId);
    if (!Number.isInteger(numericId) || numericId < 0) return false;
    const store = getStore(context?.chatMetadata);
    let changed = false;
    for (const key of Object.keys(store)) {
        if (Number(key) >= numericId) {
            delete store[key];
            changed = true;
        }
    }
    if (changed && save) {
        void Promise.resolve(context.saveMetadata?.())
            .catch(error => console.warn('[Memory Augment] Deleted custom panel cleanup failed.', error));
    }
    return changed;
}

function scheduleGeneration(messageId, settings, options = {}) {
    setTimeout(() => {
        try {
            const context = globalThis.SillyTavern?.getContext?.();
            if (context) void handleCustomPanelGeneration(messageId, settings, context, {}, options);
        } catch (error) {
            console.warn('[Memory Augment] Custom panel scheduling failed.', error);
        }
    }, 0);
}

export function scheduleLatestCustomPanelGeneration(
    settings,
    context = globalThis.SillyTavern?.getContext?.(),
    generationOptions = {},
) {
    if (settings?.customPanel?.enabled !== true || !customPanelHasOutput(settings) || !context) {
        return false;
    }
    const messageId = findLatestEligibleAssistantMessageId(context);
    if (messageId < 0) return false;
    scheduleGeneration(messageId, settings, generationOptions);
    return true;
}

function clearRecoveryTimers() {
    for (const timer of recoveryTimers) clearTimeout(timer);
    recoveryTimers.clear();
}

function scheduleRecovery(settings) {
    const initial = globalThis.SillyTavern?.getContext?.();
    const expectedChatId = getChatId(initial);
    if (!initial) return;
    clearRecoveryTimers();
    for (const delay of CUSTOM_PANEL_RECOVERY_DELAYS) {
        const timer = setTimeout(() => {
            recoveryTimers.delete(timer);
            const context = globalThis.SillyTavern?.getContext?.();
            if (context && getChatId(context) === expectedChatId) scheduleLatestCustomPanelGeneration(settings, context);
        }, delay);
        recoveryTimers.add(timer);
    }
}

function scheduleDomRestore(settings, expectedChatId = getChatId(globalThis.SillyTavern?.getContext?.())) {
    for (const delay of CUSTOM_PANEL_DOM_DELAYS) {
        setTimeout(() => {
            const context = globalThis.SillyTavern?.getContext?.();
            if (context && getChatId(context) === expectedChatId) restoreStoredCustomPanels(context, settings);
        }, delay);
    }
}

function bindDomRecovery(settings) {
    if (domObserver || typeof MutationObserver === 'undefined') return;
    const chat = document.querySelector('#chat');
    if (!chat) return;
    domObserver = new MutationObserver(() => {
        clearTimeout(domTimer);
        domTimer = setTimeout(() => {
            const context = globalThis.SillyTavern?.getContext?.();
            if (context) restoreStoredCustomPanels(context, settings);
        }, 240);
    });
    domObserver.observe(chat, { childList: true, subtree: true });
}

export function fillStoryChoiceIntoComposer(text, documentRef = globalThis.document) {
    const value = String(text ?? '').trim();
    const textarea = documentRef?.querySelector?.('#send_textarea');
    if (!value || !textarea) return false;
    const current = String(textarea.value ?? '');
    const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : current.length;
    const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const leading = before && !/\s$/.test(before) ? '\n' : '';
    const trailing = after && !/^\s/.test(after) ? '\n' : '';
    const inserted = `${leading}${value}${trailing}`;
    const nextValue = `${before}${inserted}${after}`;
    const prototype = documentRef?.defaultView?.HTMLTextAreaElement?.prototype
        ?? globalThis.HTMLTextAreaElement?.prototype;
    const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set : null;
    if (setter) setter.call(textarea, nextValue);
    else textarea.value = nextValue;
    const EventRef = documentRef?.defaultView?.Event ?? globalThis.Event;
    if (typeof EventRef === 'function') {
        textarea.dispatchEvent(new EventRef('input', { bubbles: true }));
    }
    const cursor = before.length + inserted.length - trailing.length;
    try {
        textarea.focus({ preventScroll: true });
    } catch {
        textarea.focus?.();
    }
    textarea.setSelectionRange?.(cursor, cursor);
    return true;
}

function bindControls(settings) {
    if (controlsBound) return;
    const chat = document.querySelector('#chat');
    if (!chat) return;
    chat.addEventListener('click', (event) => {
        const panel = event.target.closest?.('.memory-augment-custom-panel');
        if (panel) event.stopPropagation();
        const choice = event.target.closest?.('.memory-augment-custom-panel-choice');
        if (choice) {
            event.preventDefault();
            event.stopPropagation();
            fillStoryChoiceIntoComposer(choice.dataset.choiceText, document);
            return;
        }
        const button = event.target.closest?.('.memory-augment-custom-panel-regenerate');
        const messageElement = button?.closest?.('.mes[mesid]');
        const messageId = Number(messageElement?.getAttribute('mesid'));
        if (!button || !Number.isInteger(messageId)) return;
        event.preventDefault();
        event.stopPropagation();
        const context = globalThis.SillyTavern?.getContext?.();
        const message = context?.chat?.[messageId];
        if (message) deleteCurrentRecord(context.chatMetadata, messageId, message);
        scheduleGeneration(messageId, settings, { force: true });
    });
    controlsBound = true;
}

export function refreshCustomPanelVisibility(settings, context = globalThis.SillyTavern?.getContext?.()) {
    if (typeof document === 'undefined') return;
    const enabled = settings?.customPanel?.enabled === true && customPanelHasOutput(settings);
    document.querySelectorAll('.memory-augment-custom-panel').forEach(panel => { panel.hidden = !enabled; });
    if (enabled && context) {
        restoreStoredCustomPanels(context, settings);
    }
}

export function initializeCustomPanelUi(settings) {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context) return false;
    const eventTypes = context.eventTypes ?? context.event_types ?? {};
    const rendered = eventTypes.CHARACTER_MESSAGE_RENDERED;
    const swiped = eventTypes.MESSAGE_SWIPED;
    const updated = eventTypes.MESSAGE_UPDATED;
    const deleted = eventTypes.MESSAGE_DELETED;
    const chatChanged = eventTypes.CHAT_CHANGED;
    const ended = eventTypes.GENERATION_ENDED;
    const stopped = eventTypes.GENERATION_STOPPED;

    if (!lifecycleBound) {
        if (rendered) context.eventSource.on(rendered, messageId => scheduleGeneration(messageId, settings));
        if (swiped) context.eventSource.on(swiped, (messageId) => {
            restoreStoredCustomPanels(globalThis.SillyTavern?.getContext?.(), settings);
            scheduleGeneration(messageId, settings);
        });
        if (updated) context.eventSource.on(updated, (messageId) => {
            const current = globalThis.SillyTavern?.getContext?.();
            const message = current?.chat?.[Number(messageId)];
            if (message && deleteCurrentRecord(current.chatMetadata, messageId, message)) {
                void Promise.resolve(current.saveMetadata?.());
            }
            scheduleGeneration(messageId, settings, { force: true });
        });
        if (deleted) context.eventSource.on(deleted, (messageId) => {
            clearDeletedCustomPanelRecords(globalThis.SillyTavern?.getContext?.(), messageId);
        });
        if (chatChanged) context.eventSource.on(chatChanged, () => {
            clearRecoveryTimers();
            setTimeout(() => {
                const current = globalThis.SillyTavern?.getContext?.();
                bindDomRecovery(settings);
                if (current) restoreStoredCustomPanels(current, settings);
            }, 0);
        });
        if (ended) context.eventSource.on(ended, () => scheduleRecovery(settings));
        if (stopped) context.eventSource.on(stopped, () => scheduleRecovery(settings));
    }
    bindControls(settings);
    bindDomRecovery(settings);
    restoreStoredCustomPanels(context, settings);
    lifecycleBound = true;
    scheduleLatestCustomPanelGeneration(settings, context);
    return true;
}

export { CUSTOM_PANEL_METADATA_KEY };
