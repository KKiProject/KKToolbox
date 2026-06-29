import { rerankMemory, searchMemory } from './rag-client.js';
import { normalizeBaseUrl } from './api-utils.js';

const EXTENSION_KEY = 'st-memory-augment';
const MEMORY_MARKER = 'memory_augment_rag';

function clampInteger(value, fallback, minimum, maximum) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function clampNumber(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function getMessageText(message) {
    return String(message?.mes ?? message?.content ?? '').trim();
}

function completeApiConfig(config) {
    const normalized = {
        baseUrl: normalizeBaseUrl(config?.url ?? config?.baseUrl),
        apiKey: String(config?.apiKey ?? '').trim(),
        model: String(config?.model ?? '').trim(),
    };

    return normalized.baseUrl && normalized.apiKey && normalized.model ? normalized : null;
}

export function buildRagQuery(chat, messageCount = 3) {
    return chat
        .filter(message => !message?.extra?.[MEMORY_MARKER])
        .map(getMessageText)
        .filter(Boolean)
        .slice(-clampInteger(messageCount, 3, 2, 3))
        .join('\n\n');
}

function formatRecallMessage(results, prefix, intro, kind) {
    const fragments = results
        .map((result, index) => {
            const tag = String(result?.summary_tag ?? '').trim();
            const text = String(result?.text ?? '').trim();
            if (!text) {
                return '';
            }
            return [`[片段 ${index + 1}]`, tag, text].filter(Boolean).join('\n');
        })
        .filter(Boolean);

    if (fragments.length === 0) {
        return null;
    }

    const content = `${prefix} ${intro}\n\n${fragments.join('\n\n')}`;
    return {
        role: 'system',
        content,
        name: 'Memory Augment',
        is_user: false,
        is_system: false,
        mes: content,
        extra: {
            type: 'narrator',
            [MEMORY_MARKER]: true,
            memory_augment_recall_type: kind,
        },
    };
}

export function formatMemoryMessage(results) {
    return formatRecallMessage(results, '[记忆召回]', '以下是与当前对话相关的历史片段：', 'chat');
}

export function formatWorldInfoMessage(results) {
    return formatRecallMessage(results, '[设定召回]', '以下是与当前对话语义相关的世界设定：', 'worldinfo');
}

function isMemoryMessage(message) {
    return Boolean(message?.extra?.[MEMORY_MARKER]);
}

function cloneGenerationChat(chat) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(chat);
        } catch (error) {
            console.warn('[Memory Augment] structuredClone failed; falling back to JSON cloning.', error);
        }
    }
    return JSON.parse(JSON.stringify(chat));
}

export function compressGenerationChat(chat, recentMessageCount) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return { removed: 0, summaryCount: 0 };
    }

    const recentCount = clampInteger(recentMessageCount, 5, 1, 20);
    const hasOriginalIndices = chat.some(message => Number.isInteger(message?.index));
    const isOriginal = (message) => {
        if (isMemoryMessage(message)) {
            return false;
        }
        if (hasOriginalIndices) {
            return Number.isInteger(message?.index);
        }
        return message?.extra?.type !== 'narrator' && message?.role !== 'system';
    };

    const originalMessages = chat.filter(isOriginal);
    const recentMessages = originalMessages.slice(-recentCount);
    const oldMessages = originalMessages.slice(0, Math.max(0, originalMessages.length - recentCount));
    const ragMessages = chat.filter(isMemoryMessage);
    const auxiliaryMessages = chat.filter(message => !isOriginal(message)
        && !isMemoryMessage(message));
    const replacement = [
        ...auxiliaryMessages,
        ...ragMessages,
        ...recentMessages,
    ];

    chat.splice(0, chat.length, ...replacement);
    return {
        removed: oldMessages.length,
        retained: recentMessages.length,
    };
}

