import { createEmbeddings } from './browser-api-client.js';
import { normalizeBaseUrl } from './api-utils.js';

const VECTOR_SOURCE = 'webllm';
const STORE_VERSION = 1;
const CHAT_KIND = 'chat';
const WORLDINFO_KIND = 'worldinfo';
const locks = new Map();

function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? {};
}

function getRequestHeaders() {
    return {
        'Content-Type': 'application/json',
        ...(getContext().getRequestHeaders?.() ?? {}),
    };
}

function clampInteger(value, fallback, minimum, maximum) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function stableHash(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function hashHex(value) {
    return stableHash(value).toString(16).padStart(8, '0');
}

function embeddingSignature(config) {
    return hashHex(`${normalizeBaseUrl(config?.baseUrl)}\n${String(config?.model ?? '').trim()}`);
}

function getModelScope(config) {
    return `kktoolbox-${embeddingSignature(config)}`;
}

function getScope(kind, id) {
    const scopeId = String(id ?? '').trim();
    if (!scopeId) throw new Error(`${kind} ID 不能为空。`);
    const short = hashHex(scopeId);
    return {
        kind,
        id: scopeId,
        key: `${kind}:${scopeId}`,
        collectionId: `kktoolbox_${kind}_${short}`,
        fileName: `kktoolbox_${kind}_${short}.json`,
        relativePath: `user/files/kktoolbox_${kind}_${short}.json`,
        url: `/user/files/kktoolbox_${kind}_${short}.json`,
    };
}

function emptyDocument(scope) {
    return {
        version: STORE_VERSION,
        kind: scope.kind,
        scope_id: scope.id,
        embedding_signature: '',
        vector_dimension: 0,
        updated_at: 0,
        chunks: [],
        migration: {},
    };
}

function normalizeDocument(value, scope) {
    const document = value && typeof value === 'object' ? value : {};
    return {
        ...emptyDocument(scope),
        ...document,
        kind: scope.kind,
        scope_id: scope.id,
        chunks: Array.isArray(document.chunks) ? document.chunks : [],
        migration: document.migration && typeof document.migration === 'object'
            ? document.migration
            : {},
    };
}

async function withLock(scope, task) {
    const previous = locks.get(scope.key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    locks.set(scope.key, current);
    try {
        return await current;
    } finally {
        if (locks.get(scope.key) === current) locks.delete(scope.key);
    }
}

async function readScope(scope) {
    const response = await fetch(`${scope.url}?v=${Date.now()}`, {
        headers: getRequestHeaders(),
        cache: 'no-store',
    });
    if (response.status === 404) return emptyDocument(scope);
    if (!response.ok) {
        throw new Error(`读取 KKToolbox 数据文件失败（${response.status}）。`);
    }
    return normalizeDocument(await response.json(), scope);
}

function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
    }
    return btoa(binary);
}

async function writeScope(scope, document) {
    const normalized = normalizeDocument(document, scope);
    normalized.updated_at = Math.floor(Date.now() / 1000);
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            name: scope.fileName,
            data: encodeBase64Utf8(`${JSON.stringify(normalized)}\n`),
        }),
    });
    if (!response.ok) {
        throw new Error(`保存 KKToolbox 数据文件失败（${response.status}）。`);
    }
    return normalized;
}

async function deleteScopeFile(scope) {
    const response = await fetch('/api/files/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ path: scope.relativePath }),
    });
    if (!response.ok && response.status !== 404) {
        throw new Error(`删除 KKToolbox 数据文件失败（${response.status}）。`);
    }
}

