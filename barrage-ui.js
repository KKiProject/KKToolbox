import { generateBarrage, rerankMemory, searchMemory } from './rag-client.js';
import { normalizeBaseUrl } from './api-utils.js';

const BARRAGE_METADATA_KEY = 'memory_augment_barrages';
const inFlight = new Map();
let barrageTemplate = '';

function clampInteger(value, fallback, minimum, maximum) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function completeApiConfig(config) {
    const normalized = {
        baseUrl: normalizeBaseUrl(config?.url ?? config?.baseUrl),
        apiKey: String(config?.apiKey ?? '').trim(),
        model: String(config?.model ?? '').trim(),
    };
    return normalized.baseUrl && normalized.apiKey && normalized.model ? normalized : null;
}

function getChatId(context) {
    return context?.getCurrentChatId?.() ?? context?.chatId;
}

function textHash(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function getBarrageStore(metadata, create = false) {
    const existing = metadata?.[BARRAGE_METADATA_KEY];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        return existing;
    }
    if (create && metadata && typeof metadata === 'object') {
        metadata[BARRAGE_METADATA_KEY] = {};
        return metadata[BARRAGE_METADATA_KEY];
    }
    return {};
}

export function collectRecentMessages(chat, messageId, count) {
    const end = Math.min(chat.length, Number(messageId) + 1);
    const start = Math.max(0, end - clampInteger(count, 5, 1, 20));
    return chat.slice(start, end)
        .map((message, offset) => ({
            id: start + offset,
            name: String(message?.name ?? (message?.is_user ? '用户' : '角色')),
            role: message?.is_user ? 'user' : 'assistant',
            text: String(message?.mes ?? '').trim(),
        }))
        .filter(message => message.text);
}

async function getRagFragments(settings, context, recentMessages, clients) {
    if (!settings?.barrage?.includeRag) {
        return [];
    }

    const embedding = completeApiConfig(settings?.apis?.embedding);
    const chatId = getChatId(context);
    const query = recentMessages.slice(-3).map(message => message.text).join('\n\n');
    if (!embedding || !chatId || !query) {
        return [];
    }

    const topK = clampInteger(settings?.rag?.topK, 20, 1, 100);
    const topN = clampInteger(settings?.rag?.topN, 5, 1, Math.min(50, topK));
    const search = clients.searchMemory ?? searchMemory;
    const worldInfoKeys = Array.isArray(settings?.rag?.semanticWorldInfoEntries)
        ? settings.rag.semanticWorldInfoEntries.map(String)
        : [];
    const includeWorldInfo = Boolean(settings?.rag?.semanticWorldInfo && worldInfoKeys.length > 0);
    const searchResponse = await search({
        chatId,
        query,
        topK,
        embedding,
        types: includeWorldInfo ? ['chat', 'worldinfo'] : ['chat'],
        worldInfoKeys: includeWorldInfo ? worldInfoKeys : [],
    });
    let results = Array.isArray(searchResponse?.results) ? searchResponse.results : [];
    const reranker = completeApiConfig(settings?.apis?.reranker);

    if (reranker && results.length > 0) {
        try {
            const rerank = clients.rerankMemory ?? rerankMemory;
            const rerankResponse = await rerank({
                query,
                candidates: results,
                topN,
                threshold: Number(settings?.rag?.rerankerThreshold) || 0,
                reranker,
            });
            results = Array.isArray(rerankResponse?.results) ? rerankResponse.results : [];
        } catch (error) {
            console.warn('[Memory Augment] Barrage RAG reranking failed; using vector order.', error);
        }
    }

    return results.slice(0, topN).map(result => ({
        id: result.id,
        summary_tag: result.summary_tag,
        text: String(result.text ?? '').trim(),
    })).filter(fragment => fragment.text);
}

function createPanelFromTemplate() {
    const template = document.createElement('template');
    template.innerHTML = barrageTemplate.trim();
    return template.content.firstElementChild;
}

export function renderBarragePanel(messageId, content, state = 'ready') {
    const numericId = Number(messageId);
    if (!Number.isInteger(numericId)) {
        return false;
    }

    const messageElement = document.querySelector(`#chat .mes[mesid="${numericId}"]`);
    const messageBlock = messageElement?.querySelector('.mes_block');
    if (!messageBlock || !barrageTemplate) {
        return false;
    }

    let panel = messageBlock.querySelector('.memory-augment-barrage');
    if (!panel) {
        panel = createPanelFromTemplate();
        messageBlock.append(panel);
    }

    panel.hidden = false;
    panel.classList.toggle('is-loading', state === 'loading');
    panel.classList.toggle('is-error', state === 'error');
    const status = panel.querySelector('.memory-augment-barrage-status');
    const body = panel.querySelector('.memory-augment-barrage-content');
    if (status) {
        status.textContent = state === 'loading' ? '生成中…' : state === 'error' ? '生成失败' : '';
    }
    if (body) {
        body.textContent = content;
    }
    return true;
}

