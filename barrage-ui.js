import { generateBarrage, rerankMemory, searchMemory } from './rag-client.js';
import { normalizeBaseUrl } from './api-utils.js';
import { getActiveWorldInfoBookIds } from './world-info-manager.js';
import {
    applyStoryStatusOptions,
    applyStoryTimelineUpdate,
    clearStoryStatusRecords,
    getLatestStoryStatus,
    getMessageTimelineMetadata,
    getStoryStatusAt,
    hashStorySource,
    initializeStoryStatusUi,
    parseSideResponse,
    refreshStoryStatusUi,
    saveStoryStatus,
} from './story-status.js';
import {
    applyCharacterDevelopmentUpdate,
    clearCharacterDevelopmentRecords,
    getCharacterDevelopmentSnapshot,
    isCharacterDevelopmentProcessed,
    refreshCharacterDevelopmentUi,
} from './character-development.js';
import {
    buildCharacterBaselines,
    ensureDevelopmentBaselineSource,
    getDevelopmentBaselineOwnerKey,
} from './character-baseline.js';

const BARRAGE_METADATA_KEY = 'memory_augment_barrages';
const SIDE_RESULT_METADATA_KEY = 'memory_augment_side_results';
const WORLD_INFO_TOP_K = 10;
const WORLD_INFO_TOP_N = 5;
const inFlight = new Map();
let barrageTemplate = '';
let regenerationBound = false;
let statusRegenerationBound = false;
let barrageLifecycleBound = false;

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
    const existingTimestamp = Math.trunc(Number(record?.timestamp));
    const legacyTimestamp = Math.floor(Date.parse(record?.createdAt) / 1000);
    const timestamp = Number.isInteger(existingTimestamp) && existingTimestamp > 0
        ? existingTimestamp
        : Number.isInteger(legacyTimestamp) && legacyTimestamp > 0
            ? legacyTimestamp
            : Math.floor(Date.now() / 1000);
    const error = String(record?.error ?? '').trim();
    if ((record?.state === 'error' || error) && error) {
        return {
            state: 'error',
            error,
            sourceHash: String(record?.sourceHash ?? '').trim(),
            timestamp,
        };
    }
    const content = String(record?.content ?? '').trim();
    if (!content) {
        return null;
    }
    return {
        content,
        sourceHash: String(record?.sourceHash ?? '').trim(),
        timestamp,
    };
}

function getBarrageVariantKey(message) {
    const swipeId = Math.trunc(Number(message?.swipe_id));
    if (Number.isInteger(swipeId) && swipeId >= 0) {
        return `swipe:${swipeId}`;
    }
    const currentText = String(message?.mes ?? '').trim();
    const matchedIndex = Array.isArray(message?.swipes)
        ? message.swipes.findIndex(text => String(text ?? '').trim() === currentText)
        : -1;
    return `swipe:${matchedIndex >= 0 ? matchedIndex : 0}`;
}

function getBarrageVariantKeys(message) {
    const count = Array.isArray(message?.swipes) && message.swipes.length > 0
        ? message.swipes.length
        : 1;
    const keys = new Set(Array.from({ length: count }, (_, index) => `swipe:${index}`));
    keys.add(getBarrageVariantKey(message));
    return keys;
}

function findVariantKeysBySourceHash(message, sourceHash) {
    const texts = Array.isArray(message?.swipes) && message.swipes.length > 0
        ? message.swipes
        : [message?.mes];
    return texts
        .map((text, index) => ({ index, sourceHash: hashStorySource(String(text ?? '').trim()) }))
        .filter(item => item.sourceHash === sourceHash)
        .map(item => `swipe:${item.index}`);
}

function normalizeBarrageBucket(store, messageId, message, create = false) {
    const key = String(messageId);
    const existing = store?.[key];
    if (existing?.variants && typeof existing.variants === 'object' && !Array.isArray(existing.variants)) {
        const variants = {};
        let migrated = Number(existing.version) !== 3;
        const currentVariantKey = getBarrageVariantKey(message);
        const unmatched = [];
        for (const [storedKey, value] of Object.entries(existing.variants)) {
            const normalized = normalizeStoredBarrage(value);
            if (!normalized) {
                migrated = true;
                continue;
            }

            if (Number(existing.version) === 3 && /^swipe:\d+$/.test(storedKey)) {
                variants[storedKey] = normalized;
                continue;
            }

            // Version 2 used the complete reply text hash as identity. Match
            // those records to their SillyTavern swipe slots once, so later
            // text edits no longer change the barrage identity.
            const sourceHash = String(normalized.sourceHash || storedKey).trim();
            const matchedKeys = sourceHash ? findVariantKeysBySourceHash(message, sourceHash) : [];
            if (matchedKeys.length > 0) {
                for (const matchedKey of matchedKeys) {
                    variants[matchedKey] = { ...normalized, sourceHash };
                }
            } else {
                unmatched.push({ ...normalized, sourceHash });
            }
            migrated = true;
        }

        // If the current candidate was edited before this migration, its old
        // hash no longer exists in `swipes`. Preserve that remaining barrage
        // on the currently selected candidate instead of throwing it away.
        const fallbackKeys = [
            currentVariantKey,
            ...getBarrageVariantKeys(message),
        ].filter((variantKey, index, keys) => keys.indexOf(variantKey) === index && !variants[variantKey]);
        for (const fallbackKey of fallbackKeys) {
            const record = unmatched.shift();
            if (!record) break;
            variants[fallbackKey] = record;
        }
        const bucket = { version: 3, variants };
        if (migrated) store[key] = bucket;
        return { bucket, migrated };
    }

    const legacy = normalizeStoredBarrage(existing);
    if (!legacy) {
        const bucket = { version: 3, variants: {} };
        if (create) store[key] = bucket;
        return { bucket: create ? bucket : null, migrated: false };
    }
    const sourceHash = String(legacy.sourceHash || hashStorySource(message?.mes)).trim();
    const variantKey = getBarrageVariantKey(message);
    const bucket = {
        version: 3,
        variants: { [variantKey]: { ...legacy, sourceHash } },
    };
    store[key] = bucket;
    return { bucket, migrated: true };
}

