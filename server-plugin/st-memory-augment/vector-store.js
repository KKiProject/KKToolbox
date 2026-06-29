'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const STORE_NAMESPACE = 'st-memory-augment';
const CHUNKS_FILE = 'chunks.json';
const writeLocks = new Map();

function validateChatId(chatId) {
    const value = String(chatId ?? '').trim();
    if (!value) {
        const error = new Error('chatId is required.');
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function getChatKey(chatId) {
    return crypto.createHash('sha256').update(validateChatId(chatId)).digest('hex');
}

function getStoreRoot(vectorsDirectory) {
    if (!vectorsDirectory) {
        const error = new Error('User vector directory is unavailable.');
        error.statusCode = 500;
        throw error;
    }
    return path.join(path.resolve(vectorsDirectory), STORE_NAMESPACE);
}

function getChunksPath(vectorsDirectory, chatId) {
    return path.join(getStoreRoot(vectorsDirectory), getChatKey(chatId), CHUNKS_FILE);
}

async function readJson(filePath) {
    try {
        const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return Array.isArray(value) ? value : [];
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function readChunks(vectorsDirectory, chatId) {
    return readJson(getChunksPath(vectorsDirectory, chatId));
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

async function replaceChunks(vectorsDirectory, chatId, chunks) {
    return updateChunks(vectorsDirectory, chatId, () => chunks);
}

async function updateChunks(vectorsDirectory, chatId, updater) {
    const filePath = getChunksPath(vectorsDirectory, chatId);
    const lockKey = path.dirname(filePath);
    const previous = writeLocks.get(lockKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
        const existing = await readJson(filePath);
        const chunks = await updater(existing);
        if (!Array.isArray(chunks)) {
            throw new TypeError('Chunk updater must return an array.');
        }
        await writeJsonAtomic(filePath, chunks);
    });
    writeLocks.set(lockKey, current);

    try {
        await current;
    } finally {
        if (writeLocks.get(lockKey) === current) {
            writeLocks.delete(lockKey);
        }
    }
}

function cosineSimilarity(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) {
        return null;
    }

    let dot = 0;
    let normLeft = 0;
    let normRight = 0;

    for (let index = 0; index < left.length; index++) {
        const leftValue = Number(left[index]);
        const rightValue = Number(right[index]);
        if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
            return null;
        }
        dot += leftValue * rightValue;
        normLeft += leftValue * leftValue;
        normRight += rightValue * rightValue;
    }

    if (normLeft === 0 || normRight === 0) {
        return null;
    }

    return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

async function searchChunks(vectorsDirectory, chatId, queryVector, topK = 20, types = null, worldInfoKeys = null) {
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(topK) || 20)));
    const chunks = await readChunks(vectorsDirectory, chatId);
    const allowedTypes = Array.isArray(types) && types.length
        ? new Set(types.filter(type => ['chat', 'worldinfo'].includes(type)))
        : null;
    const allowedWorldInfoKeys = Array.isArray(worldInfoKeys)
        ? new Set(worldInfoKeys.map(String))
        : null;

    return chunks
        .filter(chunk => !allowedTypes || allowedTypes.has(chunk.type))
        .filter((chunk) => {
            if (chunk.type !== 'worldinfo' || allowedWorldInfoKeys === null) {
                return true;
            }
            return allowedWorldInfoKeys.has(`${chunk.world_info_book}::${chunk.world_info_id}`);
        })
        .map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, chunk.vector) }))
        .filter(item => item.score !== null)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map(({ chunk, score }) => {
            const { vector, ...metadata } = chunk;
            return { ...metadata, score };
        });
}

async function listChunkFiles(root) {
    try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        return entries
            .filter(entry => entry.isDirectory())
            .map(entry => path.join(root, entry.name, CHUNKS_FILE));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function getStoreStatus(vectorsDirectory, chatId) {
    const root = getStoreRoot(vectorsDirectory);
    const allFiles = await listChunkFiles(root);
    const selectedChunks = chatId ? await readChunks(vectorsDirectory, chatId) : [];
    let totalSizeBytes = 0;
    let totalChunkCount = 0;

    for (const filePath of allFiles) {
        const chunks = await readJson(filePath);
        totalChunkCount += chunks.length;
        try {
            totalSizeBytes += (await fs.stat(filePath)).size;
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    const activeChunks = chatId ? selectedChunks : allFiles.length ? null : [];
    return {
        chunkCount: activeChunks === null ? totalChunkCount : activeChunks.length,
        totalChunkCount,
        totalSizeBytes,
        lastUpdatedAt: selectedChunks.reduce((latest, chunk) => Math.max(latest, Number(chunk.timestamp) || 0), 0) || null,
    };
}

async function clearChat(vectorsDirectory, chatId) {
    const directory = path.dirname(getChunksPath(vectorsDirectory, chatId));
    const existing = await readChunks(vectorsDirectory, chatId);
    await fs.rm(directory, { recursive: true, force: true });
    return existing.length;
}

module.exports = {
    STORE_NAMESPACE,
    clearChat,
    cosineSimilarity,
    getStoreStatus,
    readChunks,
    replaceChunks,
    searchChunks,
    updateChunks,
};