export async function handleCharacterMessageRendered(messageId, settings, context, dependencies = {}) {
    const numericId = Number(messageId);
    const message = Number.isInteger(numericId) ? context?.chat?.[numericId] : null;
    if (!settings?.barrage?.enabled || !message || message.is_user || message.is_system) {
        return { generated: false, reason: 'disabled-or-ineligible' };
    }

    const barrage = completeApiConfig(settings?.apis?.barrage);
    if (!barrage) {
        return { generated: false, reason: 'missing-config' };
    }

    const chatId = getChatId(context);
    const sourceHash = textHash(message.mes);
    const render = dependencies.renderBarrage ?? renderBarragePanel;
    const store = getBarrageStore(context.chatMetadata);
    const cached = store[String(numericId)];
    if (cached?.sourceHash === sourceHash && cached?.content) {
        render(numericId, cached.content, 'ready');
        return { generated: false, cached: true };
    }

    const requestKey = `${chatId}:${numericId}:${sourceHash}`;
    if (inFlight.has(requestKey)) {
        return inFlight.get(requestKey);
    }

    const task = (async () => {
        render(numericId, '正在生成观众弹幕…', 'loading');
        const recentMessages = collectRecentMessages(
            context.chat,
            numericId,
            settings.barrage.recentMessages,
        );
        let ragFragments = [];
        try {
            ragFragments = await getRagFragments(settings, context, recentMessages, dependencies);
        } catch (error) {
            console.warn('[Memory Augment] Barrage RAG lookup failed; continuing without history.', error);
        }

        const request = dependencies.generateBarrage ?? generateBarrage;
        const response = await request({
            barrage,
            systemPrompt: String(settings.barrage.systemPrompt ?? '').trim(),
            recentMessages,
            ragFragments,
        });
        const content = String(response?.content ?? '').trim();
        if (!content) {
            throw new Error('Barrage endpoint returned empty content.');
        }

        const currentContext = dependencies.getCurrentContext?.() ?? SillyTavern.getContext();
        const currentMessage = currentContext.chat?.[numericId];
        if (getChatId(currentContext) !== chatId || textHash(currentMessage?.mes) !== sourceHash) {
            return { generated: false, discarded: true };
        }

        render(numericId, content, 'ready');
        const currentStore = getBarrageStore(currentContext.chatMetadata, true);
        currentStore[String(numericId)] = {
            content,
            sourceHash,
            createdAt: new Date().toISOString(),
        };
        await currentContext.saveMetadata?.();
        return { generated: true, content, ragCount: ragFragments.length };
    })().catch((error) => {
        render(numericId, `弹幕生成失败：${error.message}`, 'error');
        console.error('[Memory Augment] Barrage generation failed.', error);
        return { generated: false, error };
    }).finally(() => inFlight.delete(requestKey));

    inFlight.set(requestKey, task);
    return task;
}

function restoreStoredBarrages(context) {
    const store = getBarrageStore(context.chatMetadata);
    for (const [messageId, record] of Object.entries(store)) {
        const message = context.chat?.[Number(messageId)];
        if (message && record?.sourceHash === textHash(message.mes) && record?.content) {
            renderBarragePanel(messageId, record.content, 'ready');
        }
    }
}

export async function initializeBarrageUi(settings, options = {}) {
    const context = SillyTavern.getContext();
    barrageTemplate = await context.renderExtensionTemplateAsync(options.templatePath, 'barrage');
    const messageRendered = context.eventTypes?.CHARACTER_MESSAGE_RENDERED
        ?? context.event_types?.CHARACTER_MESSAGE_RENDERED;
    const chatChanged = context.eventTypes?.CHAT_CHANGED ?? context.event_types?.CHAT_CHANGED;

    if (!messageRendered) {
        console.error('[Memory Augment] CHARACTER_MESSAGE_RENDERED event is unavailable for barrage UI.');
        return;
    }

    context.eventSource.on(messageRendered, (messageId) => {
        const currentContext = SillyTavern.getContext();
        void handleCharacterMessageRendered(messageId, settings, currentContext);
    });

    if (chatChanged) {
        context.eventSource.on(chatChanged, () => {
            setTimeout(() => restoreStoredBarrages(SillyTavern.getContext()), 0);
        });
    }

    restoreStoredBarrages(context);
}

export { BARRAGE_METADATA_KEY };