function getBarrageVariant(store, messageId, message) {
    const normalized = normalizeBarrageBucket(store, messageId, message);
    const variantKey = getBarrageVariantKey(message);
    return {
        record: normalizeStoredBarrage(normalized.bucket?.variants?.[variantKey]),
        variantKey,
        migrated: normalized.migrated,
    };
}

function setBarrageVariant(store, messageId, message, sourceHash, record) {
    const { bucket } = normalizeBarrageBucket(store, messageId, message, true);
    const variantKey = getBarrageVariantKey(message);
    bucket.variants[variantKey] = {
        ...record,
        sourceHash,
    };
    store[String(messageId)] = bucket;
}

function deleteBarrageVariant(store, messageId, message) {
    const { bucket } = normalizeBarrageBucket(store, messageId, message);
    const variantKey = getBarrageVariantKey(message);
    if (!bucket?.variants?.[variantKey]) return false;
    delete bucket.variants[variantKey];
    if (Object.keys(bucket.variants).length === 0) delete store[String(messageId)];
    else store[String(messageId)] = bucket;
    return true;
}

function cloneSideValue(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function getSideResultStore(metadata, create = false) {
    const existing = metadata?.[SIDE_RESULT_METADATA_KEY];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing;
    if (!create || !metadata || typeof metadata !== 'object') return {};
    metadata[SIDE_RESULT_METADATA_KEY] = {};
    return metadata[SIDE_RESULT_METADATA_KEY];
}

function getSideResultBucket(store, messageId, create = false) {
    const key = String(messageId);
    const existing = store?.[key];
    if (existing?.variants && typeof existing.variants === 'object' && !Array.isArray(existing.variants)) {
        existing.version = 1;
        return existing;
    }
    if (!create) return null;
    const bucket = { version: 1, variants: {} };
    store[key] = bucket;
    return bucket;
}

function getSideResultVariant(store, messageId, message) {
    const bucket = getSideResultBucket(store, messageId);
    const variantKey = getBarrageVariantKey(message);
    const record = bucket?.variants?.[variantKey];
    const sourceHash = hashStorySource(String(message?.mes ?? '').trim());
    if (!record || record.sourceHash !== sourceHash) return { record: null, variantKey };
    return { record, variantKey };
}

function setSideResultVariant(store, messageId, message, record) {
    const bucket = getSideResultBucket(store, messageId, true);
    const variantKey = getBarrageVariantKey(message);
    bucket.variants[variantKey] = cloneSideValue(record);
    store[String(messageId)] = bucket;
}

function deleteSideResultVariant(store, messageId, message) {
    const bucket = getSideResultBucket(store, messageId);
    const variantKey = getBarrageVariantKey(message);
    if (!bucket?.variants?.[variantKey]) return false;
    delete bucket.variants[variantKey];
    if (Object.keys(bucket.variants).length === 0) delete store[String(messageId)];
    return true;
}

function clearSideResultStatus(store, messageId, message) {
    const bucket = getSideResultBucket(store, messageId);
    const variantKey = getBarrageVariantKey(message);
    const record = bucket?.variants?.[variantKey];
    if (!record) return false;
    const changed = record.statusProcessed || record.status || record.timeline;
    delete record.statusProcessed;
    delete record.status;
    delete record.timeline;
    if (!record.developmentProcessed) {
        delete bucket.variants[variantKey];
        if (Object.keys(bucket.variants).length === 0) delete store[String(messageId)];
    }
    return Boolean(changed);
}

function clearDeletedSideResultRecords(context, firstDeletedMessageId) {
    const numericId = Number(firstDeletedMessageId);
    if (!Number.isInteger(numericId) || numericId < 0) return false;
    const store = getSideResultStore(context?.chatMetadata);
    let changed = false;
    for (const messageId of Object.keys(store)) {
        const storedId = Number(messageId);
        if (Number.isInteger(storedId) && storedId >= numericId) {
            delete store[messageId];
            changed = true;
        }
    }
    return changed;
}

export function compactSwipeDerivedData(context, messageId, message, selectedSwipeIndex) {
    const numericId = Number(messageId);
    const selectedIndex = Math.max(0, Math.trunc(Number(selectedSwipeIndex) || 0));
    if (!Number.isInteger(numericId) || !message || message.is_user) return false;
    const selectedKey = `swipe:${selectedIndex}`;
    let changed = false;

    const barrageStore = getBarrageStore(context?.chatMetadata);
    const normalized = normalizeBarrageBucket(barrageStore, numericId, message);
    const selectedBarrage = normalizeStoredBarrage(normalized.bucket?.variants?.[selectedKey]);
    if (normalized.bucket) {
        if (selectedBarrage) {
            barrageStore[String(numericId)] = {
                version: 3,
                variants: { 'swipe:0': selectedBarrage },
            };
        } else {
            delete barrageStore[String(numericId)];
        }
        changed = true;
    }

    const sideStore = getSideResultStore(context?.chatMetadata);
    const sideBucket = getSideResultBucket(sideStore, numericId);
    if (sideBucket) {
        const selectedSideResult = sideBucket.variants?.[selectedKey];
        const sourceHash = hashStorySource(String(message?.mes ?? '').trim());
        if (selectedSideResult?.sourceHash === sourceHash) {
            sideStore[String(numericId)] = {
                version: 1,
                variants: { 'swipe:0': cloneSideValue(selectedSideResult) },
            };
        } else {
            delete sideStore[String(numericId)];
        }
        changed = true;
    }
    return changed;
}

export function pruneOrphanedSwipeDerivedData(context) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const barrageStore = getBarrageStore(context?.chatMetadata);
    const sideStore = getSideResultStore(context?.chatMetadata);
    let changed = false;
    for (const [messageId, bucket] of Object.entries(sideStore)) {
        const message = chat[Number(messageId)];
        if (!message || message.is_user || !bucket?.variants) {
            delete sideStore[messageId];
            changed = true;
            continue;
        }
        const validKeys = getBarrageVariantKeys(message);
        const texts = Array.isArray(message.swipes) && message.swipes.length > 0 ? message.swipes : [message.mes];
        for (const storedKey of Object.keys(bucket.variants)) {
            const index = Number(String(storedKey).split(':')[1]);
            const record = bucket.variants[storedKey];
            const validHash = Number.isInteger(index) ? hashStorySource(String(texts[index] ?? '').trim()) : '';
            if (!validKeys.has(storedKey) || !record || record.sourceHash !== validHash) {
                delete bucket.variants[storedKey];
                changed = true;
            }
        }
        if (Object.keys(bucket.variants).length === 0) delete sideStore[messageId];
    }
    for (const messageId of Object.keys(barrageStore)) {
        const message = chat[Number(messageId)];
        if (!message || message.is_user) {
            delete barrageStore[messageId];
            changed = true;
        }
    }
    return changed;
}