export async function retrieveAndInject(chat, settings, context, clients = {}) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return { injected: false, reason: 'empty-chat' };
    }

    const embedding = completeApiConfig(settings?.apis?.embedding);
    const chatId = context?.getCurrentChatId?.() ?? context?.chatId;
    const query = buildRagQuery(chat, 3);
    if (!embedding || !chatId || !query) {
        return { injected: false, reason: 'missing-input' };
    }

    const topK = clampInteger(settings?.rag?.topK, 20, 1, 100);
    const topN = clampInteger(settings?.rag?.topN, 5, 1, Math.min(50, topK));
    const threshold = clampNumber(settings?.rag?.rerankerThreshold, 0.3, 0, 1);
    const recentMessages = clampInteger(settings?.context?.recentMessages, 5, 1, 20);
    const search = clients.searchMemory ?? searchMemory;
    const rerank = clients.rerankMemory ?? rerankMemory;
    const worldInfoKeys = Array.isArray(settings?.rag?.semanticWorldInfoEntries)
        ? settings.rag.semanticWorldInfoEntries.map(String)
        : [];
    const semanticWorldInfo = Boolean(settings?.rag?.semanticWorldInfo && worldInfoKeys.length > 0);
    const searchResponse = await search({
        chatId,
        query,
        topK,
        embedding,
        types: semanticWorldInfo ? ['chat', 'worldinfo'] : ['chat'],
        worldInfoKeys: semanticWorldInfo ? worldInfoKeys : [],
    });
    const candidates = Array.isArray(searchResponse?.results) ? searchResponse.results : [];
    if (candidates.length === 0) {
        return { injected: false, reason: 'no-results' };
    }

    const reranker = completeApiConfig(settings?.apis?.reranker);
    let results = candidates.slice(0, topN);
    let usedReranker = false;

    if (reranker) {
        try {
            const rerankResponse = await rerank({
                query,
                candidates,
                topN,
                threshold,
                reranker,
            });
            results = Array.isArray(rerankResponse?.results) ? rerankResponse.results : [];
            usedReranker = true;
        } catch (error) {
            console.warn('[Memory Augment] Reranker failed; using vector search order.', error);
        }
    }

    const selectedResults = results.slice(0, topN);
    const worldInfoMessage = semanticWorldInfo
        ? formatWorldInfoMessage(selectedResults.filter(result => result.type === 'worldinfo'))
        : null;
    const memoryMessage = formatMemoryMessage(selectedResults.filter(result => result.type !== 'worldinfo'));
    const recallMessages = [worldInfoMessage, memoryMessage].filter(Boolean);
    if (recallMessages.length === 0) {
        return { injected: false, reason: 'filtered', usedReranker };
    }

    const insertionIndex = Math.max(0, chat.length - recentMessages);
    chat.splice(insertionIndex, 0, ...recallMessages);
    return {
        injected: true,
        insertionIndex,
        resultCount: selectedResults.length,
        usedReranker,
    };
}

/**
 * Adds relevant historical chunks to ST's generation-only chat copy. The
 * persistent context.chat array is not modified.
 *
 * @param {Array<object>} chat Generation message list.
 * @param {number} contextSize Available context size.
 * @param {(immediately: boolean) => void} abort Generation abort callback.
 * @param {string} type Generation type.
 * @returns {Promise<void>}
 */
export async function memoryAugmentInterceptor(chat, contextSize, abort, type) {
    void contextSize;
    void abort;

    if (type === 'quiet') {
        return;
    }

    const context = SillyTavern.getContext();
    const settings = context.extensionSettings?.[EXTENSION_KEY];
    if (!settings || chat === context.chat) {
        if (chat === context.chat) {
            console.error('[Memory Augment] Refusing to modify persistent context.chat.');
        }
        return;
    }

    // ST normally supplies a generation-only array. Clone its messages as well,
    // so nested objects shared with context.chat can never be changed by us.
    const generationChat = cloneGenerationChat(chat);

    try {
        compressGenerationChat(generationChat, settings.context?.recentMessages);
    } catch (error) {
        console.error('[Memory Augment] Context compression failed; generation will continue without compression.', error);
    }

    try {
        await retrieveAndInject(generationChat, settings, context);
    } catch (error) {
        console.error('[Memory Augment] RAG interceptor failed; generation will continue without memory injection.', error);
    }

    chat.splice(0, chat.length, ...generationChat);
}
