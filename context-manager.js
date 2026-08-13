import {
    rerankMemory,
    searchMemory,
    searchSummaryMemory,
    syncSummaryMemory,
} from './rag-client.js';
import { normalizeBaseUrl } from './api-utils.js';
import { getActiveWorldInfoBookIds, isManagedSummaryWorldInfoBookName } from './world-info-manager.js';
import { getMessageTimelineMetadata, injectLatestStoryStatus } from './story-status.js';
import { injectMapAtlasContext } from './map-atlas.js';
import { injectCharacterDevelopment } from './character-development.js';
import { getSummaries } from './summary-manager.js';
import { injectPhoneContext, loadPhoneStore } from './phone-store.js';
import { recallPhoneMemoryEvents } from './phone-memory-recall.js';
import {
    beginGenerationPreparation,
    completeGenerationPreparation,
    recordGenerationTimingStage,
} from './generation-timing.js';

const EXTENSION_KEY = 'st-memory-augment';
const MEMORY_MARKER = 'memory_augment_rag';
const WORLD_INFO_TOP_K = 10;
const WORLD_INFO_TOP_N = 5;
const SUMMARY_TOP_K = 10;
const SUMMARY_TOP_N = 3;
const RECENT_SUMMARY_COUNT = 5;
const CHAT_GLOBAL_FALLBACK_K = 3;
const summarySyncSignatures = new Map();
const sharedRecallBundles = new Map();
const postGenerationRecallPromises = new Map();
const postGenerationRecallResults = new Map();
const recallClientIds = new WeakMap();
let nextRecallClientId = 1;
const SHARED_RECALL_TTL_MS = 10 * 60 * 1000;
const SHARED_RECALL_LIMIT = 24;