function restoreSideResultVariant(context, messageId, message, record, settings) {
    if (!record) return false;
    const numericId = Number(messageId);
    const sourceHash = hashStorySource(String(message?.mes ?? '').trim());
    let changed = false;
    if (settings?.status?.enabled === true && record.statusProcessed && record.status
        && !getStoryStatusAt(context, numericId)) {
        clearStoryStatusRecords(context, numericId);
        const restored = applyStoryTimelineUpdate(
            context,
            numericId,
            cloneSideValue(record.status),
            cloneSideValue(record.timeline),
            sourceHash,
        ).status;
        saveStoryStatus(context, numericId, restored, sourceHash);
        changed = true;
    }
    if (settings?.development?.enabled === true && record.developmentProcessed
        && !isCharacterDevelopmentProcessed(context, numericId, sourceHash)) {
        clearCharacterDevelopmentRecords(context, numericId);
        const status = getStoryStatusAt(context, numericId)?.status ?? record.status ?? null;
        const timeline = status ? getMessageTimelineMetadata(context, numericId) : null;
        applyCharacterDevelopmentUpdate(context, numericId, cloneSideValue(record.development), {
            status,
            timeline,
            sourceHash,
        });
        changed = true;
    }
    return changed;
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

    const topK = clampInteger(settings?.rag?.topK, 25, 1, 100);
    const topN = clampInteger(settings?.rag?.topN, 7, 1, Math.min(50, topK));
    const configuredThreshold = Number(settings?.rag?.rerankerThreshold);
    const rerankerThreshold = Number.isFinite(configuredThreshold) ? configuredThreshold : 0.6;
    const recentMessageIds = recentMessages.map(message => Number(message.id)).filter(Number.isInteger);
    const chatMessageIdBefore = recentMessageIds.length > 0 ? Math.min(...recentMessageIds) : 0;
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
                    threshold: rerankerThreshold,
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
    const rendered = template.content.firstElementChild;
    if (rendered) return rendered;
    const panel = document.createElement('details');
    panel.className = 'memory-augment-barrage';
    panel.innerHTML = `
        <summary class="memory-augment-barrage-toggle">
            <span class="fa-solid fa-comments" aria-hidden="true"></span>
            <span>观众弹幕</span>
            <span class="memory-augment-barrage-status"></span>
        </summary>
        <div class="memory-augment-barrage-content" aria-live="polite"></div>
        <div class="memory-augment-barrage-actions">
            <button type="button" class="menu_button memory-augment-barrage-regenerate">重新生成弹幕</button>
        </div>`;
    return panel;
}

