'use strict';

const crypto = require('node:crypto');
const { normalizeBaseUrl } = require('./api-url');
const {
    DEFAULT_MAX_TOKENS,
    MAX_MAX_TOKENS,
    buildBarrageUserContent,
    generateBarrage,
} = require('./barrage');
const { createEmbeddings } = require('./embedding');
const { listModels } = require('./models');
const { rerankDocuments } = require('./reranker');
const vectorStore = require('./vector-store');

const info = {
    id: 'st-memory-augment',
    name: 'Memory Augment',
    description: 'Vector RAG memory, summarization, and barrage system',
};

function requireVectorsDirectory(req) {
    const directory = req.user?.directories?.vectors;
    if (!directory) {
        const error = new Error('Authenticated user vector directory is unavailable.');
        error.statusCode = req.user ? 500 : 401;
        throw error;
    }
    return directory;
}

function requireString(value, fieldName) {
    const text = String(value ?? '').trim();
    if (!text) {
        const error = new Error(`${fieldName} is required.`);
        error.statusCode = 400;
        throw error;
    }
    return text;
}

function clampInteger(value, fallback, minimum, maximum) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function normalizeMessages(messages, message) {
    const input = Array.isArray(messages) ? messages : message ? [message] : null;
    if (!input) {
        const error = new Error('message or messages is required.');
        error.statusCode = 400;
        throw error;
    }

    const normalized = input
        .map((message, index) => ({
            id: ['string', 'number'].includes(typeof message?.id) ? message.id : index,
            name: String(message?.name ?? '').trim(),
            role: String(message?.role ?? '').trim(),
            text: String(message?.text ?? message?.mes ?? '').trim(),
            timestamp: Number(message?.timestamp) || 0,
        }))
        .filter(message => message.text);
    const byMessageId = new Map();
    normalized.forEach(message => byMessageId.set(String(message.id), message));
    return [...byMessageId.values()];
}

