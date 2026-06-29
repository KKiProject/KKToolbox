'use strict';

const crypto = require('node:crypto');
const { normalizeBaseUrl } = require('./api-url');
const { generateBarrage } = require('./barrage');
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

function normalizeMessages(messages) {
    if (!Array.isArray(messages)) {
        const error = new Error('messages must be an array.');
        error.statusCode = 400;
        throw error;
    }

    return messages
        .map((message, index) => ({
            id: ['string', 'number'].includes(typeof message?.id) ? message.id : index,
            name: String(message?.name ?? '').trim(),
            role: String(message?.role ?? '').trim(),
            text: String(message?.text ?? message?.mes ?? '').trim(),
            timestamp: Number(message?.timestamp) || 0,
        }))
        .filter(message => message.text);
}

function hash(value, length = 16) {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function getEmbeddingSignature(config) {
    const baseUrl = normalizeBaseUrl(config?.baseUrl);
    const model = String(config?.model ?? '').trim();
    return hash(`${baseUrl}\n${model}`, 32);
}

function buildWorldInfoChunks(chatId, entries, vectors, embeddingSignature) {
    return entries.map((entry, index) => {
        const world = String(entry?.world ?? '').trim();
        const entryId = String(entry?.id ?? entry?.uid ?? '').trim();
        const name = String(entry?.name ?? '').trim() || `Entry ${entryId}`;
        const text = String(entry?.text ?? '').trim();
        if (!world || !entryId || !text || !Array.isArray(vectors[index])) {
            const error = new Error(`Invalid world info entry at index ${index}.`);
            error.statusCode = 400;
            throw error;
        }

        return {
            id: `worldinfo_${hash(`${world}\n${entryId}`)}`,
            chat_id: chatId,
            message_ids: [],
            text,
            summary_tag: `${world} / ${name}`,
            vector: vectors[index],
            timestamp: Math.floor(Date.now() / 1000),
            type: 'worldinfo',
            world_info_id: entryId,
            world_info_name: name,
            world_info_book: world,
            embedding_signature: embeddingSignature,
        };
    });
}

function buildChunkDrafts(chatId, messages, chunkSize, embeddingSignature) {
    const drafts = [];

    for (let offset = 0; offset < messages.length; offset += chunkSize) {
        const group = messages.slice(offset, offset + chunkSize);
        const messageIds = group.map(message => message.id);
        const text = group.map((message) => {
            const speaker = message.name || message.role || 'message';
            return `${speaker}: ${message.text}`;
        }).join('\n');
        const firstId = messageIds[0];
        const lastId = messageIds.at(-1);
        const preview = text.replace(/\s+/g, ' ').slice(0, 80);

        drafts.push({
            id: `chunk_${hash(`${chatId}\n${messageIds.join(',')}`)}`,
            chat_id: chatId,
            message_ids: messageIds,
            text,
            summary_tag: `第 ${firstId}-${lastId} 楼：${preview}`,
            timestamp: group.reduce((latest, message) => Math.max(latest, message.timestamp), 0)
                || Math.floor(Date.now() / 1000),
            type: 'chat',
            embedding_signature: embeddingSignature,
        });
    }

    return drafts;
}

async function ingestChat(req) {
    const vectorsDirectory = requireVectorsDirectory(req);
    const chatId = requireString(req.body?.chatId, 'chatId');
    const messages = normalizeMessages(req.body?.messages);
    if (messages.length === 0) {
        const error = new Error('At least one non-empty message is required.');
        error.statusCode = 400;
        throw error;
    }

    const chunkSize = clampInteger(req.body?.chunkSize, 3, 1, 20);
    const embeddingConfig = req.body?.embedding;
    const embeddingSignature = getEmbeddingSignature(embeddingConfig);
    const drafts = buildChunkDrafts(chatId, messages, chunkSize, embeddingSignature);
    const existing = await vectorStore.readChunks(vectorsDirectory, chatId);
    const existingById = new Map(existing.map(chunk => [chunk.id, chunk]));
    const pending = [];

    for (const draft of drafts) {
        const saved = existingById.get(draft.id);
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

    await vectorStore.updateChunks(vectorsDirectory, chatId, current => [
        ...drafts,
        ...current.filter(chunk => chunk.type === 'worldinfo'),
    ]);
    return {
        accepted: messages.length,
        chunks: drafts.length,
        embedded: pending.length,
        reused: drafts.length - pending.length,
        chunkIds: drafts.map(chunk => chunk.id),
    };
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

function normalizeBarrageMessages(recentMessages, ragFragments) {
    const recent = Array.isArray(recentMessages)
        ? recentMessages.map((message, index) => {
            const name = String(message?.name ?? message?.role ?? '消息').trim();
            const text = String(message?.text ?? '').trim();
            const id = message?.id ?? index;
            return text ? `[第 ${id} 楼] ${name}: ${text}` : '';
        }).filter(Boolean)
        : [];
    const history = Array.isArray(ragFragments)
        ? ragFragments.map((fragment, index) => {
            const text = String(fragment?.text ?? fragment ?? '').trim();
            return text ? `[历史片段 ${index + 1}] ${text}` : '';
        }).filter(Boolean)
        : [];

    if (recent.length === 0) {
        const error = new Error('At least one recent message is required.');
        error.statusCode = 400;
        throw error;
    }

    return [
        '以下是最近的故事内容：',
        recent.join('\n'),
        ...(history.length ? ['', '相关历史片段：', history.join('\n\n')] : []),
        '',
        '请以弹幕/评论区的形式进行简短吐槽和点评。',
    ].join('\n');
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
            const chatId = requireString(req.body?.chatId, 'chatId');
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
            await vectorStore.updateChunks(vectorsDirectory, chatId, current => [
                ...current.filter(chunk => chunk.type !== 'worldinfo'),
                ...chunks,
            ]);
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
        res.json({ ok: true, ...(await ingestChat(req)) });
    }));

    router.post('/search', asyncRoute(async (req, res) => {
        const vectorsDirectory = requireVectorsDirectory(req);
        const chatId = requireString(req.body?.chatId, 'chatId');
        const query = requireString(req.body?.query, 'query');
        const [queryVector] = await createEmbeddings([query], req.body?.embedding);
        const results = await vectorStore.searchChunks(
            vectorsDirectory,
            chatId,
            queryVector,
            req.body?.topK,
            req.body?.types,
            req.body?.worldInfoKeys,
        );
        res.json({ ok: true, results });
    }));

    router.post('/rerank', asyncRoute(async (req, res) => {
        const query = requireString(req.body?.query, 'query');
        const candidates = Array.isArray(req.body?.candidates)
            ? req.body.candidates.filter(candidate => String(candidate?.text ?? '').trim())
            : [];
        const topN = clampInteger(req.body?.topN, 5, 1, 100);
        const thresholdValue = Number(req.body?.threshold);
        const threshold = Number.isFinite(thresholdValue)
            ? Math.max(0, Math.min(1, thresholdValue))
            : 0;
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
        const userContent = normalizeBarrageMessages(req.body?.recentMessages, req.body?.ragFragments);
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ];
        const content = await generateBarrage(messages, req.body?.barrage);
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
            lastSummaryAt: null,
        });
    }));

    router.post('/clear', asyncRoute(async (req, res) => {
        const vectorsDirectory = requireVectorsDirectory(req);
        const chatId = requireString(req.body?.chatId, 'chatId');
        const cleared = await vectorStore.clearChat(vectorsDirectory, chatId);
        res.json({ ok: true, chatId, cleared });
    }));

}

async function exit() {
    // No persistent handles are kept by this plugin.
}

module.exports = {
    buildChunkDrafts,
    buildWorldInfoChunks,
    normalizeBarrageMessages,
    exit,
    info,
    init,
};