export function renderBarragePanel(messageId, content, state = 'ready') {
    const numericId = Number(messageId);
    if (!Number.isInteger(numericId)) {
        return false;
    }

    const messageElement = document.querySelector(`#chat .mes[mesid="${numericId}"]`);
    const messageBlock = messageElement?.querySelector('.mes_block');
    if (!messageBlock) {
        return false;
    }

    const panelHost = messageBlock.querySelector('.mes_text') ?? messageBlock;
    let panel = messageBlock.querySelector('.memory-augment-barrage');
    if (!panel) {
        panel = createPanelFromTemplate();
    }
    if (panel.parentElement !== panelHost) {
        panelHost.append(panel);
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

function showSideGenerationDiagnostic(context, message, { preserveStatus = true } = {}) {
    if (typeof document === 'undefined') return;
    refreshStoryStatusUi(context);
    const statusContent = document.querySelector('#memory_augment_story_status_content');
    if (preserveStatus && statusContent?.hidden === false) return;
    if (!preserveStatus && statusContent) statusContent.hidden = true;
    const empty = document.querySelector('#memory_augment_story_status_empty');
    if (empty) {
        empty.hidden = false;
        empty.textContent = message;
    }
}

export async function handleCharacterMessageRendered(messageId, settings, context, dependencies = {}, options = {}) {
    const numericId = Number(messageId);
    const message = Number.isInteger(numericId) ? context?.chat?.[numericId] : null;
    const messageText = String(message?.mes ?? '').trim();
    const barrageEnabled = settings?.barrage?.enabled === true;
    const statusEnabled = settings?.status?.enabled === true;
    const developmentConfigured = settings?.development?.enabled === true;
    const hasPriorUserMessage = Number.isInteger(numericId)
        && context?.chat?.slice(0, numericId).some(item => item?.is_user);
    if ((!barrageEnabled && !statusEnabled && !developmentConfigured)
        || !message || message.is_user || message.is_system || !messageText || messageText === '...'
        || !hasPriorUserMessage) {
        return { generated: false, reason: 'disabled-or-ineligible' };
    }
    const barrage = completeApiConfig(settings?.apis?.barrage);
    if (!barrage) {
        const detail = '副 API 配置不完整：请检查 Base URL、API Key 和模型名。';
        const diagnosticRender = dependencies.renderBarrage
            ?? (typeof document !== 'undefined' ? renderBarragePanel : null);
        if (barrageEnabled && diagnosticRender) safelyRender(diagnosticRender, numericId, detail, 'error');
        if (statusEnabled) showSideGenerationDiagnostic(context, detail);
        return { generated: false, reason: 'missing-config' };
    }
    const developmentSource = developmentConfigured
        ? await ensureDevelopmentBaselineSource(settings, context)
        : '';
    // Contexts without a real SillyTavern character (mostly tests and imports)
    // keep the old conservative unknown-baseline path. Real character cards must
    // be explicitly confirmed before automatic development analysis starts.
    const developmentEnabled = developmentConfigured
        && (!getDevelopmentBaselineOwnerKey(context) || Boolean(developmentSource));
    if (!barrageEnabled && !statusEnabled && !developmentEnabled) {
        return { generated: false, reason: 'development-baseline-unconfirmed' };
    }

    const chatId = getChatId(context);
    const sourceHash = hashStorySource(messageText);
    const render = dependencies.renderBarrage ?? renderBarragePanel;
    const store = getBarrageStore(context.chatMetadata);
    const cachedResult = getBarrageVariant(store, numericId, message);
    const cached = cachedResult.record;
    if (cachedResult.migrated) {
        void Promise.resolve(context.saveMetadata?.())
            .catch(error => console.warn('[Memory Augment] Barrage metadata migration save failed.', error));
    }
    const sideStore = getSideResultStore(context.chatMetadata);
    const sideResult = getSideResultVariant(sideStore, numericId, message);
    const cachedSideResult = sideResult.record;
    const statusVariantReady = statusEnabled !== true
        || Boolean(cachedSideResult?.statusProcessed && cachedSideResult.status);
    const developmentVariantReady = developmentEnabled !== true
        || cachedSideResult?.developmentProcessed === true;
    if (restoreSideResultVariant(context, numericId, message, cachedSideResult, settings)) {
        try {
            await context.saveMetadata?.();
        } catch (error) {
            console.warn('[Memory Augment] Side-result restoration save failed.', error);
        }
    }
    const cachedStatus = getStoryStatusAt(context, numericId);
    const developmentProcessed = isCharacterDevelopmentProcessed(context, numericId, sourceHash);
    const hasRequiredCache = (!barrageEnabled || cached?.content)
        && statusVariantReady
        && developmentVariantReady
        && (!statusEnabled || cachedStatus)
        && (!developmentEnabled || developmentProcessed);
    if (!options.force && !options.forceStatus && options.refreshDerived !== true && hasRequiredCache) {
        if (barrageEnabled) safelyRender(render, numericId, cached.content, 'ready');
        refreshStoryStatusUi(context);
        refreshCharacterDevelopmentUi(context);
        return { generated: false, cached: true };
    }
    if (options.force && barrageEnabled && cached) {
        deleteBarrageVariant(store, numericId, message);
        try {
            await context.saveMetadata?.();
        } catch (error) {
            console.warn('[Memory Augment] Stale barrage removal save failed.', error);
        }
    }
    const requestBarrage = options.forceStatus !== true
        && barrageEnabled && (options.force || !cached?.content);
    const requestStatus = statusEnabled
        && (options.forceStatus === true || options.refreshDerived === true || !statusVariantReady);
    const requestDevelopment = options.forceStatus !== true && developmentEnabled
        && (options.refreshDerived === true || !developmentVariantReady);
    if (!requestBarrage && !requestStatus && !requestDevelopment) {
        return { generated: false, reason: 'no-output-requested' };
    }

    const requestKey = `${chatId}:${numericId}:${sourceHash}:${Number(requestBarrage)}${Number(requestStatus)}${Number(requestDevelopment)}`;
    if (inFlight.has(requestKey)) {
        return inFlight.get(requestKey);
    }

    const task = (async () => {
        if (requestBarrage) safelyRender(render, numericId, '正在生成观众弹幕…', 'loading');
        else if (barrageEnabled && cached?.content) safelyRender(render, numericId, cached.content, 'ready');
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
        const statusOptions = {
            customFields: Array.isArray(settings?.status?.customFields) ? settings.status.customFields : [],
            showGoals: settings?.status?.showGoals !== false,
        };
        const previousStatusRecord = getLatestStoryStatus(context, { beforeMessageId: numericId });
        const previousStatus = applyStoryStatusOptions(previousStatusRecord?.status, statusOptions);
        const previousTimeline = previousStatusRecord
            ? getMessageTimelineMetadata(context, previousStatusRecord.messageId)
            : null;
        const developmentSnapshot = developmentEnabled
            ? getCharacterDevelopmentSnapshot(context, {
                includeCandidates: true,
                compactCandidates: true,
                limitCandidates: 40,
                limitProfiles: 12,
            })
            : null;
        let characterBaselines = null;
        if (requestDevelopment) {
            try {
                characterBaselines = await buildCharacterBaselines(settings, context, { previousStatus, recentMessages });
            } catch (error) {
                console.warn('[Memory Augment] Character baseline loading failed; continuing conservatively.', error);
                characterBaselines = {
                    mode: developmentSource || 'unknown',
                    known: false,
                    entries: [],
                    note: '人物初始基准读取失败；禁止自动推断人物变化。',
                };
            }
        }
        const requestPayload = {
            barrage,
            systemPrompt: String(settings.barrage.systemPrompt ?? '').trim(),
            maxTokens: settings.barrage.maxTokens,
            recentMessages,
            ragFragments,
            previousStatus,
            previousTimeline,
            developmentSnapshot,
            characterBaselines,
            statusOptions,
            outputOptions: {
                barrageEnabled: requestBarrage,
                statusEnabled: requestStatus,
                developmentEnabled: requestDevelopment,
            },
        };
        const response = await request(requestPayload);
        let parsed = parseSideResponse(response?.content);
        let statusRecoveryError = null;
        if (requestStatus && !parsed.status) {
            try {
                const recoveryResponse = await request({
                    ...requestPayload,
                    outputOptions: {
                        barrageEnabled: false,
                        statusEnabled: true,
                        developmentEnabled: false,
                    },
                });
                const recovered = parseSideResponse(recoveryResponse?.content);
                if (recovered.status) {
                    parsed = {
                        ...parsed,
                        status: recovered.status,
                        timeline: recovered.timeline,
                    };
                } else {
                    statusRecoveryError = new Error('副 API 连续两次没有返回有效的剧情状态。');
                }
            } catch (error) {
                statusRecoveryError = error;
            }
        }
        const generatedContent = parsed.barrage;
        if (requestBarrage && !generatedContent) {
            throw new Error('Barrage endpoint returned empty content.');
        }

        const currentContext = dependencies.getCurrentContext?.()
            ?? globalThis.SillyTavern?.getContext?.()
            ?? context;
        const currentMessage = currentContext.chat?.[numericId];
        if (getChatId(currentContext) !== chatId || hashStorySource(currentMessage?.mes) !== sourceHash) {
            return { generated: false, discarded: true };
        }

        const content = requestBarrage ? generatedContent : String(cached?.content ?? '').trim();
        if (barrageEnabled && content) {
            safelyRender(render, numericId, content, 'ready');
        }
        if (requestBarrage) {
            const currentStore = getBarrageStore(currentContext.chatMetadata, true);
            setBarrageVariant(currentStore, numericId, currentMessage, sourceHash, {
                content,
                timestamp: Math.floor(Date.now() / 1000),
            });
        }
        let finalStatus = requestStatus
            ? applyStoryStatusOptions(parsed.status, statusOptions)
            : applyStoryStatusOptions(cachedSideResult?.status ?? cachedStatus?.status, statusOptions);
        if (requestStatus && finalStatus) {
            clearStoryStatusRecords(currentContext, numericId);
            finalStatus = applyStoryTimelineUpdate(
                currentContext,
                numericId,
                finalStatus,
                parsed.timeline,
                sourceHash,
            ).status;
        }
        const statusSaved = requestStatus
            ? saveStoryStatus(currentContext, numericId, finalStatus, sourceHash)
            : false;
        const currentTimeline = finalStatus
            ? getMessageTimelineMetadata(currentContext, numericId)
            : null;
        let developmentResult = null;
        if (requestDevelopment && response?.partial !== true) {
            clearCharacterDevelopmentRecords(currentContext, numericId);
            developmentResult = applyCharacterDevelopmentUpdate(currentContext, numericId, parsed.development, {
                status: finalStatus,
                timeline: currentTimeline,
                sourceHash,
                characterBaselines,
            });
        }
        if ((requestStatus && finalStatus) || (requestDevelopment && response?.partial !== true)) {
            const currentSideStore = getSideResultStore(currentContext.chatMetadata, true);
            const nextSideResult = {
                ...(cachedSideResult ? cloneSideValue(cachedSideResult) : {}),
                sourceHash,
                timestamp: Math.floor(Date.now() / 1000),
            };
            if (requestStatus && finalStatus) {
                nextSideResult.statusProcessed = true;
                nextSideResult.status = cloneSideValue(finalStatus);
                nextSideResult.timeline = cloneSideValue(parsed.timeline);
            }
            if (requestDevelopment && response?.partial !== true) {
                nextSideResult.developmentProcessed = true;
                nextSideResult.development = cloneSideValue(parsed.development);
            }
            setSideResultVariant(currentSideStore, numericId, currentMessage, nextSideResult);
        }
        try {
            await currentContext.saveMetadata?.();
        } catch (error) {
            console.warn('[Memory Augment] Barrage metadata save failed.', error);
        }
        refreshStoryStatusUi(currentContext);
        if (requestStatus && !finalStatus) {
            const detail = String(statusRecoveryError?.message ?? '副 API 没有返回有效的剧情状态。').trim();
            showSideGenerationDiagnostic(currentContext, `状态栏生成失败：${detail}`, { preserveStatus: false });
        }
        refreshCharacterDevelopmentUi(currentContext);
        return {
            generated: true,
            content,
            status: finalStatus,
            statusSaved,
            development: developmentResult,
            ragCount: ragFragments.length,
        };
    })().catch(async (error) => {
        const currentContext = dependencies.getCurrentContext?.()
            ?? globalThis.SillyTavern?.getContext?.()
            ?? context;
        const currentMessage = currentContext.chat?.[numericId];
        if (getChatId(currentContext) === chatId && hashStorySource(currentMessage?.mes) === sourceHash) {
            const detail = String(error?.message ?? error ?? '未知错误').trim();
            if (requestBarrage) {
                safelyRender(render, numericId, `弹幕生成失败：${detail}`, 'error');
                const currentStore = getBarrageStore(currentContext.chatMetadata, true);
                setBarrageVariant(currentStore, numericId, currentMessage, sourceHash, {
                    state: 'error',
                    error: detail,
                    timestamp: Math.floor(Date.now() / 1000),
                });
                try {
                    await currentContext.saveMetadata?.();
                } catch (saveError) {
                    console.warn('[Memory Augment] Barrage failure metadata save failed.', saveError);
                }
            } else if (barrageEnabled && cached?.content) {
                safelyRender(render, numericId, cached.content, 'ready');
            }
            if (requestStatus) {
                showSideGenerationDiagnostic(currentContext, `状态栏生成失败：${detail}`, { preserveStatus: false });
            }
        }
        console.warn('[Memory Augment] Barrage generation failed.', error);
        return { generated: false, error };
    }).finally(() => inFlight.delete(requestKey));

    inFlight.set(requestKey, task);
    return task;
}

export function restoreStoredBarrages(context, settings, render = renderBarragePanel) {
    if (settings?.barrage?.enabled !== true) return;
    const store = getBarrageStore(context.chatMetadata);
    let migrated = false;
    for (const [messageId] of Object.entries(store)) {
        const message = context.chat?.[Number(messageId)];
        if (!message || message.is_user || message.is_system) {
            delete store[messageId];
            migrated = true;
            continue;
        }

        const normalizedBucket = normalizeBarrageBucket(store, messageId, message);
        const bucket = normalizedBucket.bucket;
        if (normalizedBucket.migrated) migrated = true;
        if (!bucket) continue;

        // A SillyTavern floor can contain several swiped replies. Keep each
        // candidate's barrage by swipe slot; editing its text must not change
        // that identity.
        const validVariantKeys = getBarrageVariantKeys(message);
        for (const storedKey of Object.keys(bucket.variants)) {
            if (!validVariantKeys.has(storedKey)) {
                delete bucket.variants[storedKey];
                migrated = true;
            }
        }
        if (Object.keys(bucket.variants).length === 0) {
            delete store[messageId];
            migrated = true;
            continue;
        }
        store[messageId] = bucket;

        const variantKey = getBarrageVariantKey(message);
        const normalized = normalizeStoredBarrage(bucket.variants[variantKey]);
        if (!normalized) {
            continue;
        }
        const state = normalized.state === 'error' ? 'error' : 'ready';
        const content = state === 'error'
            ? `弹幕生成失败：${normalized.error}\n点击下方“重新生成弹幕”即可重试本楼。`
            : normalized.content;
        safelyRender(render, messageId, content, state);
    }
    if (migrated) {
        void Promise.resolve(context.saveMetadata?.())
            .catch(error => console.warn('[Memory Augment] Barrage metadata migration save failed.', error));
    }
}

export function clearDeletedBarrageRecords(context, firstDeletedMessageId, { save = true } = {}) {
    const numericId = Number(firstDeletedMessageId);
    if (!Number.isInteger(numericId) || numericId < 0) return false;
    const store = getBarrageStore(context?.chatMetadata);
    let changed = false;
    for (const messageId of Object.keys(store)) {
        const storedId = Number(messageId);
        if (Number.isInteger(storedId) && storedId >= numericId) {
            delete store[messageId];
            changed = true;
        }
    }
    if (!changed) return false;
    if (save) {
        return Promise.resolve(context.saveMetadata?.())
            .catch(error => console.warn('[Memory Augment] Deleted barrage cleanup save failed.', error))
            .then(() => true);
    }
    return true;
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

export function findLatestEligibleAssistantMessageId(context) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        const content = String(message?.mes ?? '').trim();
        if (!message || message.is_user || message.is_system || !content || content === '...') continue;
        if (!chat.slice(0, index).some(item => item?.is_user)) continue;
        return index;
    }
    return -1;
}

export function scheduleLatestSideGeneration(settings, context = globalThis.SillyTavern?.getContext?.(), options = {}) {
    if (!context) return false;
    if (options.requireVisibleOutput !== false
        && settings?.barrage?.enabled !== true
        && settings?.status?.enabled !== true) return false;
    const messageId = findLatestEligibleAssistantMessageId(context);
    if (messageId < 0) return false;
    scheduleBarrageGeneration(messageId, settings, options.generationOptions ?? {});
    return true;
}

function invalidateDerivedResults(messageId, { dropCurrentVariant = false } = {}) {
    const currentContext = SillyTavern.getContext();
    const message = currentContext.chat?.[Number(messageId)];
    const variantChanged = dropCurrentVariant && message
        ? deleteSideResultVariant(getSideResultStore(currentContext.chatMetadata), messageId, message)
        : false;
    const statusChanged = clearStoryStatusRecords(currentContext, messageId);
    const developmentChanged = clearCharacterDevelopmentRecords(currentContext, messageId);
    if (variantChanged || statusChanged || developmentChanged) {
        void Promise.resolve(currentContext.saveMetadata?.())
            .catch(error => console.warn('[Memory Augment] Changed reply cleanup save failed.', error));
    }
    refreshStoryStatusUi(currentContext);
    refreshCharacterDevelopmentUi(currentContext);
    return currentContext;
}

function activateStoredSideResult(messageId, settings) {
    const currentContext = SillyTavern.getContext();
    const message = currentContext.chat?.[Number(messageId)];
    if (!message) return false;
    const record = getSideResultVariant(
        getSideResultStore(currentContext.chatMetadata),
        messageId,
        message,
    ).record;
    let changed = false;
    if (record) {
        changed = restoreSideResultVariant(currentContext, messageId, message, record, settings);
    } else {
        const statusChanged = clearStoryStatusRecords(currentContext, messageId);
        const developmentChanged = clearCharacterDevelopmentRecords(currentContext, messageId);
        changed = statusChanged || developmentChanged;
    }
    if (changed) {
        void Promise.resolve(currentContext.saveMetadata?.())
            .catch(error => console.warn('[Memory Augment] Swiped side-result activation save failed.', error));
    }
    refreshStoryStatusUi(currentContext);
    refreshCharacterDevelopmentUi(currentContext);
    return Boolean(record);
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
        const panel = event.target.closest?.('.memory-augment-barrage');
        if (panel) {
            // The panel lives inside .mes_text so it can inherit custom message widths.
            // Keep its controls from bubbling into SillyTavern's click-to-edit handler.
            event.stopPropagation();
        }
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

function getLatestAssistantMessageId(context) {
    for (let index = (context?.chat?.length ?? 0) - 1; index >= 0; index--) {
        const message = context.chat[index];
        const text = String(message?.mes ?? '').trim();
        if (!message?.is_user && !message?.is_system && text && text !== '...') return index;
    }
    return -1;
}

function bindStatusRegeneration(settings) {
    if (statusRegenerationBound) return;
    document.addEventListener('memory-augment-regenerate-story-status', async (event) => {
        const button = event.detail?.button
            ?? document.querySelector('#memory_augment_story_status_regenerate');
        if (button?.dataset?.busy === 'true') return;
        const context = SillyTavern.getContext();
        const messageId = getLatestAssistantMessageId(context);
        if (settings?.status?.enabled !== true || messageId < 0) return;
        const message = context.chat[messageId];
        if (button) {
            button.dataset.busy = 'true';
            button.disabled = true;
            button.textContent = '状态栏生成中…';
        }
        try {
            const sideChanged = clearSideResultStatus(
                getSideResultStore(context.chatMetadata),
                messageId,
                message,
            );
            const statusChanged = clearStoryStatusRecords(context, messageId);
            if (sideChanged || statusChanged) await context.saveMetadata?.();
            refreshStoryStatusUi(context);
            const result = await handleCharacterMessageRendered(
                messageId,
                settings,
                context,
                {},
                { forceStatus: true },
            );
            if (button) button.textContent = result?.statusSaved ? '状态栏已更新' : '生成失败，请重试';
        } catch (error) {
            console.warn('[Memory Augment] Story status regeneration failed.', error);
            if (button) button.textContent = '生成失败，请重试';
        } finally {
            if (button) {
                setTimeout(() => {
                    button.textContent = '重新生成状态栏';
                    delete button.dataset.busy;
                    button.disabled = settings?.status?.enabled !== true;
                }, 1200);
            }
        }
    });
    statusRegenerationBound = true;
}

export async function initializeBarrageUi(settings, options = {}) {
    const context = SillyTavern.getContext();
    initializeStoryStatusUi(context, settings);
    barrageTemplate = '';
    void Promise.resolve()
        .then(() => context.renderExtensionTemplateAsync(options.templatePath, 'barrage'))
        .then(template => { barrageTemplate = String(template ?? ''); })
        .catch(error => console.warn('[Memory Augment] Barrage template loading failed; using built-in panel.', error));
    const messageRendered = context.eventTypes?.CHARACTER_MESSAGE_RENDERED
        ?? context.event_types?.CHARACTER_MESSAGE_RENDERED;
    const messageSwiped = context.eventTypes?.MESSAGE_SWIPED
        ?? context.event_types?.MESSAGE_SWIPED;
    const messageUpdated = context.eventTypes?.MESSAGE_UPDATED
        ?? context.event_types?.MESSAGE_UPDATED;
    const messageDeleted = context.eventTypes?.MESSAGE_DELETED
        ?? context.event_types?.MESSAGE_DELETED;
    const chatChanged = context.eventTypes?.CHAT_CHANGED ?? context.event_types?.CHAT_CHANGED;
    const generationEnded = context.eventTypes?.GENERATION_ENDED ?? context.event_types?.GENERATION_ENDED;
    const generationStopped = context.eventTypes?.GENERATION_STOPPED ?? context.event_types?.GENERATION_STOPPED;

    if (!messageRendered) {
        console.warn('[Memory Augment] CHARACTER_MESSAGE_RENDERED event is unavailable for barrage UI.');
    }

    if (!barrageLifecycleBound) {
        if (messageRendered) context.eventSource.on(messageRendered, (messageId) => {
            scheduleBarrageGeneration(messageId, settings);
        });

        const recoverLatest = () => scheduleLatestSideGeneration(settings, SillyTavern.getContext(), {
            requireVisibleOutput: false,
        });
        if (generationEnded) context.eventSource.on(generationEnded, recoverLatest);
        if (generationStopped) context.eventSource.on(generationStopped, recoverLatest);
    }

    if (!barrageLifecycleBound && messageSwiped) {
        context.eventSource.on(messageSwiped, (messageId) => {
            activateStoredSideResult(messageId, settings);
            scheduleBarrageGeneration(messageId, settings);
        });
    }

    if (!barrageLifecycleBound && messageUpdated) {
        context.eventSource.on(messageUpdated, (messageId) => {
            // SillyTavern rebuilds .mes_text after an edit, which removes the
            // injected panel from the DOM. Reattach the same swipe's cached
            // barrage after that rebuild; do not regenerate it automatically.
            invalidateDerivedResults(messageId, { dropCurrentVariant: true });
            scheduleBarrageGeneration(messageId, settings, { refreshDerived: true });
        });
    }

    if (!barrageLifecycleBound && messageDeleted) {
        context.eventSource.on(messageDeleted, async (messageId) => {
            try {
                const currentContext = SillyTavern.getContext();
                const barrageChanged = clearDeletedBarrageRecords(currentContext, messageId, { save: false });
                const sideResultChanged = clearDeletedSideResultRecords(currentContext, messageId);
                const statusChanged = clearStoryStatusRecords(currentContext, messageId);
                const developmentChanged = clearCharacterDevelopmentRecords(currentContext, messageId);
                if (barrageChanged || sideResultChanged || statusChanged || developmentChanged) {
                    await currentContext.saveMetadata?.();
                }
                refreshStoryStatusUi(currentContext);
                refreshCharacterDevelopmentUi(currentContext);
            } catch (error) {
                console.warn('[Memory Augment] Deleted side-result cleanup failed.', error);
            }
        });
    }

    if (!barrageLifecycleBound && chatChanged) {
        context.eventSource.on(chatChanged, () => {
            setTimeout(() => {
                try {
                    restoreStoredBarrages(SillyTavern.getContext(), settings);
                } catch (error) {
                    console.warn('[Memory Augment] Stored barrage restoration failed.', error);
                }
            }, 0);
        });
    }

    bindRegeneration(settings);
    bindStatusRegeneration(settings);
    try {
        restoreStoredBarrages(context, settings);
    } catch (error) {
        console.warn('[Memory Augment] Stored barrage restoration failed.', error);
    }
    barrageLifecycleBound = true;
    scheduleLatestSideGeneration(settings, context);
}

export function refreshBarrageVisibility(settings, context = globalThis.SillyTavern?.getContext?.()) {
    if (typeof document === 'undefined') return;
    const enabled = settings?.barrage?.enabled === true;
    document.querySelectorAll('.memory-augment-barrage').forEach(panel => panel.hidden = !enabled);
    if (enabled && context) restoreStoredBarrages(context, settings);
}

export { BARRAGE_METADATA_KEY, SIDE_RESULT_METADATA_KEY };