async function vectorRequest(endpoint, payload, expectJson = true) {
    const response = await fetch(`/api/vector/${endpoint}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        throw new Error(`酒馆向量接口 ${endpoint} 失败（${response.status}）。`);
    }
    return expectJson ? response.json() : undefined;
}

function baseVectorPayload(scope, config, embeddings = {}) {
    return {
        collectionId: scope.collectionId,
        source: VECTOR_SOURCE,
        model: getModelScope(config),
        embeddings,
    };
}

async function listVectorHashes(scope, config) {
    return vectorRequest('list', baseVectorPayload(scope, config));
}

async function purgeVectorScope(scope) {
    return vectorRequest('purge', { collectionId: scope.collectionId }, false);
}

async function deleteVectorHashes(scope, config, hashes) {
    if (!Array.isArray(hashes) || hashes.length === 0) return;
    await vectorRequest('delete', {
        ...baseVectorPayload(scope, config),
        hashes,
    }, false);
}

async function insertChunks(scope, config, chunks) {
    if (!Array.isArray(chunks) || chunks.length === 0) return 0;
    const vectors = await createEmbeddings(chunks.map(chunk => chunk.text), config);
    const embeddings = {};
    chunks.forEach((chunk, index) => {
        embeddings[chunk.text] = vectors[index];
        chunk.vector_dimension = vectors[index].length;
    });
    await vectorRequest('insert', {
        ...baseVectorPayload(scope, config, embeddings),
        items: chunks.map((chunk, index) => ({
            hash: chunk.vector_hash,
            text: chunk.text,
            index: Number(chunk.message_id ?? chunk.segment_index ?? index),
        })),
    }, false);
    return chunks.length;
}

function assignVectorHashes(chunks, signature) {
    const used = new Set();
    for (const chunk of chunks) {
        let value = stableHash(`${chunk.id}\n${chunk.text}\n${signature}`);
        while (used.has(value)) value = (value + 1) >>> 0;
        used.add(value);
        chunk.vector_hash = value;
    }
}

async function ensureIndexed(scope, document, config, { force = false } = {}) {
    const signature = embeddingSignature(config);
    const active = document.chunks.filter(chunk => chunk?.disabled !== true && String(chunk?.text ?? '').trim());
    const signatureChanged = document.embedding_signature !== signature;
    if (signatureChanged || force) {
        await purgeVectorScope(scope);
        assignVectorHashes(document.chunks, signature);
        const embedded = await insertChunks(scope, config, active);
        document.embedding_signature = signature;
        document.vector_dimension = active[0]?.vector_dimension ?? 0;
        await writeScope(scope, document);
        return { embedded, removed: 0, rebuilt: true, written: true };
    }

    assignVectorHashes(document.chunks, signature);
    const saved = new Set((await listVectorHashes(scope, config)).map(Number));
    const activeHashes = new Set(active.map(chunk => Number(chunk.vector_hash)));
    const removed = [...saved].filter(hash => !activeHashes.has(hash));
    const missing = active.filter(chunk => !saved.has(Number(chunk.vector_hash)));
    await deleteVectorHashes(scope, config, removed);
    const embedded = await insertChunks(scope, config, missing);
    document.vector_dimension = active.find(chunk => chunk.vector_dimension)?.vector_dimension
        ?? document.vector_dimension
        ?? 0;
    const written = removed.length > 0 || embedded > 0;
    if (written) await writeScope(scope, document);
    return { embedded, removed: removed.length, rebuilt: false, written };
}

function getCharacterCount(text) {
    return Array.from(String(text ?? '')).length;
}

function isNaturalBoundary(character) {
    return /[。！？?!…\n\r]/u.test(character);
}

function isSecondaryBoundary(character) {
    return /[，；;]/u.test(character);
}

function findLastBoundary(characters, start, end, predicate) {
    for (let index = Math.min(end, characters.length) - 1; index >= start; index--) {
        if (predicate(characters[index])) return index + 1;
    }
    return -1;
}

function findNextBoundary(characters, start, end, predicate) {
    for (let index = start; index < Math.min(end, characters.length); index++) {
        if (predicate(characters[index])) return index + 1;
    }
    return -1;
}

export function splitMessageText(text, targetChars = 400) {
    const normalized = String(text ?? '').trim();
    if (!normalized) return [];
    const target = clampInteger(targetChars, 400, 100, 2000);
    const minimumNaturalBreak = Math.max(1, Math.floor(target * 0.6));
    const hardLimit = Math.max(600, Math.ceil(target * 1.5));
    const characters = Array.from(normalized);
    if (characters.length <= target) return [normalized];
    const segments = [];
    let start = 0;
    while (characters.length - start > target) {
        const targetEnd = Math.min(characters.length, start + target);
        const hardEnd = Math.min(characters.length, start + hardLimit);
        let end = findLastBoundary(characters, start + minimumNaturalBreak, targetEnd, isNaturalBoundary);
        if (end < 0) end = findNextBoundary(characters, targetEnd, hardEnd, isNaturalBoundary);
        if (end < 0) end = findLastBoundary(characters, start + minimumNaturalBreak, targetEnd, isSecondaryBoundary);
        if (end < 0) end = findNextBoundary(characters, targetEnd, hardEnd, isSecondaryBoundary);
        if (end < 0) end = hardEnd;
        const segment = characters.slice(start, end).join('').trim();
        if (segment) segments.push(segment);
        start = end;
    }
    const tail = characters.slice(start).join('').trim();
    if (tail) {
        if (getCharacterCount(tail) < 100 && segments.length > 0) segments[segments.length - 1] += tail;
        else segments.push(tail);
    }
    return segments;
}

export function splitMessageTextWithTimeline(text, targetChars = 400, timeline = null) {
    const normalized = String(text ?? '').trim();
    if (!normalized) return [];
    const hasLocatedTransition = (Array.isArray(timeline?.segments) ? timeline.segments : [])
        .some(segment => String(segment?.startQuote ?? '').trim()
            && normalized.includes(String(segment.startQuote).trim()));
    const fallback = timeline && typeof timeline === 'object' ? {
        anchorId: String(hasLocatedTransition
            ? timeline.precedingSceneAnchorId || timeline.sceneAnchorId || ''
            : timeline.sceneAnchorId ?? ''),
        time: String(hasLocatedTransition
            ? timeline.precedingSceneTime || timeline.sceneTime || ''
            : timeline.sceneTime ?? ''),
        mainlineAnchorId: String(hasLocatedTransition
            ? timeline.precedingMainlineAnchorId || timeline.mainlineAnchorId || ''
            : timeline.mainlineAnchorId ?? ''),
        mainlineTime: String(hasLocatedTransition
            ? timeline.precedingMainlineTime || timeline.mainlineTime || ''
            : timeline.mainlineTime ?? ''),
        mode: 'unknown',
        relation: '',
    } : null;
    const located = (Array.isArray(timeline?.segments) ? timeline.segments : [])
        .map((segment) => {
            const quote = String(segment?.startQuote ?? '').trim();
            const offset = quote ? normalized.indexOf(quote) : -1;
            if (offset < 0) return null;
            return {
                offset,
                timeline: {
                    anchorId: String(segment?.anchorId ?? ''),
                    time: String(segment?.anchorLabel ?? segment?.time ?? ''),
                    mainlineAnchorId: String(timeline?.mainlineAnchorId ?? ''),
                    mainlineTime: String(timeline?.mainlineTime ?? ''),
                    mode: String(segment?.mode ?? 'unknown'),
                    relation: String(segment?.relation ?? ''),
                },
            };
        })
        .filter(Boolean)
        .sort((left, right) => left.offset - right.offset)
        .filter((item, index, items) => index === 0 || item.offset !== items[index - 1].offset);
    const boundaries = [{ offset: 0, timeline: fallback }];
    for (const item of located) {
        if (item.offset === 0) boundaries[0] = item;
        else boundaries.push(item);
    }
    return boundaries.flatMap((boundary, index) => {
        const end = boundaries[index + 1]?.offset ?? normalized.length;
        const section = normalized.slice(boundary.offset, end).trim();
        return splitMessageText(section, targetChars).map(segment => ({
            text: segment,
            timeline: boundary.timeline,
        }));
    });
}

function normalizeMessages(messages, message) {
    const input = Array.isArray(messages) ? messages : message ? [message] : [];
    const byId = new Map();
    input.forEach((item, index) => {
        const text = String(item?.text ?? item?.mes ?? '').trim();
        if (!text) return;
        const id = ['string', 'number'].includes(typeof item?.id) ? item.id : index;
        byId.set(String(id), {
            id,
            role: item?.role === 'user' ? 'user' : 'assistant',
            text,
            timestamp: Number(item?.timestamp) || Math.floor(Date.now() / 1000),
            timeline: item?.timeline && typeof item.timeline === 'object' ? item.timeline : null,
        });
    });
    return [...byId.values()];
}

function buildChatDrafts(chatId, messages, targetChars) {
    return messages.flatMap(message => splitMessageTextWithTimeline(message.text, targetChars, message.timeline)
        .map(({ text, timeline }, segmentIndex) => ({
            id: `msg${message.id}_seg${segmentIndex}`,
            chat_id: String(chatId),
            message_id: message.id,
            segment_index: segmentIndex,
            role: message.role,
            text,
            char_count: getCharacterCount(text),
            timestamp: message.timestamp,
            type: CHAT_KIND,
            manual_override: false,
            disabled: false,
            ...(timeline ? {
                timeline_anchor_id: timeline.anchorId,
                timeline_time: timeline.time,
                timeline_mainline_anchor_id: timeline.mainlineAnchorId,
                timeline_mainline_time: timeline.mainlineTime,
                timeline_mode: timeline.mode,
                timeline_relation: timeline.relation,
            } : {}),
        })));
}

function hasManualControl(chunk) {
    return chunk?.manual_override === true || chunk?.disabled === true;
}

export async function ingestChatScope(payload) {
    const scope = getScope(CHAT_KIND, payload?.chatId);
    const messages = normalizeMessages(payload?.messages, payload?.message);
    if (messages.length === 0) throw new Error('没有可写入向量库的聊天消息。');
    return withLock(scope, async () => {
        const document = await readScope(scope);
        const existingById = new Map(document.chunks.map(chunk => [chunk.id, chunk]));
        const drafts = buildChatDrafts(scope.id, messages, payload?.targetChars);
        for (const draft of drafts) {
            const saved = existingById.get(draft.id);
            if (saved?.manual_override === true) {
                draft.source_text = draft.text;
                draft.text = String(saved.text ?? draft.text).trim();
                draft.char_count = getCharacterCount(draft.text);
                draft.manual_override = true;
                draft.manual_updated_at = Number(saved.manual_updated_at) || draft.timestamp;
            }
            if (saved?.disabled === true) draft.disabled = true;
        }
        const incomingIds = new Set(messages.map(message => String(message.id)));
        const draftIds = new Set(drafts.map(chunk => chunk.id));
        const preservedManual = document.chunks.filter(chunk => hasManualControl(chunk)
            && (payload?.force === true || payload?.reconcile === true
                || incomingIds.has(String(chunk.message_id)))
            && !draftIds.has(chunk.id));
        const unaffected = payload?.force === true || payload?.reconcile === true
            ? []
            : document.chunks.filter(chunk => !incomingIds.has(String(chunk.message_id)));
        document.chunks = [...unaffected, ...drafts, ...preservedManual];
        const indexResult = await ensureIndexed(scope, document, payload?.embedding, {
            force: payload?.force === true,
        });
        if (!indexResult.written) await writeScope(scope, document);
        return {
            accepted: messages.length,
            chunks: drafts.length,
            embedded: indexResult.embedded,
            reused: Math.max(0, drafts.length - indexResult.embedded),
            preservedManual: preservedManual.length + drafts.filter(hasManualControl).length,
            chunkIds: drafts.map(chunk => chunk.id),
        };
    });
}

export async function importLegacyChatScope(payload) {
    const scope = getScope(CHAT_KIND, payload?.chatId);
    const legacyItems = Array.isArray(payload?.items) ? payload.items : [];
    return withLock(scope, async () => {
        const current = await readScope(scope);
        if (current.chunks.length > 0) {
            return { imported: 0, skipped: true };
        }

        const chunks = legacyItems
            .map((item, index) => {
                const text = String(item?.text ?? '').trim();
                const messageId = item?.message_id;
                if (!text || messageId === undefined || messageId === null) return null;
                const segmentIndex = clampInteger(item?.segment_index, 0, 0, 100_000);
                return {
                    id: String(item?.id ?? `msg${messageId}_seg${segmentIndex}`),
                    chat_id: scope.id,
                    message_id: messageId,
                    segment_index: segmentIndex,
                    role: item?.role === 'user' ? 'user' : 'assistant',
                    text,
                    ...(item?.source_text ? { source_text: String(item.source_text) } : {}),
                    char_count: getCharacterCount(text),
                    timestamp: Number(item?.timestamp) || Math.floor(Date.now() / 1000),
                    type: CHAT_KIND,
                    manual_override: item?.manual_override === true,
                    disabled: item?.disabled === true,
                    manual_updated_at: Number(item?.manual_updated_at) || undefined,
                };
            })
            .filter(Boolean);
        if (chunks.length === 0) return { imported: 0, skipped: false };

        const document = {
            ...current,
            chunks,
            migration: {
                ...current.migration,
                legacy_server_plugin: {
                    imported_at: Math.floor(Date.now() / 1000),
                    chunk_count: chunks.length,
                },
            },
        };
        const indexResult = await ensureIndexed(scope, document, payload?.embedding, { force: true });
        return {
            imported: chunks.length,
            embedded: indexResult.embedded,
            disabled: chunks.filter(chunk => chunk.disabled).length,
            manual: chunks.filter(chunk => chunk.manual_override).length,
            skipped: false,
        };
    });
}

export async function reconcileChatScope(payload) {
    const scope = getScope(CHAT_KIND, payload?.chatId);
    const currentIds = new Set((Array.isArray(payload?.messageIds) ? payload.messageIds : []).map(String));
    return withLock(scope, async () => {
        const document = await readScope(scope);
        const storedIds = new Set(document.chunks.map(chunk => String(chunk.message_id)));
        let removedChunks = 0;
        document.chunks = document.chunks.filter((chunk) => {
            const keep = hasManualControl(chunk) || currentIds.has(String(chunk.message_id));
            if (!keep) removedChunks++;
            return keep;
        });
        if (payload?.embedding) {
            await ensureIndexed(scope, document, payload.embedding);
        } else if (removedChunks > 0) {
            await writeScope(scope, document);
        }
        return {
            currentMessageIds: [...currentIds],
            storedMessageIds: [...storedIds],
            orphanMessageIds: [...storedIds].filter(id => !currentIds.has(id)),
            removedChunks,
            preservedManualChunks: document.chunks.filter(chunk => hasManualControl(chunk)
                && !currentIds.has(String(chunk.message_id))).length,
        };
    });
}

function normalizeWorldInfoEntries(entries) {
    return (Array.isArray(entries) ? entries : []).map((entry, index) => {
        const uid = String(entry?.entry_uid ?? entry?.uid ?? entry?.id ?? '').trim();
        const text = String(entry?.text ?? entry?.content ?? '').trim();
        if (!uid || !text) throw new Error(`第 ${index + 1} 个世界书条目无效。`);
        return {
            uid,
            key: String(entry?.entry_key ?? entry?.key ?? entry?.name ?? `Entry ${uid}`).trim(),
            text,
            contentHash: String(entry?.content_hash ?? hashHex(text)),
        };
    });
}

export async function syncWorldInfoScope(payload) {
    const bookId = String(payload?.book_id ?? payload?.bookId ?? '').trim();
    const scope = getScope(WORLDINFO_KIND, bookId);
    const entries = normalizeWorldInfoEntries(payload?.entries);
    return withLock(scope, async () => {
        const previous = await readScope(scope);
        const previousById = new Map(previous.chunks.map(chunk => [chunk.id, chunk]));
        const chunks = entries.flatMap(entry => splitMessageText(entry.text, payload?.targetChars)
            .map((text, segmentIndex) => {
                const id = `book_${bookId}_entry_${entry.uid}${segmentIndex ? `_seg${segmentIndex}` : ''}`;
                const old = previousById.get(id);
                return {
                    id,
                    book_id: bookId,
                    entry_uid: entry.uid,
                    entry_key: entry.key,
                    text,
                    char_count: getCharacterCount(text),
                    content_hash: entry.contentHash,
                    timestamp: old?.text === text && old?.content_hash === entry.contentHash
                        ? old.timestamp
                        : Math.floor(Date.now() / 1000),
                    type: WORLDINFO_KIND,
                    segment_index: segmentIndex,
                    disabled: false,
                };
            }));
        const previousIds = new Set(previous.chunks.map(chunk => chunk.id));
        const currentIds = new Set(chunks.map(chunk => chunk.id));
        const document = { ...previous, chunks };
        const indexResult = await ensureIndexed(scope, document, payload?.embedding);
        return {
            bookId,
            entries: entries.length,
            chunks: chunks.length,
            embedded: indexResult.embedded,
            reused: Math.max(0, chunks.length - indexResult.embedded),
            removed: [...previousIds].filter(id => !currentIds.has(id)).length,
            updatedEntryUids: [...new Set(chunks
                .filter(chunk => previousById.get(chunk.id)?.text !== chunk.text
                    || previousById.get(chunk.id)?.content_hash !== chunk.content_hash)
                .map(chunk => chunk.entry_uid))],
        };
    });
}

export async function getWorldInfoScopeStatuses(bookIds) {
    const statuses = {};
    for (const id of [...new Set((bookIds ?? []).map(String).filter(Boolean))]) {
        const document = await readScope(getScope(WORLDINFO_KIND, id));
        statuses[id] = {
            chunkCount: document.chunks.length,
            entryCount: new Set(document.chunks.map(chunk => String(chunk.entry_uid))).size,
            lastUpdatedAt: Number(document.updated_at) || null,
        };
    }
    return statuses;
}

async function queryScope(scope, document, query, queryVector, config, topK) {
    await ensureIndexed(scope, document, config);
    const active = document.chunks.filter(chunk => chunk?.disabled !== true);
    if (active.length === 0) return [];
    const response = await vectorRequest('query', {
        ...baseVectorPayload(scope, config, { [query]: queryVector }),
        searchText: query,
        topK: Math.min(active.length, Math.max(topK, 1)),
        threshold: 0,
    });
    const chunksByHash = new Map(document.chunks.map(chunk => [Number(chunk.vector_hash), chunk]));
    return (Array.isArray(response?.metadata) ? response.metadata : [])
        .map(metadata => chunksByHash.get(Number(metadata?.hash)))
        .filter(Boolean);
}

export async function searchScopes(payload) {
    const query = String(payload?.query ?? '').trim();
    if (!query) return { results: [], chatResults: [], worldInfoResults: [], errors: {} };
    const config = payload?.embedding;
    const errors = {};
    let chatResults = [];
    let worldInfoResults = [];
    const chatId = String(payload?.scope?.chat_id ?? payload?.chatId ?? '').trim();
    const bookIds = [...new Set((payload?.scope?.book_ids ?? []).map(String).filter(Boolean))];
    let chatScopeData = null;
    const worldScopeData = [];

    if (chatId) {
        try {
            const scope = getScope(CHAT_KIND, chatId);
            const document = await readScope(scope);
            chatScopeData = { scope, document };
        } catch (error) {
            errors.chat = String(error?.message ?? error);
        }
    }
    for (const bookId of bookIds) {
        try {
            const scope = getScope(WORLDINFO_KIND, bookId);
            const document = await readScope(scope);
            if (document.chunks.length > 0) worldScopeData.push({ scope, document });
        } catch (error) {
            errors.worldinfo = String(error?.message ?? error);
        }
    }
    const hasChatChunks = chatScopeData?.document?.chunks?.length > 0;
    if (!hasChatChunks && worldScopeData.length === 0) {
        return { results: [], chatResults: [], worldInfoResults: [], errors };
    }

    const [queryVector] = await createEmbeddings([query], config);
    if (hasChatChunks) {
        try {
            const { scope, document } = chatScopeData;
            const beforeRaw = Number(payload?.scope?.chat_message_id_before);
            const before = Number.isInteger(beforeRaw) && beforeRaw >= 0 ? beforeRaw : null;
            const eligible = document.chunks.filter(chunk => chunk?.disabled !== true
                && (before === null || Number(chunk.message_id) < before));
            const ranked = await queryScope(
                scope,
                document,
                query,
                queryVector,
                config,
                document.chunks.filter(chunk => chunk?.disabled !== true).length,
            );
            chatResults = ranked
                .filter(chunk => before === null || Number(chunk.message_id) < before)
                .slice(0, clampInteger(payload?.chatTopK ?? payload?.topK, 20, 1, 100))
                .map(chunk => ({ ...chunk, type: CHAT_KIND }));
            if (eligible.length === 0) chatResults = [];
        } catch (error) {
            errors.chat = String(error?.message ?? error);
        }
    }

    if (worldScopeData.length > 0) {
        try {
            for (const { scope, document } of worldScopeData) {
                await ensureIndexed(scope, document, config);
            }
            const limit = clampInteger(payload?.worldInfoTopK, 7, 1, 100);
            const response = await vectorRequest('query-multi', {
                collectionIds: worldScopeData.map(item => item.scope.collectionId),
                source: VECTOR_SOURCE,
                model: getModelScope(config),
                embeddings: { [query]: queryVector },
                searchText: query,
                topK: limit,
                threshold: 0,
            });
            const scopesByCollection = new Map(worldScopeData.map(item => [item.scope.collectionId, item]));
            worldInfoResults = Object.entries(response ?? {})
                .flatMap(([collectionId, group]) => {
                    const item = scopesByCollection.get(collectionId);
                    if (!item) return [];
                    const chunksByHash = new Map(item.document.chunks
                        .map(chunk => [Number(chunk.vector_hash), chunk]));
                    return (Array.isArray(group?.metadata) ? group.metadata : [])
                        .map(metadata => chunksByHash.get(Number(metadata?.hash)))
                        .filter(Boolean);
                })
                .filter(Boolean)
                .slice(0, limit)
                .map(chunk => ({ ...chunk, type: WORLDINFO_KIND }));
        } catch (error) {
            errors.worldinfo = String(error?.message ?? error);
        }
    }
    return {
        results: [...worldInfoResults, ...chatResults],
        chatResults,
        worldInfoResults,
        errors,
    };
}

export async function listChatScope(chatId, options = {}) {
    const scope = getScope(CHAT_KIND, chatId);
    const document = await readScope(scope);
    const query = String(options?.query ?? '').trim().toLocaleLowerCase();
    const offset = clampInteger(options?.offset, 0, 0, 1_000_000);
    const limit = clampInteger(options?.limit, 50, 1, 200);
    const sorted = [...document.chunks].sort((left, right) => {
        const floor = Number(right.message_id ?? -1) - Number(left.message_id ?? -1);
        return floor || Number(right.segment_index ?? 0) - Number(left.segment_index ?? 0);
    });
    const filtered = query
        ? sorted.filter(chunk => String(chunk.text ?? '').toLocaleLowerCase().includes(query)
            || String(chunk.message_id ?? '').includes(query))
        : sorted;
    return {
        chatId: String(chatId),
        total: filtered.length,
        offset,
        limit,
        hasMore: offset + limit < filtered.length,
        manualCount: sorted.filter(chunk => chunk.manual_override === true).length,
        disabledCount: sorted.filter(chunk => chunk.disabled === true).length,
        items: filtered.slice(offset, offset + limit).map(chunk => ({
            ...chunk,
            vector_dimension: Number(chunk.vector_dimension ?? document.vector_dimension) || 0,
        })),
    };
}

export async function updateChatScope(payload) {
    const scope = getScope(CHAT_KIND, payload?.chatId ?? payload?.chat_id);
    return withLock(scope, async () => {
        const document = await readScope(scope);
        const index = document.chunks.findIndex(chunk => chunk.id === String(payload?.chunkId ?? payload?.chunk_id));
        if (index < 0) throw new Error('没有找到这条聊天记忆。');
        const current = document.chunks[index];
        const next = { ...current };
        if (payload?.restore === true) {
            next.text = String(current.source_text ?? current.text ?? '').trim();
            next.char_count = getCharacterCount(next.text);
            next.manual_override = false;
            next.disabled = false;
            delete next.source_text;
            delete next.manual_updated_at;
        } else {
            if (Object.hasOwn(payload ?? {}, 'text')) {
                const text = String(payload.text ?? '').trim();
                if (!text) throw new Error('记忆文本不能为空。');
                if (current.manual_override !== true) next.source_text = String(current.text ?? '').trim();
                next.text = text;
                next.char_count = getCharacterCount(text);
                next.manual_override = true;
                next.manual_updated_at = Math.floor(Date.now() / 1000);
            }
            if (Object.hasOwn(payload ?? {}, 'disabled')) next.disabled = payload.disabled === true;
        }
        next.timestamp = Math.floor(Date.now() / 1000);
        document.chunks[index] = next;
        await ensureIndexed(scope, document, payload?.embedding);
        return {
            chatId: scope.id,
            item: {
                ...next,
                vector_dimension: Number(next.vector_dimension ?? document.vector_dimension) || 0,
            },
        };
    });
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 ** 2)).toFixed(1)} MiB`;
}

export async function getScopeStatus(chatId) {
    if (!chatId) {
        return { status: 'ok', chunkCount: 0, chatSize: '0 B', lastUpdatedAt: null };
    }
    const document = await readScope(getScope(CHAT_KIND, chatId));
    const metadataBytes = new TextEncoder().encode(JSON.stringify(document)).length;
    const activeCount = document.chunks.filter(chunk => chunk?.disabled !== true).length;
    const estimatedVectorBytes = activeCount * (Number(document.vector_dimension) || 0) * 4;
    return {
        status: 'ok',
        chunkCount: document.chunks.length,
        totalChunkCount: document.chunks.length,
        chatSize: formatBytes(metadataBytes + estimatedVectorBytes),
        lastUpdatedAt: Number(document.updated_at) || null,
    };
}

export async function clearScope(kind, id) {
    const scope = getScope(kind, id);
    return withLock(scope, async () => {
        const document = await readScope(scope);
        await purgeVectorScope(scope);
        await deleteScopeFile(scope);
        return { removed: document.chunks.length };
    });
}

export const clearChatScope = chatId => clearScope(CHAT_KIND, chatId);
export const clearWorldInfoScope = bookId => clearScope(WORLDINFO_KIND, bookId);
export { CHAT_KIND, WORLDINFO_KIND, VECTOR_SOURCE, embeddingSignature };
