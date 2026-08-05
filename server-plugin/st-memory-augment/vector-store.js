'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const STORE_NAMESPACE = 'chats';
const CHAT_NAMESPACE = 'chats';
const WORLDINFO_NAMESPACE = 'worldinfo';
const LEGACY_NAMESPACE = 'st-memory-augment';
const CHUNKS_FILE = 'chunks.json';
const VECTORS_FILE = 'vectors.json';
const writeLocks = new Map();

function validateId(value, fieldName) {
    const id = String(value ?? '').trim();
    if (!id) {
        const error = new Error(`${fieldName} is required.`);
        error.statusCode = 400;
        throw error;
    }
    return id;
}

function getScopeKey(id) {
    return crypto.createHash('sha256').update(String(id)).digest('hex');
}

function getScopeDirectory(vectorsDirectory, namespace, id) {
    if (!vectorsDirectory) {
        const error = new Error('User vector directory is unavailable.');
        error.statusCode = 500;
        throw error;
    }
    return path.join(path.resolve(vectorsDirectory), namespace, getScopeKey(id));
}

function getScopePaths(vectorsDirectory, namespace, id) {
    const directory = getScopeDirectory(vectorsDirectory, namespace, id);
    return {
        directory,
        chunks: path.join(directory, CHUNKS_FILE),
        vectors: path.join(directory, VECTORS_FILE),
    };
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function readJson(filePath, fallback) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return fallback;
        throw error;
    }
}

async function writeJsonAtomic(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
        await fs.rename(temporaryPath, filePath);
    } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error?.code)) {
            await fs.rm(temporaryPath, { force: true });
            throw error;
        }
        await fs.rm(filePath, { force: true });
        await fs.rename(temporaryPath, filePath);
    }
}

function splitStoredChunks(chunks) {
    const metadata = [];
    const vectors = {};
    for (const chunk of chunks) {
        const { vector, ...item } = chunk;
        metadata.push(item);
        if (Array.isArray(vector)) vectors[item.id] = vector;
    }
    return { metadata, vectors };
}

async function readScopeRaw(vectorsDirectory, namespace, id) {
    const paths = getScopePaths(vectorsDirectory, namespace, id);
    const metadata = await readJson(paths.chunks, []);
    const vectors = await readJson(paths.vectors, {});
    if (!Array.isArray(metadata)) return [];
    return metadata.map((chunk) => ({
        ...chunk,
        vector: Array.isArray(chunk.vector) ? chunk.vector : vectors?.[chunk.id],
    }));
}

async function writeScopeRaw(vectorsDirectory, namespace, id, chunks) {
    const paths = getScopePaths(vectorsDirectory, namespace, id);
    const { metadata, vectors } = splitStoredChunks(chunks);
    await writeJsonAtomic(paths.chunks, metadata);
    await writeJsonAtomic(paths.vectors, vectors);
}