function cloneRecallValue(value) {
    if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function stableRecallHash(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function pruneSharedRecallCache(now = Date.now()) {
    for (const [key, record] of sharedRecallBundles) {
        if (now - Number(record?.createdAt ?? 0) > SHARED_RECALL_TTL_MS) sharedRecallBundles.delete(key);
    }
    while (sharedRecallBundles.size > SHARED_RECALL_LIMIT) {
        sharedRecallBundles.delete(sharedRecallBundles.keys().next().value);
    }
    for (const [key, record] of postGenerationRecallResults) {
        if (now - Number(record?.createdAt ?? 0) > SHARED_RECALL_TTL_MS) postGenerationRecallResults.delete(key);
    }
    while (postGenerationRecallResults.size > SHARED_RECALL_LIMIT) {
        postGenerationRecallResults.delete(postGenerationRecallResults.keys().next().value);
    }
}

function getSharedRecallBundle(key) {
    const cacheKey = String(key ?? '').trim();
    if (!cacheKey) return null;
    pruneSharedRecallCache();
    const record = sharedRecallBundles.get(cacheKey);
    if (!record) return null;
    sharedRecallBundles.delete(cacheKey);
    sharedRecallBundles.set(cacheKey, record);
    return cloneRecallValue(record.bundle);
}

function saveSharedRecallBundle(key, bundle) {
    const cacheKey = String(key ?? '').trim();
    if (!cacheKey) return;
    sharedRecallBundles.delete(cacheKey);
    sharedRecallBundles.set(cacheKey, { createdAt: Date.now(), bundle: cloneRecallValue(bundle) });
    pruneSharedRecallCache();
}

export function clearSharedRecallCache() {
    sharedRecallBundles.clear();
    postGenerationRecallPromises.clear();
    postGenerationRecallResults.clear();
}

function recallClientSignature(clients = {}) {
    const keys = ['searchMemory', 'rerankMemory', 'getSummaries', 'syncSummaryMemory', 'searchSummaryMemory'];
    const ids = keys.map(key => {
        const candidate = clients?.[key];
        if (typeof candidate !== 'function') return `${key}:default`;
        if (!recallClientIds.has(candidate)) recallClientIds.set(candidate, nextRecallClientId++);
        return `${key}:${recallClientIds.get(candidate)}`;
    });
    return ids.join('|');
}

async function measureGenerationStage(callback, stage, operation) {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    try {
        return await operation();
    } finally {
        const endedAt = globalThis.performance?.now?.() ?? Date.now();
        callback?.(stage, Math.max(0, endedAt - startedAt));
    }
}
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

function getSummarySyncSignature(records, embedding) {
    return [
        embedding?.baseUrl,
        embedding?.model,
        ...records.map(item => `${item.uid}\u0000${item.start}\u0000${item.end}\u0000${item.summary}`),
    ].join('\u0001');
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

function getMemoryFragments(results, context = null) {
    const message = formatMemoryMessage(results, context);
    if (!message) return '';
    const separator = '\n\n';
    const index = message.content.indexOf(separator);
    return index >= 0 ? message.content.slice(index + separator.length) : message.content;
}

function normalizeSummaryRecords(records) {
    const byUid = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        const uid = String(record?.uid ?? '').trim();
        const summary = String(record?.summary ?? record?.text ?? '').trim();
        const start = Number(record?.start);
        const end = Number(record?.end);
        if (!uid || !summary || !Number.isInteger(start) || !Number.isInteger(end)) continue;
        byUid.set(uid, { ...record, uid, summary, start, end });
    }
    return [...byUid.values()].sort((left, right) => left.start - right.start || left.end - right.end);
}

export function formatHistoricalContextMessage({ recentSummaries = [], recalledSummaries = [], memories = [] } = {}, context = null) {
    const recentUids = new Set(recentSummaries.map(item => String(item.uid)));
    const summaryFragments = normalizeSummaryRecords([...recentSummaries, ...recalledSummaries])
        .map(item => [
            recentUids.has(item.uid) ? '[近期固定总结]' : '[相关旧总结]',
            `第${item.start + 1}-${item.end + 1}楼`,
            item.summary,
        ].join('\n'));
    const memoryFragments = getMemoryFragments(memories, context);
    if (summaryFragments.length === 0 && !memoryFragments) return null;
    const content = [
        '【历史上下文参考】',
        '以下内容均来自当前场景之前的历史，仅用于保持剧情连续性；不是当前正在发生的场景，不得让时间线倒退或重复旧事件。',
        '召回内容可能相关，也可能无关，不要求必须采用；若确实相关，应据此保持事实、人物认知与因果一致。',
        '如与玩家最新回复、最近原文或较晚楼层冲突，一律以玩家最新回复和较晚内容为准。',
        summaryFragments.length > 0 ? `【进入本轮的剧情总结】\n\n${summaryFragments.join('\n\n')}` : '',
        memoryFragments ? `【总结所关联的正文细节】\n\n${memoryFragments}` : '',
    ].filter(Boolean).join('\n\n');
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
            memory_augment_recall_type: 'history',
        },
    };
}

