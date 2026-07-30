import { generateBarrage, rerankMemory, searchMemory } from './rag-client.js';
import { normalizeBaseUrl } from './api-utils.js';
import { getActiveWorldInfoBookIds } from './world-info-manager.js';

const BARRAGE_METADATA_KEY = 'memory_augment_barrages';
const WORLD_INFO_TOP_K = 7;
const WORLD_INFO_TOP_N = 3;
const inFlight = new Map();
let barrageTemplate = '';
let regenerationBound = false;

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

function normalizeStoredBarrage(record) {
    const content = String(record?.content ?? '').trim();
    if (!content) {
        return null;
    }

    const existingTimestamp = Math.trunc(Number(record?.timestamp));
    const legacyTimestamp = Math.floor(Date.parse(record?.createdAt) / 1000);
    return {
        content,
        timestamp: Number.isInteger(existingTimestamp) && existingTimestamp > 0
            ? existingTimestamp
            : Number.isInteger(legacyTimestamp) && legacyTimestamp > 0
                ? legacyTimestamp
                : Math.floor(Date.now() / 1000),
    };
}

export function collectRecentMessages(chat, messageId, count) {
    const end = Math.min(chat.length, Number(messageId) + 1);
    // Keep N preceding floors plus the rendered AI floor, which the server
    // separates into the emphasized "latest chapter" section.
    const start = Math.max(0, end - clampInteger(count, 5, 1, 20) - 1);
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
    const rawRecentMessages = clampInteger(settings?.context?.recentMessages, 20, 1, 1000);
    const chatMessageIdBefore = Math.max(0, (context?.chat?.length ?? 0) - rawRecentMessages);
    const search = clients.searchMemory ?? searchMemory;
    const activeBookIds = Array.isArray(settings?.rag?.activeWorldInfoBookIds)
        ? settings.rag.activeWorldInfoBookIds.map(String)
        : getActiveWorldInfoBookIds();
    const includeWorldInfo = Boolean(settings?.rag?.semanticWorldInfo && activeBookIds.length > 0);
    const searchResponse = await search({
        chatId,
        query,
        separate: true,
        chatTopK: topK,
        worldInfoTopK: WORLD_INFO_TOP_K,
        embedding,
        scope: {
            chat_id: chatId,
            chat_message_id_before: chatMessageIdBefore,
            book_ids: includeWorldInfo ? activeBookIds : [],
        },
    });
    const legacyResults = Array.isArray(searchResponse?.results) ? searchResponse.results : [];
    let chatResults = Array.isArray(searchResponse?.chatResults)
        ? searchResponse.chatResults
        : legacyResults.filter(result => result.type !== 'worldinfo');
    let worldInfoResults = includeWorldInfo
        ? Array.isArray(searchResponse?.worldInfoResults)
            ? searchResponse.worldInfoResults
            : legacyResults.filter(result => result.type === 'worldinfo')
        : [];
    const reranker = completeApiConfig(settings?.apis?.reranker);

    if (reranker) {
        const rerank = clients.rerankMemory ?? rerankMemory;
        const rerankSource = async (candidates, limit, label) => {
            if (candidates.length === 0) return [];
            try {
                const rerankResponse = await rerank({
                    query,
                    candidates,
                    topN: limit,
                    threshold: Number(settings?.rag?.rerankerThreshold) || 0,
                    reranker,
                });
                return Array.isArray(rerankResponse?.results)
                    ? rerankResponse.results.slice(0, limit)
                    : [];
            } catch (error) {
                console.warn(`[Memory Augment] Barrage ${label} RAG reranking failed; using vector order.`, error);
                return candidates.slice(0, limit);
            }
        };
        [chatResults, worldInfoResults] = await Promise.all([
            rerankSource(chatResults, topN, 'chat'),
            rerankSource(worldInfoResults, WORLD_INFO_TOP_N, 'world info'),
        ]);
    } else {
        chatResults = chatResults.slice(0, topN);
        worldInfoResults = worldInfoResults.slice(0, WORLD_INFO_TOP_N);
    }

    return [...worldInfoResults, ...chatResults].map(result => ({
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

function safelyRender(render, messageId, content, state) {
    try {
        return render(messageId, content, state);
    } catch (error) {
        console.warn('[Memory Augment] Barrage rendering failed.', error);
        return false;
    }
}

export async function handleCharacterMessageRendered(messageId, settings, context, dependencies = {}, options = {}) {
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
    if (!options.force && cached?.content) {
        safelyRender(render, numericId, cached.content, 'ready');
        return { generated: false, cached: true };
    }
    if (options.force && cached) {
        delete store[String(numericId)];
        try {
            await context.saveMetadata?.();
        } catch (error) {
            console.warn('[Memory Augment] Stale barrage removal save failed.', error);
        }
    }

    const requestKey = `${chatId}:${numericId}:${sourceHash}`;
    if (inFlight.has(requestKey)) {
        return inFlight.get(requestKey);
    }

    const task = (async () => {
        safelyRender(render, numericId, '正在生成观众弹幕…', 'loading');
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
            maxTokens: settings.barrage.maxTokens,
            recentMessages,
            ragFragments,
        });
        const content = String(response?.content ?? '').trim();
        if (!content) {
            throw new Error('Barrage endpoint returned empty content.');
        }

        const currentContext = dependencies.getCurrentContext?.()
            ?? globalThis.SillyTavern?.getContext?.()
            ?? context;
        const currentMessage = currentContext.chat?.[numericId];
        if (getChatId(currentContext) !== chatId || textHash(currentMessage?.mes) !== sourceHash) {
            return { generated: false, discarded: true };
        }

        safelyRender(render, numericId, content, 'ready');
        const currentStore = getBarrageStore(currentContext.chatMetadata, true);
        currentStore[String(numericId)] = {
            content,
            timestamp: Math.floor(Date.now() / 1000),
        };
        try {
            await currentContext.saveMetadata?.();
        } catch (error) {
            console.warn('[Memory Augment] Barrage metadata save failed.', error);
        }
        return { generated: true, content, ragCount: ragFragments.length };
    })().catch((error) => {
        const currentContext = dependencies.getCurrentContext?.()
            ?? globalThis.SillyTavern?.getContext?.()
            ?? context;
        const currentMessage = currentContext.chat?.[numericId];
        if (getChatId(currentContext) === chatId && textHash(currentMessage?.mes) === sourceHash) {
            const detail = String(error?.message ?? error ?? '未知错误').trim();
            safelyRender(render, numericId, `弹幕生成失败：${detail}`, 'error');
        }
        console.warn('[Memory Augment] Barrage generation failed.', error);
        return { generated: false, error };
    }).finally(() => inFlight.delete(requestKey));

    inFlight.set(requestKey, task);
    return task;
}

function restoreStoredBarrages(context) {
    const store = getBarrageStore(context.chatMetadata);
    let migrated = false;
    for (const [messageId, record] of Object.entries(store)) {
        const message = context.chat?.[Number(messageId)];
        const normalized = normalizeStoredBarrage(record);
        if (!normalized) {
            continue;
        }
        if (record.content !== normalized.content
            || record.timestamp !== normalized.timestamp
            || Object.keys(record).some(key => key !== 'content' && key !== 'timestamp')) {
            store[messageId] = normalized;
            migrated = true;
        }
        if (message && !message.is_user && !message.is_system) {
            safelyRender(renderBarragePanel, messageId, normalized.content, 'ready');
        }
    }
    if (migrated) {
        void Promise.resolve(context.saveMetadata?.())
            .catch(error => console.warn('[Memory Augment] Barrage metadata migration save failed.', error));
    }
}

function scheduleBarrageGeneration(messageId, settings, options = {}) {
    setTimeout(() => {
        try {
            const currentContext = SillyTavern.getContext();
            void handleCharacterMessageRendered(messageId, settings, currentContext, {}, options)
                .catch(error => console.warn('[Memory Augment] Barrage task failed.', error));
        } catch (error) {
            console.warn('[Memory Augment] Barrage scheduling failed.', error);
        }
    }, 0);
}

function bindRegeneration(settings) {
    if (regenerationBound) {
        return;
    }

    const chat = document.querySelector('#chat');
    if (!chat) {
        return;
    }

    chat.addEventListener('click', (event) => {
        const button = event.target.closest?.('.memory-augment-barrage-regenerate');
        const messageElement = button?.closest?.('.mes[mesid]');
        const messageId = Number(messageElement?.getAttribute('mesid'));
        if (!button || !Number.isInteger(messageId)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        scheduleBarrageGeneration(messageId, settings, { force: true });
    });
    regenerationBound = true;
}

export async function initializeBarrageUi(settings, options = {}) {
    const context = SillyTavern.getContext();
    try {
        barrageTemplate = await context.renderExtensionTemplateAsync(options.templatePath, 'barrage');
    } catch (error) {
        console.warn('[Memory Augment] Barrage template loading failed.', error);
        return;
    }
    const messageRendered = context.eventTypes?.CHARACTER_MESSAGE_RENDERED
        ?? context.event_types?.CHARACTER_MESSAGE_RENDERED;
    const chatChanged = context.eventTypes?.CHAT_CHANGED ?? context.event_types?.CHAT_CHANGED;

    if (!messageRendered) {
        console.warn('[Memory Augment] CHARACTER_MESSAGE_RENDERED event is unavailable for barrage UI.');
        return;
    }

    context.eventSource.on(messageRendered, (messageId) => {
        scheduleBarrageGeneration(messageId, settings, { force: true });
    });

    if (chatChanged) {
        context.eventSource.on(chatChanged, () => {
            setTimeout(() => {
                try {
                    restoreStoredBarrages(SillyTavern.getContext());
                } catch (error) {
                    console.warn('[Memory Augment] Stored barrage restoration failed.', error);
                }
            }, 0);
        });
    }

    bindRegeneration(settings);
    try {
        restoreStoredBarrages(context);
    } catch (error) {
        console.warn('[Memory Augment] Stored barrage restoration failed.', error);
    }
}

export { BARRAGE_METADATA_KEY };