async function withScopeLock(vectorsDirectory, namespace, id, task) {
    const lockKey = getScopeDirectory(vectorsDirectory, namespace, id);
    const previous = writeLocks.get(lockKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    writeLocks.set(lockKey, current);
    try {
        return await current;
    } finally {
        if (writeLocks.get(lockKey) === current) writeLocks.delete(lockKey);
    }
}

async function updateScope(vectorsDirectory, namespace, id, updater) {
    return withScopeLock(vectorsDirectory, namespace, id, async () => {
        const existing = await readScopeRaw(vectorsDirectory, namespace, id);
        const chunks = await updater(existing);
        if (!Array.isArray(chunks)) throw new TypeError('Chunk updater must return an array.');
        await writeScopeRaw(vectorsDirectory, namespace, id, chunks);
    });
}

function createMessageSegmentChunk({ id, chatId, messageId, segmentIndex, role, text, charCount, timestamp, embeddingSignature }) {
    return {
        id: String(id),
        chat_id: validateId(chatId, 'chatId'),
        message_id: messageId,
        segment_index: Math.max(0, Math.trunc(Number(segmentIndex) || 0)),
        role: role === 'user' ? 'user' : 'assistant',
        text: String(text),
        char_count: Math.max(0, Math.trunc(Number(charCount) || 0)),
        timestamp: Math.max(0, Math.trunc(Number(timestamp) || 0)),
        type: 'chat',
        embedding_signature: String(embeddingSignature ?? ''),
    };
}

function getChunkType(chunk) {
    if (chunk?.type) return chunk.type;
    if (chunk?.message_id !== undefined || Array.isArray(chunk?.message_ids)) return 'chat';
    if (chunk?.book_id || chunk?.world_info_book) return 'worldinfo';
    return undefined;
}

function hasManualControl(chunk) {
    return chunk?.manual_override === true || chunk?.disabled === true;
}

async function migrateLegacyChat(vectorsDirectory, chatId) {
    const chatPaths = getScopePaths(vectorsDirectory, CHAT_NAMESPACE, chatId);
    if (await pathExists(chatPaths.chunks)) return false;
    const legacyDirectory = getScopeDirectory(vectorsDirectory, LEGACY_NAMESPACE, chatId);
    const legacyFile = path.join(legacyDirectory, CHUNKS_FILE);
    if (!await pathExists(legacyFile)) return false;
    const legacy = await readJson(legacyFile, []);
    if (!Array.isArray(legacy)) return false;

    const chatChunks = legacy.filter(chunk => getChunkType(chunk) !== 'worldinfo');
    const worldGroups = new Map();
    for (const chunk of legacy.filter(chunk => getChunkType(chunk) === 'worldinfo')) {
        const bookId = String(chunk.book_id ?? chunk.world_info_book ?? '').trim();
        if (!bookId) continue;
        if (!worldGroups.has(bookId)) worldGroups.set(bookId, []);
        worldGroups.get(bookId).push({ ...chunk, book_id: bookId, type: 'worldinfo' });
    }
    await writeScopeRaw(vectorsDirectory, CHAT_NAMESPACE, chatId, chatChunks);
    for (const [bookId, chunks] of worldGroups) {
        await updateScope(vectorsDirectory, WORLDINFO_NAMESPACE, bookId, (current) => {
            const merged = new Map(current.map(chunk => [chunk.id, chunk]));
            chunks.forEach(chunk => merged.set(chunk.id, chunk));
            return [...merged.values()];
        });
    }
    await fs.rm(legacyDirectory, { recursive: true, force: true });
    return true;
}

async function readChunks(vectorsDirectory, chatId) {
    validateId(chatId, 'chatId');
    await migrateLegacyChat(vectorsDirectory, chatId);
    return readScopeRaw(vectorsDirectory, CHAT_NAMESPACE, chatId);
}

async function updateChunks(vectorsDirectory, chatId, updater) {
    await migrateLegacyChat(vectorsDirectory, chatId);
    return updateScope(vectorsDirectory, CHAT_NAMESPACE, chatId, updater);
}

async function replaceChunks(vectorsDirectory, chatId, chunks) {
    return updateChunks(vectorsDirectory, chatId, () => chunks);
}

function getChunkMessageIds(chunk) {
    if (chunk?.message_id !== undefined && chunk?.message_id !== null) {
        return [String(chunk.message_id)];
    }
    return Array.isArray(chunk?.message_ids)
        ? chunk.message_ids.map(String)
        : [];
}

function isChunkBeforeMessageId(chunk, exclusiveEnd) {
    if (exclusiveEnd === null) return true;
    const messageIds = getChunkMessageIds(chunk).map(Number);
    return messageIds.length > 0
        && messageIds.every(messageId => Number.isInteger(messageId) && messageId < exclusiveEnd);
}

async function reconcileChatMessages(vectorsDirectory, chatId, currentMessageIds) {
    const currentIds = new Set((Array.isArray(currentMessageIds) ? currentMessageIds : []).map(String));
    let result;

    await updateChunks(vectorsDirectory, chatId, (chunks) => {
        const storedIds = new Set(chunks.flatMap(getChunkMessageIds));
        let removedChunks = 0;
        const retained = chunks.filter((chunk) => {
            const messageIds = getChunkMessageIds(chunk);
            const keep = hasManualControl(chunk)
                || (messageIds.length > 0 && messageIds.every(id => currentIds.has(id)));
            if (!keep) removedChunks++;
            return keep;
        });
        result = {
            currentMessageIds: [...currentIds],
            storedMessageIds: [...storedIds],
            orphanMessageIds: [...storedIds].filter(id => !currentIds.has(id)),
            removedChunks,
            preservedManualChunks: retained.filter(chunk => hasManualControl(chunk)
                && getChunkMessageIds(chunk).some(id => !currentIds.has(id))).length,
        };
        return retained;
    });

    return result;
}

async function readWorldInfoChunks(vectorsDirectory, bookId) {
    validateId(bookId, 'bookId');
    return readScopeRaw(vectorsDirectory, WORLDINFO_NAMESPACE, bookId);
}

async function updateWorldInfoChunks(vectorsDirectory, bookId, updater) {
    validateId(bookId, 'bookId');
    return updateScope(vectorsDirectory, WORLDINFO_NAMESPACE, bookId, updater);
}

async function replaceWorldInfoChunks(vectorsDirectory, bookId, chunks) {
    return updateWorldInfoChunks(vectorsDirectory, bookId, () => chunks);
}

function cosineSimilarity(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) return null;
    let dot = 0;
    let normLeft = 0;
    let normRight = 0;
    for (let index = 0; index < left.length; index++) {
        const leftValue = Number(left[index]);
        const rightValue = Number(right[index]);
        if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return null;
        dot += leftValue * rightValue;
        normLeft += leftValue * leftValue;
        normRight += rightValue * rightValue;
    }
    if (normLeft === 0 || normRight === 0) return null;
    return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

function rankChunks(chunks, queryVector, limit) {
    return chunks
        .filter(chunk => chunk?.disabled !== true)
        .map(chunk => ({ chunk, score: cosineSimilarity(queryVector, chunk.vector) }))
        .filter(item => item.score !== null)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map(({ chunk, score }) => {
            const { vector, ...metadata } = chunk;
            return { ...metadata, type: getChunkType(chunk), score };
        });
}

async function searchScopes(vectorsDirectory, scope, queryVector, topK = 25) {
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(topK) || 25)));
    const chatId = String(scope?.chat_id ?? '').trim();
    const bookIds = Array.isArray(scope?.book_ids) ? [...new Set(scope.book_ids.map(String).filter(Boolean))] : [];
    const rawMessageIdBefore = Number(scope?.chat_message_id_before);
    const messageIdBefore = Number.isInteger(rawMessageIdBefore) && rawMessageIdBefore >= 0
        ? rawMessageIdBefore
        : null;
    const groups = await Promise.all([
        chatId
            ? readChunks(vectorsDirectory, chatId)
                .then(chunks => chunks.filter(chunk => isChunkBeforeMessageId(chunk, messageIdBefore)))
            : Promise.resolve([]),
        ...bookIds.map(bookId => readWorldInfoChunks(vectorsDirectory, bookId)),
    ]);
    return rankChunks(groups.flat(), queryVector, limit);
}

