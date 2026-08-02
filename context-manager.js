import { rerankMemory, searchMemory } from './rag-client.js';
import { normalizeBaseUrl } from './api-utils.js';
import { getActiveWorldInfoBookIds } from './world-info-manager.js';
import { getMessageTimelineMetadata, injectLatestStoryStatus } from './story-status.js';
import { injectMapAtlasContext } from './map-atlas.js';
import { injectCharacterDevelopment } from './character-development.js';

const EXTENSION_KEY = 'st-memory-augment';
const MEMORY_MARKER = 'memory_augment_rag';
const WORLD_INFO_TOP_K = 7;
const WORLD_INFO_TOP_N = 3;
const MEMORY_TIMELINE_GUARD = [
    '【历史召回附录】',
    '以下片段来自较早楼层，是根据当前内容检索出的可能相关历史。它们可能有用，也可能无关，仅供参考，不要求必须采用。',
    '若片段确与当前情境相关，应据此保持人物认知、事实与因果连续性；若无关则忽略。',
    '这些片段不是当前正在发生的场景，不得因此回退时间线或重复已经发生的事件。',
    '如与最近原文冲突，以最近原文和较晚楼层为准。',
].join('\n');

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

function formatTemporalRecall(result, context, messageId) {
    const timeline = getMessageTimelineMetadata(context, Number(messageId));
    const matchingSegment = timeline?.segments?.find(segment => result?.timeline_anchor_id
        && String(segment?.anchorId) === String(result.timeline_anchor_id));
    const sceneTime = String(result?.timeline_time
        ?? matchingSegment?.anchorLabel
        ?? timeline?.sceneTime
        ?? '').trim();
    const mainlineTime = String(result?.timeline_mainline_time ?? timeline?.mainlineTime ?? '').trim();
    const isPrecedingAnchor = result?.timeline_anchor_id
        && String(result.timeline_anchor_id) === String(timeline?.precedingSceneAnchorId);
    const relation = String(matchingSegment?.relationToCurrent
        ?? (isPrecedingAnchor ? timeline?.precedingRelationToCurrent : timeline?.relationToCurrent)
        ?? '').trim();
    if (!sceneTime && !mainlineTime && !relation) return '';
    return [
        '[该片段的历史时间锚点]',
        sceneTime && `当时场景：${sceneTime}`,
        mainlineTime && `当时主线：${mainlineTime}`,
        relation && `与当前主线：${relation}`,
        '片段内“今天、昨天、三天前”等相对时间均以这个历史锚点为基准，不得按当前回合重新解释。',
    ].filter(Boolean).join('；');
}

export function formatMemoryMessage(results, context = null) {
    const getMessageIds = result => result?.message_id !== undefined
        ? [result.message_id]
        : Array.isArray(result?.message_ids) ? result.message_ids : [];
    const sorted = [...results].sort((left, right) => {
        const leftId = getMessageIds(left)[0] ?? Number.MAX_SAFE_INTEGER;
        const rightId = getMessageIds(right)[0] ?? Number.MAX_SAFE_INTEGER;
        const floorOrder = String(leftId).localeCompare(String(rightId), undefined, { numeric: true });
        return floorOrder || (Number(left?.segment_index) || 0) - (Number(right?.segment_index) || 0);
    });
    const fragments = sorted.map((result) => {
        const text = String(result?.text ?? '').trim();
        if (!text) {
            return '';
        }
        const ids = getMessageIds(result);
        const floor = ids.length > 1 ? `${ids[0]}-${ids.at(-1)}` : ids[0];
        const label = floor !== undefined
            ? `[记忆召回-第${floor}楼]`
            : '[记忆召回]';
        const temporal = formatTemporalRecall(result, context, ids[0]);
        return temporal ? `${label}\n${temporal}\n${text}` : `${label} ${text}`;
    }).filter(Boolean);
    if (fragments.length === 0) {
        return null;
    }
    const content = `${MEMORY_TIMELINE_GUARD}\n\n${fragments.join('\n\n')}`;
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
            memory_augment_recall_type: 'chat',
        },
    };
}

