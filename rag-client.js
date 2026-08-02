import {
    createEmbeddings,
    generateBarrageCompletion,
    generateSummaryCompletion,
    generateAtlasCompletion,
    listModels,
    rerankCandidates,
} from './browser-api-client.js';
import {
    CHAT_KIND,
    clearChatScope,
    clearWorldInfoScope,
    getScopeStatus,
    getWorldInfoScopeStatuses,
    importLegacyChatScope,
    ingestChatScope,
    listChatScope,
    reconcileChatScope,
    searchScopes,
    syncWorldInfoScope,
    updateChatScope,
} from './native-vector-store.js';

const LEGACY_API_BASE = '/api/plugins/st-memory-augment';
const migratedChats = new Set();
let legacyUnavailable = false;

function getRequestHeaders() {
    return {
        'Content-Type': 'application/json',
        ...(globalThis.SillyTavern?.getContext?.().getRequestHeaders?.() ?? {}),
    };
}

async function legacyRequest(endpoint, options = {}) {
    if (legacyUnavailable) return null;
    let response;
    try {
        response = await fetch(`${LEGACY_API_BASE}${endpoint}`, {
            ...options,
            headers: {
                ...getRequestHeaders(),
                ...(options.headers ?? {}),
            },
        });
    } catch {
        legacyUnavailable = true;
        return null;
    }
    if (response.status === 404) {
        legacyUnavailable = true;
        return null;
    }
    if (!response.ok) return null;
    try {
        return await response.json();
    } catch {
        return null;
    }
}

async function tryMigrateLegacyChat(chatId, embedding) {
    const id = String(chatId ?? '').trim();
    if (!id || !embedding || migratedChats.has(id) || legacyUnavailable) return false;

    const current = await listChatScope(id, { offset: 0, limit: 1 });
    if (current.total > 0) {
        migratedChats.add(id);
        return false;
    }

    const items = [];
    let offset = 0;
    const limit = 200;
    while (true) {
        const query = new URLSearchParams({
            chatId: id,
            offset: String(offset),
            limit: String(limit),
        });
        const page = await legacyRequest(`/chat-memory?${query.toString()}`);
        if (!page || !Array.isArray(page.items)) return false;
        items.push(...page.items);
        if (page.hasMore !== true || page.items.length === 0) break;
        offset += page.items.length;
    }
    if (items.length === 0) {
        migratedChats.add(id);
        return false;
    }

    const result = await importLegacyChatScope({
        chatId: id,
        items,
        embedding,
    });
    migratedChats.add(id);
    if (result.imported > 0) {
        console.info(`[Memory Augment] Migrated ${result.imported} legacy memory fragments for chat ${id}.`);
        return true;
    }
    return false;
}

export function getStatus(chatId) {
    return getScopeStatus(chatId);
}

export async function ingestChat(payload) {
    await tryMigrateLegacyChat(payload?.chatId, payload?.embedding);
    return ingestChatScope(payload);
}

export async function reconcileChatVectors(payload) {
    await tryMigrateLegacyChat(payload?.chatId, payload?.embedding);
    return reconcileChatScope(payload);
}

export async function fetchModels(payload) {
    return { ok: true, models: await listModels(payload) };
}

export async function embedWorldInfo(payload) {
    const entries = Array.isArray(payload?.entries)
        ? payload.entries.map((entry, index) => ({
            entry_uid: entry?.entry_uid ?? entry?.uid ?? entry?.id ?? index,
            entry_key: entry?.entry_key ?? entry?.key ?? entry?.name,
            text: entry?.text ?? entry?.content,
            content_hash: entry?.content_hash,
        }))
        : [];
    return syncWorldInfoScope({
        book_id: payload?.book_id ?? payload?.bookId ?? 'legacy-worldinfo',
        entries,
        targetChars: payload?.targetChars,
        embedding: payload?.embedding,
    });
}

export function syncWorldInfo(payload) {
    return syncWorldInfoScope(payload);
}

export function getWorldInfoStatuses(bookIds) {
    return getWorldInfoScopeStatuses(bookIds);
}

export function getChatMemory(chatId, options = {}) {
    return listChatScope(chatId, options);
}

export function updateChatMemory(payload) {
    return updateChatScope(payload);
}

export function clearWorldInfo(bookId) {
    return clearWorldInfoScope(bookId);
}

export async function searchMemory(payload) {
    await tryMigrateLegacyChat(payload?.chatId ?? payload?.scope?.chat_id, payload?.embedding);
    return searchScopes(payload);
}

export function rerankMemory(payload) {
    return rerankCandidates(payload);
}

export function generateBarrage(payload) {
    return generateBarrageCompletion(payload);
}

export function generateSummary(payload) {
    return generateSummaryCompletion(payload);
}

export function generateMapAtlas(payload) {
    return generateAtlasCompletion(payload);
}

export function clearChat(chatId) {
    return clearChatScope(chatId);
}

export { createEmbeddings, CHAT_KIND };
