export const INGEST_QUEUE_METADATA_KEY = 'kktoolbox_ingest_queue';
export const INGEST_CONFIRMATION_LAG = 4;

function getQueueState(metadata, create = false) {
    if (!metadata || typeof metadata !== 'object') return null;
    if (!metadata[INGEST_QUEUE_METADATA_KEY] && create) {
        metadata[INGEST_QUEUE_METADATA_KEY] = {
            pendingMessageIds: [],
            lastConfirmedMessageIndex: -1,
        };
    }
    const state = metadata[INGEST_QUEUE_METADATA_KEY];
    if (!state || typeof state !== 'object') return null;
    state.pendingMessageIds = [...new Set((Array.isArray(state.pendingMessageIds) ? state.pendingMessageIds : [])
        .map(Number)
        .filter(Number.isInteger))].sort((left, right) => left - right);
    const confirmed = Number(state.lastConfirmedMessageIndex);
    state.lastConfirmedMessageIndex = Number.isInteger(confirmed) ? confirmed : -1;
    return state;
}

export function reconcileBufferedMessageQueue(metadata, chat) {
    const messages = Array.isArray(chat) ? chat : [];
    const state = getQueueState(metadata, true);
    let lastConfirmedMessageIndex = -1;

    for (let id = messages.length - 1; id >= 0; id--) {
        if (messages[id]?.is_user === true) {
            lastConfirmedMessageIndex = id;
            break;
        }
    }

    const readyThrough = lastConfirmedMessageIndex - INGEST_CONFIRMATION_LAG;
    const finalizedIds = messages
        .map((message, id) => ({ message, id }))
        .filter(({ message, id }) => id <= lastConfirmedMessageIndex
            && String(message?.mes ?? '').trim())
        .map(({ id }) => id);

    state.lastConfirmedMessageIndex = lastConfirmedMessageIndex;
    state.pendingMessageIds = finalizedIds.filter(id => id > readyThrough);

    return {
        ready: finalizedIds.filter(id => id <= readyThrough),
        pending: [...state.pendingMessageIds],
        lastConfirmedMessageIndex,
        readyThrough,
    };
}

export function getFinalizedTurnMessageIds(chat, messageId) {
    const sentId = Number(messageId);
    if (!Array.isArray(chat) || !Number.isInteger(sentId) || chat[sentId]?.is_user !== true) {
        return [];
    }

    const ids = [sentId];
    const previousId = sentId - 1;
    const previous = chat[previousId];
    if (previousId >= 0 && previous && previous.is_user !== true && previous.is_system !== true) {
        ids.unshift(previousId);
    }
    return ids;
}

export function enqueueFinalizedMessages(metadata, chat, messageId) {
    const finalizedIds = getFinalizedTurnMessageIds(chat, messageId);
    if (finalizedIds.length === 0) return { queued: [], ready: [] };

    const state = getQueueState(metadata, true);
    state.lastConfirmedMessageIndex = Math.max(state.lastConfirmedMessageIndex, Number(messageId));
    state.pendingMessageIds = [...new Set([...state.pendingMessageIds, ...finalizedIds])]
        .filter(id => id >= 0 && id < chat.length)
        .sort((left, right) => left - right);
    const readyThrough = state.lastConfirmedMessageIndex - INGEST_CONFIRMATION_LAG;
    return {
        queued: finalizedIds,
        ready: state.pendingMessageIds.filter(id => id <= readyThrough),
    };
}

async function saveQueueMetadata(context) {
    await context?.saveMetadata?.();
}

export function bindChatIngestionLifecycle(context, callbacks) {
    const messageSent = context.eventTypes?.MESSAGE_SENT ?? context.event_types?.MESSAGE_SENT;
    const chatChanged = context.eventTypes?.CHAT_CHANGED ?? context.event_types?.CHAT_CHANGED;
    const messageDeleted = context.eventTypes?.MESSAGE_DELETED ?? context.event_types?.MESSAGE_DELETED;
    let lifecycleQueue = Promise.resolve();

    const reconcile = () => {
        lifecycleQueue = lifecycleQueue.catch(() => undefined).then(async () => {
            const currentContext = callbacks.getContext();
            const queue = reconcileBufferedMessageQueue(
                currentContext.chatMetadata,
                currentContext.chat,
            );
            await callbacks.reconcileChat(queue.ready);
            await saveQueueMetadata(currentContext);
        }).catch(error => console.error('[Memory Augment] Chat reconciliation lifecycle failed.', error));
        return lifecycleQueue;
    };

    if (messageSent) {
        context.eventSource.on(messageSent, (messageId) => {
            lifecycleQueue = lifecycleQueue.catch(() => undefined).then(async () => {
                const currentContext = callbacks.getContext();
                const { queued, ready } = enqueueFinalizedMessages(
                    currentContext.chatMetadata,
                    currentContext.chat,
                    messageId,
                );
                if (queued.length === 0) return;
                await saveQueueMetadata(currentContext);
                if (ready.length === 0) return;
                const result = await callbacks.ingestMessages(ready);
                if (!result) return;
                const state = getQueueState(currentContext.chatMetadata, true);
                const ingested = new Set(ready);
                state.pendingMessageIds = state.pendingMessageIds.filter(id => !ingested.has(id));
                await saveQueueMetadata(currentContext);
            }).catch(error => console.error('[Memory Augment] Buffered message ingestion failed.', error));
        });
    }
    if (chatChanged) context.eventSource.on(chatChanged, reconcile);
    if (messageDeleted) context.eventSource.on(messageDeleted, reconcile);
    reconcile();
    return Boolean(messageSent || chatChanged || messageDeleted);
}