function hash(value, length = 16) {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function getEmbeddingSignature(config) {
    const baseUrl = normalizeBaseUrl(config?.baseUrl);
    const model = String(config?.model ?? '').trim();
    return hash(`${baseUrl}\n${model}`, 32);
}

function buildWorldInfoChunks(_chatId, entries, vectors, embeddingSignature) {
    return entries.map((entry, index) => {
        const world = String(entry?.book_id ?? entry?.world ?? '').trim();
        const entryId = String(entry?.id ?? entry?.uid ?? '').trim();
        const name = String(entry?.name ?? '').trim() || `Entry ${entryId}`;
        const entryKey = String(entry?.entry_key ?? entry?.key ?? name).trim();
        const text = String(entry?.text ?? '').trim();
        if (!world || !entryId || !text || !Array.isArray(vectors[index])) {
            const error = new Error(`Invalid world info entry at index ${index}.`);
            error.statusCode = 400;
            throw error;
        }

        return {
            id: `book_${world}_entry_${entryId}`,
            book_id: world,
            entry_uid: entryId,
            entry_key: entryKey,
            text,
            char_count: getCharacterCount(text),
            vector: vectors[index],
            content_hash: String(entry?.content_hash ?? hash(text, 32)),
            timestamp: Math.floor(Date.now() / 1000),
            type: 'worldinfo',
            segment_index: 0,
            embedding_signature: embeddingSignature,
        };
    });
}

function getCharacterCount(text) {
    return Array.from(String(text ?? '')).length;
}

function isNaturalBoundary(character) {
    return /[。！？.!?…\n\r]/u.test(character);
}

function isSecondaryBoundary(character) {
    return /[，,；;]/u.test(character);
}

function findLastBoundary(characters, start, end, predicate) {
    for (let index = Math.min(end, characters.length) - 1; index >= start; index--) {
        if (predicate(characters[index])) {
            return index + 1;
        }
    }
    return -1;
}

function findNextBoundary(characters, start, end, predicate) {
    for (let index = start; index < Math.min(end, characters.length); index++) {
        if (predicate(characters[index])) {
            return index + 1;
        }
    }
    return -1;
}

function splitMessageText(text, targetChars = 400) {
    const normalized = String(text ?? '').trim();
    if (!normalized) {
        return [];
    }
    const target = clampInteger(targetChars, 400, 100, 2000);
    const minimumNaturalBreak = Math.max(1, Math.floor(target * 0.6));
    const hardLimit = Math.max(600, Math.ceil(target * 1.5));
    const characters = Array.from(normalized);
    if (characters.length <= target) {
        return [normalized];
    }

    const segments = [];
    let start = 0;
    while (characters.length - start > target) {
        const targetEnd = Math.min(characters.length, start + target);
        const hardEnd = Math.min(characters.length, start + hardLimit);
        let end = findLastBoundary(
            characters,
            start + minimumNaturalBreak,
            targetEnd,
            isNaturalBoundary,
        );
        if (end < 0) {
            end = findNextBoundary(characters, targetEnd, hardEnd, isNaturalBoundary);
        }
        if (end < 0) {
            end = findLastBoundary(characters, start + minimumNaturalBreak, targetEnd, isSecondaryBoundary);
        }
        if (end < 0) {
            end = findNextBoundary(characters, targetEnd, hardEnd, isSecondaryBoundary);
        }
        if (end < 0) {
            end = hardEnd;
        }
        const segment = characters.slice(start, end).join('').trim();
        if (segment) {
            segments.push(segment);
        }
        start = end;
    }

    const tail = characters.slice(start).join('').trim();
    if (tail) {
        if (getCharacterCount(tail) < 100 && segments.length > 0) {
            segments[segments.length - 1] += tail;
        } else {
            segments.push(tail);
        }
    }
    return segments;
}

function buildMessageSegmentDrafts(chatId, messages, targetChars, embeddingSignature) {
    const drafts = [];

    for (const message of messages) {
        const segments = splitMessageText(message.text, targetChars);
        segments.forEach((text, segmentIndex) => drafts.push(vectorStore.createMessageSegmentChunk({
            id: `msg${message.id}_seg${segmentIndex}`,
            chatId,
            messageId: message.id,
            segmentIndex,
            role: message.role === 'user' ? 'user' : 'assistant',
            text,
            charCount: getCharacterCount(text),
            timestamp: message.timestamp || Math.floor(Date.now() / 1000),
            embeddingSignature,
        })));
    }

    return drafts;
}

function normalizeWorldInfoEntries(entries) {
    if (!Array.isArray(entries)) {
        const error = new Error('entries must be an array.');
        error.statusCode = 400;
        throw error;
    }
    return entries.map((entry, index) => {
        const uid = String(entry?.entry_uid ?? entry?.uid ?? entry?.id ?? '').trim();
        const text = String(entry?.text ?? entry?.content ?? '').trim();
        if (!uid || !text) {
            const error = new Error(`Invalid world info entry at index ${index}.`);
            error.statusCode = 400;
            throw error;
        }
        const keys = Array.isArray(entry?.key) ? entry.key.filter(Boolean).join(', ') : entry?.key;
        return {
            uid,
            key: String(entry?.entry_key ?? keys ?? entry?.name ?? `Entry ${uid}`).trim(),
            text,
            contentHash: String(entry?.content_hash ?? hash(text, 32)),
        };
    });
}

function buildWorldInfoDrafts(bookId, entries, targetChars, embeddingSignature) {
    const drafts = [];
    for (const entry of entries) {
        const segments = splitMessageText(entry.text, targetChars);
        segments.forEach((text, segmentIndex) => drafts.push({
            id: `book_${bookId}_entry_${entry.uid}${segmentIndex ? `_seg${segmentIndex}` : ''}`,
            book_id: bookId,
            entry_uid: entry.uid,
            entry_key: entry.key,
            text,
            char_count: getCharacterCount(text),
            content_hash: entry.contentHash,
            timestamp: Math.floor(Date.now() / 1000),
            type: 'worldinfo',
            segment_index: segmentIndex,
            embedding_signature: embeddingSignature,
        }));
    }
    return drafts;
}

async function syncWorldInfo(req) {
    const vectorsDirectory = requireVectorsDirectory(req);
    const bookId = requireString(req.body?.book_id ?? req.body?.bookId, 'book_id');
    const entries = normalizeWorldInfoEntries(req.body?.entries ?? []);
    const targetChars = clampInteger(req.body?.targetChars, 400, 100, 2000);
    const embeddingConfig = req.body?.embedding;
    const embeddingSignature = getEmbeddingSignature(embeddingConfig);
    const drafts = buildWorldInfoDrafts(bookId, entries, targetChars, embeddingSignature);
    const existing = await vectorStore.readWorldInfoChunks(vectorsDirectory, bookId);
    const existingById = new Map(existing.map(chunk => [chunk.id, chunk]));
    const pending = [];
    for (const draft of drafts) {
        const saved = existingById.get(draft.id);
        const reusable = saved?.text === draft.text
            && saved?.content_hash === draft.content_hash
            && saved?.embedding_signature === embeddingSignature
            && Array.isArray(saved?.vector)
            && saved.vector.length > 0;
        if (reusable) {
            draft.vector = saved.vector;
            draft.timestamp = saved.timestamp;
        } else {
            pending.push(draft);
        }
    }
    if (pending.length > 0) {
        const vectors = await createEmbeddings(pending.map(chunk => chunk.text), embeddingConfig);
        pending.forEach((chunk, index) => chunk.vector = vectors[index]);
    }
    await vectorStore.replaceWorldInfoChunks(vectorsDirectory, bookId, drafts);
    const previousIds = new Set(existing.map(chunk => chunk.id));
    const currentIds = new Set(drafts.map(chunk => chunk.id));
    const removed = [...previousIds].filter(id => !currentIds.has(id)).length;
    const updatedEntryUids = [...new Set(pending.map(chunk => String(chunk.entry_uid)))];
    const currentEntryUids = new Set(drafts.map(chunk => String(chunk.entry_uid)));
    const previousEntryUids = new Set(existing.map(chunk => String(chunk.entry_uid ?? chunk.world_info_id ?? '')));
    const unchangedEntryUids = [...currentEntryUids].filter(uid => !updatedEntryUids.includes(uid));
    const removedEntryUids = [...previousEntryUids].filter(uid => uid && !currentEntryUids.has(uid));
    return {
        bookId,
        entries: entries.length,
        chunks: drafts.length,
        embedded: pending.length,
        reused: drafts.length - pending.length,
        removed,
        updatedEntryUids,
        unchangedEntryUids,
        removedEntryUids,
    };
}

async function ingestChat(req) {
    const vectorsDirectory = requireVectorsDirectory(req);
    const chatId = requireString(req.body?.chatId, 'chatId');
    const messages = normalizeMessages(req.body?.messages, req.body?.message);
    if (messages.length === 0) {
        const error = new Error('At least one non-empty message is required.');
        error.statusCode = 400;
        throw error;
    }

    const targetChars = clampInteger(req.body?.targetChars, 400, 100, 2000);
    const embeddingConfig = req.body?.embedding;
    const embeddingSignature = getEmbeddingSignature(embeddingConfig);
    const drafts = buildMessageSegmentDrafts(chatId, messages, targetChars, embeddingSignature);
    const existing = await vectorStore.readChunks(vectorsDirectory, chatId);
    const existingById = new Map(existing.map(chunk => [chunk.id, chunk]));
    const pending = [];

    for (const draft of drafts) {
        const saved = existingById.get(draft.id);
        if (saved?.manual_override === true) {
            const manualText = String(saved.text ?? '').trim();
            draft.source_text = draft.text;
            draft.text = manualText || draft.text;
            draft.char_count = getCharacterCount(draft.text);
            draft.manual_override = true;
            draft.manual_updated_at = Number(saved.manual_updated_at) || draft.timestamp;
        }
        if (saved?.disabled === true) {
            draft.disabled = true;
        }
        const reusable = !req.body?.force
            && saved?.text === draft.text
            && saved?.embedding_signature === embeddingSignature
            && Array.isArray(saved?.vector)
            && saved.vector.length > 0;

        if (reusable) {
            draft.vector = saved.vector;
            draft.timestamp = saved.timestamp;
        } else {
            pending.push(draft);
        }
    }

    if (pending.length > 0) {
        const vectors = await createEmbeddings(pending.map(chunk => chunk.text), embeddingConfig);
        pending.forEach((chunk, index) => {
            chunk.vector = vectors[index];
        });
    }

    const incomingMessageIds = new Set(messages.map(message => String(message.id)));
    const draftIds = new Set(drafts.map(chunk => chunk.id));
    const preservedManualChunks = existing.filter((chunk) => {
        if (vectorStore.getChunkType(chunk) !== 'chat'
            || !vectorStore.hasManualControl(chunk)
            || draftIds.has(chunk.id)) return false;
        if (req.body?.force || req.body?.reconcile) return true;
        return incomingMessageIds.has(String(chunk.message_id));
    });
    await vectorStore.updateChunks(vectorsDirectory, chatId, (current) => {
        const worldInfoChunks = current.filter(chunk => chunk.type === 'worldinfo');
        if (req.body?.force || req.body?.reconcile) {
            return [...drafts, ...preservedManualChunks, ...worldInfoChunks];
        }
        const unaffectedChatChunks = current.filter((chunk) => {
            if (chunk.type === 'worldinfo') {
                return false;
            }
            if (chunk.message_id !== undefined) {
                return !incomingMessageIds.has(String(chunk.message_id));
            }
            const oldMessageIds = Array.isArray(chunk.message_ids) ? chunk.message_ids.map(String) : [];
            return !oldMessageIds.some(id => incomingMessageIds.has(id));
        });
        return [...unaffectedChatChunks, ...drafts, ...preservedManualChunks, ...worldInfoChunks];
    });
    return {
        accepted: messages.length,
        chunks: drafts.length,
        embedded: pending.length,
        reused: drafts.length - pending.length,
        preservedManual: preservedManualChunks.length
            + drafts.filter(chunk => chunk.manual_override === true || chunk.disabled === true).length,
        chunkIds: drafts.map(chunk => chunk.id),
    };
}

function serializeChatMemoryChunk(chunk) {
    const { vector, ...metadata } = chunk;
    return {
        ...metadata,
        vector_dimension: Array.isArray(vector) ? vector.length : 0,
        manual_override: chunk?.manual_override === true,
        disabled: chunk?.disabled === true,
    };
}

async function listChatMemory(req) {
    const vectorsDirectory = requireVectorsDirectory(req);
    const chatId = requireString(req.query?.chatId ?? req.query?.chat_id, 'chatId');
    const query = String(req.query?.query ?? '').trim().toLocaleLowerCase();
    const offset = clampInteger(req.query?.offset, 0, 0, 1_000_000);
    const limit = clampInteger(req.query?.limit, 50, 1, 200);
    const chunks = (await vectorStore.readChunks(vectorsDirectory, chatId))
        .filter(chunk => vectorStore.getChunkType(chunk) === 'chat')
        .sort((left, right) => {
            const messageDifference = Number(right.message_id ?? -1) - Number(left.message_id ?? -1);
            return messageDifference || Number(right.segment_index ?? 0) - Number(left.segment_index ?? 0);
        });
    const filtered = query
        ? chunks.filter(chunk => String(chunk.text ?? '').toLocaleLowerCase().includes(query)
            || String(chunk.message_id ?? '').includes(query))
        : chunks;
    return {
        chatId,
        total: filtered.length,
        offset,
        limit,
        hasMore: offset + limit < filtered.length,
        manualCount: chunks.filter(chunk => chunk.manual_override === true).length,
        disabledCount: chunks.filter(chunk => chunk.disabled === true).length,
        items: filtered.slice(offset, offset + limit).map(serializeChatMemoryChunk),
    };
}

async function updateChatMemory(req) {
    const vectorsDirectory = requireVectorsDirectory(req);
    const chatId = requireString(req.body?.chatId ?? req.body?.chat_id, 'chatId');
    const chunkId = requireString(req.body?.chunkId ?? req.body?.chunk_id, 'chunkId');
    const restore = req.body?.restore === true;
    const hasText = Object.hasOwn(req.body ?? {}, 'text');
    const hasDisabled = Object.hasOwn(req.body ?? {}, 'disabled');
    const embeddingConfig = req.body?.embedding;
    const embeddingSignature = getEmbeddingSignature(embeddingConfig);
    let updated;

    await vectorStore.updateChunks(vectorsDirectory, chatId, async (chunks) => {
        const index = chunks.findIndex(chunk => chunk.id === chunkId && vectorStore.getChunkType(chunk) === 'chat');
        if (index < 0) {
            const error = new Error('Chat memory fragment was not found.');
            error.statusCode = 404;
            throw error;
        }

        const current = chunks[index];
        const next = { ...current };
        if (restore) {
            next.text = String(current.source_text ?? current.text ?? '').trim();
            next.char_count = getCharacterCount(next.text);
            next.manual_override = false;
            next.disabled = false;
            delete next.source_text;
            delete next.manual_updated_at;
        } else {
            if (hasText) {
                const text = requireString(req.body.text, 'text');
                if (current.manual_override !== true) {
                    next.source_text = String(current.source_text ?? current.text ?? '').trim();
                }
                next.text = text;
                next.char_count = getCharacterCount(text);
                next.manual_override = true;
                next.manual_updated_at = Math.floor(Date.now() / 1000);
            }
            if (hasDisabled) {
                next.disabled = req.body.disabled === true;
            }
        }

        const textChanged = next.text !== current.text;
        const embeddingChanged = next.embedding_signature !== embeddingSignature;
        const missingVector = !Array.isArray(next.vector) || next.vector.length === 0;
        if (textChanged || missingVector || ((hasText || restore) && embeddingChanged)) {
            const [vector] = await createEmbeddings([next.text], embeddingConfig);
            next.vector = vector;
            next.embedding_signature = embeddingSignature;
            next.timestamp = Math.floor(Date.now() / 1000);
        }

        chunks[index] = next;
        updated = serializeChatMemoryChunk(next);
        return chunks;
    });

    return { chatId, item: updated };
}

function formatBytes(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 ** 2) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${(bytes / (1024 ** 2)).toFixed(1)} MiB`;
}

function asyncRoute(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            const statusCode = clampInteger(error?.statusCode, 500, 400, 599);
            console.error(`[Memory Augment] Request failed: ${error?.message ?? error}`);
            res.status(statusCode).json({
                ok: false,
                error: error?.message ?? 'Unexpected server error.',
            });
        }
    };
}

async function init(router) {
    router.post('/models', asyncRoute(async (req, res) => {
        const models = await listModels({
            baseUrl: req.body?.base_url ?? req.body?.baseUrl,
            apiKey: req.body?.api_key ?? req.body?.apiKey,
        });
        res.json({ ok: true, models });
    }));

    router.post('/embed', asyncRoute(async (req, res) => {
        const input = Array.isArray(req.body?.input) ? req.body.input : [];
        const vectors = await createEmbeddings(input, req.body?.embedding);
        const worldInfoEntries = req.body?.worldInfoEntries;
        let stored = null;

        if (Array.isArray(worldInfoEntries)) {
            const vectorsDirectory = requireVectorsDirectory(req);
            const chatId = String(req.body?.chatId ?? 'legacy-worldinfo-import');
            if (worldInfoEntries.length !== input.length) {
                const error = new Error('worldInfoEntries must align with input.');
                error.statusCode = 400;
                throw error;
            }
            const chunks = buildWorldInfoChunks(
                chatId,
                worldInfoEntries,
                vectors,
                getEmbeddingSignature(req.body?.embedding),
            );
            const grouped = new Map();
            for (const chunk of chunks) {
                if (!grouped.has(chunk.book_id)) grouped.set(chunk.book_id, []);
                grouped.get(chunk.book_id).push(chunk);
            }
            for (const [bookId, bookChunks] of grouped) {
                await vectorStore.replaceWorldInfoChunks(vectorsDirectory, bookId, bookChunks);
            }
            stored = chunks.length;
        }

        res.json({
            object: 'list',
            model: req.body?.embedding?.model ?? '',
            data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
            ...(stored !== null ? { stored } : {}),
        });
    }));

    router.post('/ingest', asyncRoute(async (req, res) => {
        const type = String(req.body?.type ?? 'chat').toLowerCase();
        const result = type === 'worldinfo' ? await syncWorldInfo(req) : await ingestChat(req);
        res.json({ ok: true, ...result });
    }));

    router.post('/reconcile-chat', asyncRoute(async (req, res) => {
        const vectorsDirectory = requireVectorsDirectory(req);
        const chatId = requireString(req.body?.chatId ?? req.body?.chat_id, 'chatId');
        const messageIds = Array.isArray(req.body?.messageIds ?? req.body?.message_ids)
            ? (req.body.messageIds ?? req.body.message_ids)
            : [];
        const result = await vectorStore.reconcileChatMessages(vectorsDirectory, chatId, messageIds);
        res.json({ ok: true, chatId, ...result });
    }));

    router.post('/sync-worldinfo', asyncRoute(async (req, res) => {
        res.json({ ok: true, ...(await syncWorldInfo(req)) });
    }));

    router.post('/worldinfo-status', asyncRoute(async (req, res) => {
        const vectorsDirectory = requireVectorsDirectory(req);
        const statuses = await vectorStore.getWorldInfoStatuses(vectorsDirectory, req.body?.book_ids);
        res.json({ ok: true, statuses });
    }));

    router.get('/chat-memory', asyncRoute(async (req, res) => {
        res.json({ ok: true, ...(await listChatMemory(req)) });
    }));

    router.post('/chat-memory/update', asyncRoute(async (req, res) => {
        res.json({ ok: true, ...(await updateChatMemory(req)) });
    }));

    router.post('/search', asyncRoute(async (req, res) => {
        const vectorsDirectory = requireVectorsDirectory(req);
        const chatId = String(req.body?.chatId ?? req.body?.scope?.chat_id ?? '').trim();
        const query = requireString(req.body?.query, 'query');
        const [queryVector] = await createEmbeddings([query], req.body?.embedding);
        if (req.body?.separate === true) {
            const scope = req.body?.scope ?? {};
            const bookIds = Array.isArray(scope.book_ids)
                ? [...new Set(scope.book_ids.map(String).filter(Boolean))]
                : [];
            const chatTopK = clampInteger(req.body?.chatTopK, 25, 1, 100);
            const worldInfoTopK = clampInteger(req.body?.worldInfoTopK, 10, 1, 100);
            const [chatSearch, worldInfoSearch] = await Promise.allSettled([
                chatId
                    ? vectorStore.searchScopes(vectorsDirectory, {
                        chat_id: chatId,
                        chat_message_id_before: scope.chat_message_id_before,
                        book_ids: [],
                    }, queryVector, chatTopK)
                    : Promise.resolve([]),
                bookIds.length > 0
                    ? vectorStore.searchScopes(vectorsDirectory, {
                        chat_id: '',
                        book_ids: bookIds,
                    }, queryVector, worldInfoTopK)
                    : Promise.resolve([]),
            ]);
            const errors = {};
            if (chatSearch.status === 'rejected') {
                errors.chat = String(chatSearch.reason?.message ?? chatSearch.reason ?? 'Unknown chat search error');
            }
            if (worldInfoSearch.status === 'rejected') {
                errors.worldinfo = String(
                    worldInfoSearch.reason?.message ?? worldInfoSearch.reason ?? 'Unknown world info search error',
                );
            }
            res.json({
                ok: true,
                chatResults: chatSearch.status === 'fulfilled' ? chatSearch.value : [],
                worldInfoResults: worldInfoSearch.status === 'fulfilled' ? worldInfoSearch.value : [],
                ...(Object.keys(errors).length > 0 ? { errors } : {}),
            });
            return;
        }
        const legacyTypes = Array.isArray(req.body?.types) ? req.body.types : [];
        const legacyBookIds = Array.isArray(req.body?.worldInfoKeys)
            ? [...new Set(req.body.worldInfoKeys.map(key => String(key).split('::')[0]).filter(Boolean))]
            : [];
        const scope = req.body?.scope ?? {
            chat_id: legacyTypes.length && !legacyTypes.includes('chat') ? '' : chatId,
            book_ids: legacyTypes.includes('worldinfo') ? legacyBookIds : [],
        };
        const results = await vectorStore.searchScopes(vectorsDirectory, scope, queryVector, req.body?.topK);
        res.json({ ok: true, results });
    }));

    router.post('/rerank', asyncRoute(async (req, res) => {
        const query = requireString(req.body?.query, 'query');
        const candidates = Array.isArray(req.body?.candidates)
            ? req.body.candidates.filter(candidate => String(candidate?.text ?? '').trim())
            : [];
        const topN = clampInteger(req.body?.topN, 7, 1, 100);
        const thresholdValue = Number(req.body?.threshold);
        const threshold = Number.isFinite(thresholdValue)
            ? Math.max(0, Math.min(1, thresholdValue))
            : 0.6;
        const ranked = await rerankDocuments(
            query,
            candidates.map(candidate => candidate.text),
            req.body?.reranker,
            topN,
        );
        const results = ranked
            .filter(item => item.score >= threshold)
            .map(item => ({ ...candidates[item.index], score: item.score, rerankIndex: item.index }));

        res.json({ ok: true, results });
    }));

    router.post('/barrage', asyncRoute(async (req, res) => {
        const defaultPrompt = '你是一群正在观看小说直播的观众，请以弹幕/评论区风格吐槽点评';
        const systemPrompt = String(req.body?.systemPrompt ?? '').trim() || defaultPrompt;
        const userContent = buildBarrageUserContent(req.body?.recentMessages, req.body?.ragFragments);
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ];
        const maxTokens = clampInteger(req.body?.maxTokens, DEFAULT_MAX_TOKENS, 1, MAX_MAX_TOKENS);
        const content = await generateBarrage(messages, req.body?.barrage, { maxTokens });
        res.json({ ok: true, content });
    }));

    router.get('/status', asyncRoute(async (req, res) => {
        const vectorsDirectory = requireVectorsDirectory(req);
        const status = await vectorStore.getStoreStatus(vectorsDirectory, req.query?.chatId);
        res.json({
            ok: true,
            status: 'ok',
            phase: 6,
            ...status,
            totalSize: formatBytes(status.totalSizeBytes),
            chatSize: formatBytes(status.chatSizeBytes),
            lastSummaryAt: null,
        });
    }));

    router.post('/clear', asyncRoute(async (req, res) => {
        const vectorsDirectory = requireVectorsDirectory(req);
        const bookId = String(req.body?.book_id ?? req.body?.bookId ?? '').trim();
        if (bookId) {
            const cleared = await vectorStore.clearWorldInfo(vectorsDirectory, bookId);
            res.json({ ok: true, bookId, cleared });
            return;
        }
        const chatId = requireString(req.body?.chatId ?? req.body?.chat_id, 'chatId');
        const cleared = await vectorStore.clearChat(vectorsDirectory, chatId);
        res.json({ ok: true, chatId, cleared });
    }));

}

async function exit() {
    // No persistent handles are kept by this plugin.
}

module.exports = {
    buildMessageSegmentDrafts,
    buildWorldInfoDrafts,
    buildWorldInfoChunks,
    splitMessageText,
    syncWorldInfo,
    exit,
    info,
    init,
};