export function findHistoricalInsertionIndex(chat) {
    const markerIndex = chat.findIndex(message => /\[\s*Start a new Story\s*\]/i.test(getMessageText(message)));
    if (markerIndex >= 0) return markerIndex + 1;
    const conversationIndex = chat.findIndex(message => message?.is_user === true
        || message?.role === 'user'
        || message?.role === 'assistant'
        || (message?.is_system === false && message?.role !== 'system'));
    return conversationIndex >= 0 ? conversationIndex : chat.length;
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

function applyRecallBundle(chat, bundle = {}) {
    const historicalMessage = bundle?.historicalMessage ? cloneRecallValue(bundle.historicalMessage) : null;
    const worldInfoMessage = bundle?.worldInfoMessage ? cloneRecallValue(bundle.worldInfoMessage) : null;
    if (!historicalMessage && !worldInfoMessage) {
        return { ...(bundle?.result ?? {}), injected: false, reason: 'filtered' };
    }
    let insertionIndex = null;
    if (historicalMessage) {
        insertionIndex = findHistoricalInsertionIndex(chat);
        chat.splice(insertionIndex, 0, historicalMessage);
    }
    let worldInfoInsertionIndex = null;
    if (worldInfoMessage) {
        worldInfoInsertionIndex = Math.max(0, chat.length - 2);
        chat.splice(worldInfoInsertionIndex, 0, worldInfoMessage);
    }
    return {
        ...(bundle?.result ?? {}),
        injected: true,
        insertionIndex,
        worldInfoInsertionIndex,
    };
}

export async function retrieveAndInject(chat, settings, context, clients = {}) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return { injected: false, reason: 'empty-chat' };
    }
    if (settings?.rag?.enabled === false) {
        return { injected: false, reason: 'disabled' };
    }

    const embedding = completeApiConfig(settings?.apis?.embedding);
    const chatId = context?.getCurrentChatId?.() ?? context?.chatId;
    const query = buildRagQuery(chat, 3);
    if (!chatId || !query) {
        return { injected: false, reason: 'missing-input' };
    }

    const topK = clampInteger(settings?.rag?.topK, 20, 1, 100);
    const topN = clampInteger(settings?.rag?.topN, 6, 1, Math.min(50, topK));
    const threshold = clampNumber(settings?.rag?.rerankerThreshold, 0.6, 0, 1);
    const recentMessages = clampInteger(settings?.context?.recentMessages, 20, 1, 1000);
    const persistentChatLength = Array.isArray(context?.chat) ? context.chat.length : chat.length;
    const requestedMessageIdBefore = Math.trunc(Number(clients.chatMessageIdBefore));
    const chatMessageIdBefore = Number.isInteger(requestedMessageIdBefore) && requestedMessageIdBefore >= 0
        ? requestedMessageIdBefore
        : Math.max(0, persistentChatLength - recentMessages);
    const sharedCacheKey = String(clients.sharedCacheKey ?? '').trim();
    const cachedBundle = getSharedRecallBundle(sharedCacheKey);
    if (cachedBundle) return { ...applyRecallBundle(chat, cachedBundle), cachedRecall: true };
    const search = clients.searchMemory ?? searchMemory;
    const rerank = clients.rerankMemory ?? rerankMemory;
    const readSummaries = clients.getSummaries ?? getSummaries;
    const syncSummaries = clients.syncSummaryMemory ?? syncSummaryMemory;
    const searchSummaries = clients.searchSummaryMemory ?? searchSummaryMemory;
    // Timing belongs to the caller that owns this retrieval. Phone/background
    // retrievals also use this helper and must never write into the main reply's clock.
    const timing = clients.recordTiming;
    let allSummaries = [];
    try {
        allSummaries = normalizeSummaryRecords(await measureGenerationStage(
            timing,
            'summaryRead',
            () => readSummaries(context),
        ));
    } catch (error) {
        console.warn('[Memory Augment] Failed to read detailed summaries; raw fallback remains available.', error);
    }
    const recentSummaryRecords = allSummaries.slice(-RECENT_SUMMARY_COUNT);
    const recentSummaryUids = new Set(recentSummaryRecords.map(item => item.uid));
    const olderSummaryRecords = allSummaries.filter(item => !recentSummaryUids.has(item.uid));
    const reranker = completeApiConfig(settings?.apis?.reranker);
    let recalledSummaryRecords = [];
    let summaryUsedReranker = false;
    if (embedding && olderSummaryRecords.length > 0) {
        try {
            const summarySignature = getSummarySyncSignature(allSummaries, embedding);
            if (summarySyncSignatures.get(String(chatId)) !== summarySignature) {
                await measureGenerationStage(timing, 'summarySync', () => syncSummaries({
                        chatId,
                        entries: allSummaries.map(item => ({
                            uid: item.uid,
                            start: item.start,
                            end: item.end,
                            text: item.summary,
                        })),
                        embedding,
                    }));
                summarySyncSignatures.set(String(chatId), summarySignature);
            }
            const summarySearch = await measureGenerationStage(timing, 'summarySearch', () => searchSummaries({
                chatId,
                query,
                topK: SUMMARY_TOP_K,
                summaryUids: olderSummaryRecords.map(item => item.uid),
                embedding,
            }));
            const summarySelection = await measureGenerationStage(timing, 'summaryRerank', () => selectRecallResults({
                candidates: Array.isArray(summarySearch?.results) ? summarySearch.results : [],
                query,
                topN: SUMMARY_TOP_N,
                threshold,
                reranker,
                rerank,
                source: 'Detailed summary',
            }));
            summaryUsedReranker = summarySelection.usedReranker;
            const canonicalByUid = new Map(olderSummaryRecords.map(item => [item.uid, item]));
            recalledSummaryRecords = summarySelection.results
                .map(item => canonicalByUid.get(String(item?.summary_uid ?? item?.uid ?? '')))
                .filter(Boolean);
        } catch (error) {
            console.warn('[Memory Augment] Summary retrieval failed; recent summaries and raw fallback remain available.', error);
        }
    }
    const selectedSummaryRecords = normalizeSummaryRecords([
        ...recentSummaryRecords,
        ...recalledSummaryRecords,
    ]);
    const activeBookIds = Array.isArray(settings?.rag?.activeWorldInfoBookIds)
        ? settings.rag.activeWorldInfoBookIds.map(String)
        : getActiveWorldInfoBookIds();
    const ordinaryBookIds = activeBookIds.filter(id => !isManagedSummaryWorldInfoBookName(id));
    const semanticWorldInfo = Boolean(settings?.rag?.semanticWorldInfo && ordinaryBookIds.length > 0);
    let searchResponse = { chatResults: [], worldInfoResults: [], errors: {} };
    if (embedding) {
        try {
            searchResponse = await measureGenerationStage(timing, 'memorySearch', () => search({
                chatId,
                query,
                separate: true,
                chatTopK: topK,
                chatGlobalFallbackK: CHAT_GLOBAL_FALLBACK_K,
                worldInfoTopK: WORLD_INFO_TOP_K,
                embedding,
                scope: {
                    chat_id: chatId,
                    chat_message_id_before: chatMessageIdBefore,
                    chat_message_ranges: selectedSummaryRecords.map(item => ({ start: item.start, end: item.end })),
                    book_ids: semanticWorldInfo ? ordinaryBookIds : [],
                },
            }));
        } catch (error) {
            searchResponse = { chatResults: [], worldInfoResults: [], errors: { chat: String(error?.message ?? error) } };
        }
    }
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
    const [chatSelection, worldInfoSelection] = await measureGenerationStage(timing, 'memoryRerank', () => Promise.all([
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
    ]));
    const usedReranker = summaryUsedReranker || chatSelection.usedReranker || worldInfoSelection.usedReranker;
    const worldInfoMessage = semanticWorldInfo
        ? formatWorldInfoMessage(worldInfoSelection.results)
        : null;
    const historicalMessage = formatHistoricalContextMessage({
        recentSummaries: recentSummaryRecords,
        recalledSummaries: recalledSummaryRecords,
        memories: chatSelection.results,
    }, context);
    const bundle = {
        historicalMessage,
        worldInfoMessage,
        result: {
        resultCount: recentSummaryRecords.length + recalledSummaryRecords.length
            + chatSelection.results.length + worldInfoSelection.results.length,
        recentSummaryCount: recentSummaryRecords.length,
        recalledSummaryCount: recalledSummaryRecords.length,
        chatResultCount: chatSelection.results.length,
        worldInfoResultCount: worldInfoSelection.results.length,
        usedReranker,
        },
    };
    saveSharedRecallBundle(sharedCacheKey, bundle);
    return applyRecallBundle(chat, bundle);
}

