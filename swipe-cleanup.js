import { compactSwipeDerivedData, pruneOrphanedSwipeDerivedData } from './barrage-ui.js';

export const RETAIN_RECENT_SWIPE_FLOORS = 30;
let cleanupBound = false;
let cleanupQueue = Promise.resolve();

function cloneValue(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function getSelectedSwipeIndex(message) {
    const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
    const numeric = Math.trunc(Number(message?.swipe_id));
    if (Number.isInteger(numeric) && numeric >= 0 && numeric < swipes.length) return numeric;
    const current = String(message?.mes ?? '').trim();
    const matched = swipes.findIndex(value => String(value ?? '').trim() === current);
    return matched >= 0 ? matched : 0;
}

function compactMessageSwipes(context, messageId, message) {
    const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
    // SillyTavern may mark hidden historical AI floors as system messages.
    // Their selected story text is still canonical, so compact them exactly
    // like visible assistant floors while continuing to ignore user messages.
    if (swipes.length <= 1 || message?.is_user) return 0;
    const selectedIndex = getSelectedSwipeIndex(message);
    const currentText = String(message?.mes ?? swipes[selectedIndex] ?? '');
    compactSwipeDerivedData(context, messageId, message, selectedIndex);

    const infoArray = Array.isArray(message?.swipe_info)
        ? message.swipe_info
        : Array.isArray(message?.swipes_info) ? message.swipes_info : [];
    const selectedInfo = cloneValue(infoArray[selectedIndex] ?? {});
    if (message?.extra && typeof message.extra === 'object') {
        selectedInfo.extra = cloneValue(message.extra);
    }
    message.mes = currentText;
    message.swipes = [currentText];
    message.swipe_info = [selectedInfo];
    delete message.swipes_info;
    message.swipe_id = 0;
    return swipes.length - 1;
}

/**
 * Keeps every currently selected story reply. Only alternative assistant
 * swipes older than the protected recent window are removed.
 */
export async function compactOldSwipes(context, options = {}) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const keepRecentFloors = Math.max(1, Math.trunc(Number(options.keepRecentFloors)
        || RETAIN_RECENT_SWIPE_FLOORS));
    const firstProtectedIndex = Math.max(0, chat.length - keepRecentFloors);
    let compactedFloors = 0;
    let removedAlternatives = 0;
    for (let messageId = 0; messageId < firstProtectedIndex; messageId++) {
        const removed = compactMessageSwipes(context, messageId, chat[messageId]);
        if (removed <= 0) continue;
        compactedFloors++;
        removedAlternatives += removed;
    }
    const metadataChanged = pruneOrphanedSwipeDerivedData(context);
    if (compactedFloors > 0 || metadataChanged) await context?.saveChat?.();
    return { compactedFloors, removedAlternatives, metadataChanged };
}

export function initializeSwipeCleanup(context = globalThis.SillyTavern?.getContext?.()) {
    if (cleanupBound || !context?.eventSource) return false;
    const messageRendered = context.eventTypes?.CHARACTER_MESSAGE_RENDERED
        ?? context.event_types?.CHARACTER_MESSAGE_RENDERED;
    const chatChanged = context.eventTypes?.CHAT_CHANGED ?? context.event_types?.CHAT_CHANGED;
    const enqueue = () => {
        cleanupQueue = cleanupQueue.catch(() => undefined).then(async () => {
            const current = globalThis.SillyTavern?.getContext?.() ?? context;
            const result = await compactOldSwipes(current);
            if (result.removedAlternatives > 0) {
                console.info(`[Memory Augment] Removed ${result.removedAlternatives} old alternative swipes while preserving every selected story reply.`);
            }
        }).catch(error => console.warn('[Memory Augment] Old swipe cleanup failed.', error));
    };
    if (messageRendered) context.eventSource.on(messageRendered, () => setTimeout(enqueue, 0));
    if (chatChanged) context.eventSource.on(chatChanged, () => setTimeout(enqueue, 0));
    setTimeout(enqueue, 0);
    cleanupBound = true;
    return true;
}
