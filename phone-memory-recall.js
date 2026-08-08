import { searchPhoneMemory, syncPhoneMemory } from './rag-client.js';
import { cleanPhoneText as text } from './phone-utils.js';

export async function recallPhoneMemoryEvents({
    store,
    query,
    embedding,
    topK = 5,
    excludeIds = [],
    sync = syncPhoneMemory,
    search = searchPhoneMemory,
} = {}) {
    const events = Array.isArray(store?.onlineMemory?.events) ? store.onlineMemory.events : [];
    const chatId = text(store?.chatId, 500);
    if (!embedding || !chatId || !text(query, 12000) || events.length === 0) return [];

    await sync({
        chatId,
        embedding,
        entries: events.map(event => ({
            id: event.id,
            text: event.summary,
            type: event.type,
            status: event.status,
            conversationId: event.conversationId,
        })),
    });
    const response = await search({ chatId, query, topK, embedding });
    const excluded = new Set(excludeIds.map(id => String(id ?? '')));
    const byId = new Map(events.map(event => [String(event?.id ?? ''), event]));
    const recalled = [];
    const seen = new Set();
    for (const result of response?.results ?? []) {
        const id = String(result?.memory_event_id ?? result?.id ?? '');
        const event = byId.get(id);
        if (!event || excluded.has(id) || seen.has(id)) continue;
        seen.add(id);
        recalled.push(event);
    }
    return recalled;
}