export function formatWorldInfoMessage(results) {
    const fragments = [...results]
        .sort((left, right) => String(left?.book_id ?? left?.world_info_book ?? '')
            .localeCompare(String(right?.book_id ?? right?.world_info_book ?? ''), undefined, { numeric: true })
            || String(left?.entry_uid ?? left?.world_info_id ?? '')
                .localeCompare(String(right?.entry_uid ?? right?.world_info_id ?? ''), undefined, { numeric: true })
            || (Number(left?.segment_index) || 0) - (Number(right?.segment_index) || 0))
        .map((result) => {
            const book = String(result?.book_id ?? result?.world_info_book ?? '世界书').trim();
            const text = String(result?.text ?? '').trim();
            return text ? `[设定召回-${book}] ${text}` : '';
        })
        .filter(Boolean);
    if (fragments.length === 0) return null;
    const content = fragments.join('\n\n');
    return {
        role: 'system', content, name: 'Memory Augment', is_user: false, is_system: false, mes: content,
        extra: { type: 'narrator', [MEMORY_MARKER]: true, memory_augment_recall_type: 'worldinfo' },
    };
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

async function selectRecallResults({
    candidates,
    query,
    topN,
    threshold,
    reranker,
    rerank,
    source,
}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return { results: [], usedReranker: false };
    }
    if (!reranker) {
        return { results: candidates.slice(0, topN), usedReranker: false };
    }

    try {
        const response = await rerank({
            query,
            candidates,
            topN,
            threshold,
            reranker,
        });
        return {
            results: Array.isArray(response?.results) ? response.results.slice(0, topN) : [],
            usedReranker: true,
        };
    } catch (error) {
        console.warn(`[Memory Augment] ${source} reranking failed; using vector search order.`, error);
        return { results: candidates.slice(0, topN), usedReranker: false };
    }
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
    const recentMessages = clampInteger(settings?.context?.recentMessages, 20, 1, 1000);
    const persistentChatLength = Array.isArray(context?.chat) ? context.chat.length : chat.length;
    const chatMessageIdBefore = Math.max(0, persistentChatLength - recentMessages);
    const search = clients.searchMemory ?? searchMemory;
    const rerank = clients.rerankMemory ?? rerankMemory;
    const activeBookIds = Array.isArray(settings?.rag?.activeWorldInfoBookIds)
        ? settings.rag.activeWorldInfoBookIds.map(String)
        : getActiveWorldInfoBookIds();
    const semanticWorldInfo = Boolean(settings?.rag?.semanticWorldInfo && activeBookIds.length > 0);
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
            book_ids: semanticWorldInfo ? activeBookIds : [],
        },
    });
    if (searchResponse?.errors?.chat) {
        console.warn(`[Memory Augment] Chat vector search failed: ${searchResponse.errors.chat}`);
    }
    if (searchResponse?.errors?.worldinfo) {
        console.warn(`[Memory Augment] World info vector search failed: ${searchResponse.errors.worldinfo}`);
    }
    const legacyCandidates = Array.isArray(searchResponse?.results) ? searchResponse.results : [];
    const chatCandidates = Array.isArray(searchResponse?.chatResults)
        ? searchResponse.chatResults
        : legacyCandidates.filter(result => result.type !== 'worldinfo');
    const worldInfoCandidates = semanticWorldInfo
        ? Array.isArray(searchResponse?.worldInfoResults)
            ? searchResponse.worldInfoResults
            : legacyCandidates.filter(result => result.type === 'worldinfo')
        : [];
    if (chatCandidates.length === 0 && worldInfoCandidates.length === 0) {
        return { injected: false, reason: 'no-results' };
    }

    const reranker = completeApiConfig(settings?.apis?.reranker);
    const [chatSelection, worldInfoSelection] = await Promise.all([
        selectRecallResults({
            candidates: chatCandidates,
            query,
            topN,
            threshold,
            reranker,
            rerank,
            source: 'Chat memory',
        }),
        selectRecallResults({
            candidates: worldInfoCandidates,
            query,
            topN: WORLD_INFO_TOP_N,
            threshold,
            reranker,
            rerank,
            source: 'World info',
        }),
    ]);
    const usedReranker = chatSelection.usedReranker || worldInfoSelection.usedReranker;
    const worldInfoMessage = semanticWorldInfo
        ? formatWorldInfoMessage(worldInfoSelection.results)
        : null;
    const memoryMessage = formatMemoryMessage(chatSelection.results, context);
    const recallMessages = [worldInfoMessage, memoryMessage].filter(Boolean);
    if (recallMessages.length === 0) {
        return { injected: false, reason: 'filtered', usedReranker };
    }

    const insertionIndex = Math.max(0, chat.length - 2);
    chat.splice(insertionIndex, 0, ...recallMessages);
    return {
        injected: true,
        insertionIndex,
        resultCount: chatSelection.results.length + worldInfoSelection.results.length,
        chatResultCount: chatSelection.results.length,
        worldInfoResultCount: worldInfoSelection.results.length,
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
        await retrieveAndInject(generationChat, settings, context);
    } catch (error) {
        console.error('[Memory Augment] RAG interceptor failed; generation will continue without memory injection.', error);
    }

    try {
        injectMapAtlasContext(generationChat, settings, context);
    } catch (error) {
        console.error('[Memory Augment] Map atlas injection failed; generation will continue without it.', error);
    }

    try {
        injectCharacterDevelopment(generationChat, context);
    } catch (error) {
        console.error('[Memory Augment] Character development injection failed; generation will continue without it.', error);
    }

    try {
        injectLatestStoryStatus(generationChat, context);
    } catch (error) {
        console.error('[Memory Augment] Story status injection failed; generation will continue without it.', error);
    }

    chat.splice(0, chat.length, ...generationChat);
}