async function searchChunks(vectorsDirectory, chatId, queryVector, topK = 25, types = null, worldInfoKeys = null) {
    void worldInfoKeys;
    const chunks = await readChunks(vectorsDirectory, chatId);
    const allowed = Array.isArray(types) && types.length ? new Set(types) : null;
    return rankChunks(chunks.filter(chunk => !allowed || allowed.has(getChunkType(chunk))), queryVector,
        Math.max(1, Math.min(100, Math.trunc(Number(topK) || 25))));
}

async function listChunkFiles(root) {
    try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        return entries.filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name, CHUNKS_FILE));
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

async function getScopeSizeBytes(vectorsDirectory, namespace, id) {
    if (!id) return 0;
    const paths = getScopePaths(vectorsDirectory, namespace, id);
    let sizeBytes = 0;
    for (const target of [paths.chunks, paths.vectors]) {
        try {
            sizeBytes += (await fs.stat(target)).size;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    return sizeBytes;
}

async function getStoreStatus(vectorsDirectory, chatId) {
    const chatFiles = await listChunkFiles(path.join(path.resolve(vectorsDirectory), CHAT_NAMESPACE));
    const worldFiles = await listChunkFiles(path.join(path.resolve(vectorsDirectory), WORLDINFO_NAMESPACE));
    const selectedChunks = chatId ? await readChunks(vectorsDirectory, chatId) : [];
    let totalSizeBytes = 0;
    let totalChunkCount = 0;
    for (const filePath of [...chatFiles, ...worldFiles]) {
        const chunks = await readJson(filePath, []);
        totalChunkCount += Array.isArray(chunks) ? chunks.length : 0;
        for (const target of [filePath, path.join(path.dirname(filePath), VECTORS_FILE)]) {
            try { totalSizeBytes += (await fs.stat(target)).size; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        }
    }
    return {
        chunkCount: chatId ? selectedChunks.length : totalChunkCount,
        totalChunkCount,
        totalSizeBytes,
        chatSizeBytes: chatId ? await getScopeSizeBytes(vectorsDirectory, CHAT_NAMESPACE, chatId) : 0,
        lastUpdatedAt: selectedChunks.reduce((latest, chunk) => Math.max(latest, Number(chunk.timestamp) || 0), 0) || null,
    };
}

async function getWorldInfoStatuses(vectorsDirectory, bookIds) {
    const statuses = {};
    for (const bookId of [...new Set((bookIds ?? []).map(String).filter(Boolean))]) {
        const chunks = await readWorldInfoChunks(vectorsDirectory, bookId);
        statuses[bookId] = {
            chunkCount: chunks.length,
            entryCount: new Set(chunks.map(chunk => String(chunk.entry_uid ?? chunk.world_info_id ?? ''))).size,
            lastUpdatedAt: chunks.reduce((latest, chunk) => Math.max(latest, Number(chunk.timestamp) || 0), 0) || null,
        };
    }
    return statuses;
}

async function clearScope(vectorsDirectory, namespace, id) {
    const chunks = await readScopeRaw(vectorsDirectory, namespace, id);
    await fs.rm(getScopeDirectory(vectorsDirectory, namespace, id), { recursive: true, force: true });
    return chunks.length;
}

async function clearChat(vectorsDirectory, chatId) {
    await migrateLegacyChat(vectorsDirectory, chatId);
    return clearScope(vectorsDirectory, CHAT_NAMESPACE, chatId);
}

async function clearWorldInfo(vectorsDirectory, bookId) {
    return clearScope(vectorsDirectory, WORLDINFO_NAMESPACE, bookId);
}

module.exports = {
    STORE_NAMESPACE,
    CHAT_NAMESPACE,
    WORLDINFO_NAMESPACE,
    LEGACY_NAMESPACE,
    clearChat,
    clearWorldInfo,
    cosineSimilarity,
    createMessageSegmentChunk,
    getChunkType,
    hasManualControl,
    getStoreStatus,
    getWorldInfoStatuses,
    migrateLegacyChat,
    readChunks,
    readWorldInfoChunks,
    reconcileChatMessages,
    replaceChunks,
    replaceWorldInfoChunks,
    searchChunks,
    searchScopes,
    updateChunks,
    updateWorldInfoChunks,
};