function recallSettingsSignature(settings = {}) {
    const embedding = completeApiConfig(settings?.apis?.embedding) ?? {};
    const reranker = completeApiConfig(settings?.apis?.reranker) ?? {};
    return stableRecallHash(JSON.stringify({
        embedding: [embedding.baseUrl, embedding.model],
        reranker: [reranker.baseUrl, reranker.model],
        topK: settings?.rag?.topK,
        topN: settings?.rag?.topN,
        threshold: settings?.rag?.rerankerThreshold,
        semanticWorldInfo: settings?.rag?.semanticWorldInfo,
        books: settings?.rag?.activeWorldInfoBookIds ?? settings?.rag?.semanticWorldInfoBooks ?? [],
    }));
}

function preGenerationRecallCacheKey(chat, settings, context) {
    const chatId = context?.getCurrentChatId?.() ?? context?.chatId;
    const query = buildRagQuery(chat, 3);
    if (!chatId || !query) return '';
    return `pre:${stableRecallHash(`${chatId}\n${chat.length}\n${query}\n${recallSettingsSignature(settings)}`)}`;
}

export async function getSharedPostGenerationRecall(settings, context, messageId, clients = {}) {
    if (settings?.rag?.enabled === false) return { fragments: [], reason: 'disabled' };
    const numericId = Math.trunc(Number(messageId));
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const message = chat[numericId];
    const chatId = context?.getCurrentChatId?.() ?? context?.chatId;
    if (!chatId || !message || message.is_user || message.is_system) {
        return { fragments: [], reason: 'missing-story-message' };
    }
    const precedingCount = clampInteger(settings?.barrage?.recentMessages, 5, 1, 20);
    const start = Math.max(0, numericId - precedingCount);
    const queryChat = cloneGenerationChat(chat.slice(start, numericId + 1));
    const query = buildRagQuery(queryChat, 3);
    const sourceHash = stableRecallHash(String(message?.mes ?? message?.content ?? ''));
    const cacheKey = `post:${stableRecallHash([
        chatId,
        numericId,
        sourceHash,
        start,
        query,
        recallSettingsSignature(settings),
        recallClientSignature(clients),
    ].join('\n'))}`;
    pruneSharedRecallCache();
    const cached = postGenerationRecallResults.get(cacheKey);
    if (cached) return { ...cloneRecallValue(cached.value), cachedRecall: true };
    if (postGenerationRecallPromises.has(cacheKey)) return postGenerationRecallPromises.get(cacheKey);

    const task = (async () => {
        const embedding = completeApiConfig(settings?.apis?.embedding);
        if (!embedding || !query) return { fragments: [], reason: 'missing-input', cacheKey };
        const topK = clampInteger(settings?.rag?.topK, 20, 1, 100);
        const topN = clampInteger(settings?.rag?.topN, 6, 1, Math.min(50, topK));
        const threshold = clampNumber(settings?.rag?.rerankerThreshold, 0.6, 0, 1);
        const activeBookIds = Array.isArray(settings?.rag?.activeWorldInfoBookIds)
            ? settings.rag.activeWorldInfoBookIds.map(String)
            : getActiveWorldInfoBookIds();
        const ordinaryBookIds = activeBookIds.filter(id => !isManagedSummaryWorldInfoBookName(id));
        const semanticWorldInfo = Boolean(settings?.rag?.semanticWorldInfo && ordinaryBookIds.length > 0);
        const search = clients.searchMemory ?? searchMemory;
        const searchResponse = await search({
            chatId,
            query,
            separate: true,
            chatTopK: topK,
            chatGlobalFallbackK: CHAT_GLOBAL_FALLBACK_K,
            worldInfoTopK: WORLD_INFO_TOP_K,
            embedding,
            scope: {
                chat_id: chatId,
                chat_message_id_before: start,
                book_ids: semanticWorldInfo ? ordinaryBookIds : [],
            },
        });
        const legacyResults = Array.isArray(searchResponse?.results) ? searchResponse.results : [];
        const chatCandidates = Array.isArray(searchResponse?.chatResults)
            ? searchResponse.chatResults
            : legacyResults.filter(result => result.type !== 'worldinfo');
        const worldInfoCandidates = semanticWorldInfo
            ? Array.isArray(searchResponse?.worldInfoResults)
                ? searchResponse.worldInfoResults
                : legacyResults.filter(result => result.type === 'worldinfo')
            : [];
        const reranker = completeApiConfig(settings?.apis?.reranker);
        const rerank = clients.rerankMemory ?? rerankMemory;
        const [chatSelection, worldInfoSelection] = await Promise.all([
            selectRecallResults({
                candidates: chatCandidates,
                query,
                topN,
                threshold,
                reranker,
                rerank,
                source: 'Shared post-story chat memory',
            }),
            selectRecallResults({
                candidates: worldInfoCandidates,
                query,
                topN: WORLD_INFO_TOP_N,
                threshold,
                reranker,
                rerank,
                source: 'Shared post-story world info',
            }),
        ]);
        const fragments = [...worldInfoSelection.results, ...chatSelection.results]
            .map((item, index) => ({
                id: item?.id ?? `${cacheKey}:${index}`,
                summary_tag: item?.summary_tag ?? '',
                text: String(item?.text ?? '').trim(),
            }))
            .filter(item => item.text);
        const value = {
            fragments,
            cacheKey,
            usedReranker: chatSelection.usedReranker || worldInfoSelection.usedReranker,
        };
        postGenerationRecallResults.set(cacheKey, { createdAt: Date.now(), value: cloneRecallValue(value) });
        pruneSharedRecallCache();
        return value;
    })().finally(() => {
        if (postGenerationRecallPromises.get(cacheKey) === task) postGenerationRecallPromises.delete(cacheKey);
    });
    postGenerationRecallPromises.set(cacheKey, task);
    return task;
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
    beginGenerationPreparation(type);

    try {
        try {
            await retrieveAndInject(generationChat, settings, context, {
                recordTiming: recordGenerationTimingStage,
                sharedCacheKey: preGenerationRecallCacheKey(generationChat, settings, context),
            });
        } catch (error) {
            console.error('[Memory Augment] RAG interceptor failed; generation will continue without memory injection.', error);
        }

        await measureGenerationStage(recordGenerationTimingStage, 'localContext', async () => {
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
        });

        try {
            const phoneStore = await measureGenerationStage(
                recordGenerationTimingStage,
                'phoneLoad',
                () => loadPhoneStore(context),
            );
            let recalledPhoneEvents = [];
            const embedding = completeApiConfig(settings?.apis?.embedding);
            if (embedding) {
                try {
                    recalledPhoneEvents = await measureGenerationStage(
                        recordGenerationTimingStage,
                        'phoneRecall',
                        () => recallPhoneMemoryEvents({
                            store: phoneStore,
                            query: buildRagQuery(Array.isArray(context?.chat) ? context.chat : generationChat, 3),
                            embedding,
                            topK: 3,
                        }),
                    );
                } catch (error) {
                    console.warn('[Memory Augment] Online phone memory retrieval failed; pending and active phone facts remain available.', error);
                }
            }
            await measureGenerationStage(recordGenerationTimingStage, 'phoneInject', async () => {
                injectPhoneContext(generationChat, phoneStore, 12, recalledPhoneEvents);
            });
        } catch (error) {
            console.error('[Memory Augment] Phone context injection failed; generation will continue without it.', error);
        }

        chat.splice(0, chat.length, ...generationChat);
    } finally {
        completeGenerationPreparation();
    }
}
