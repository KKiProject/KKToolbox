import { clearCharacterDevelopmentRecords } from './character-development.js';
import { clearStoryStatusRecords } from './story-status.js';

export const BRANCH_STATE_KEY = 'kktoolbox_branch_state';

const BRANCH_STATE_VERSION = 1;
const FLOOR_SCOPED_METADATA_KEYS = Object.freeze([
    'memory_augment_barrages',
    'memory_augment_side_results',
    'memory_augment_custom_panels',
]);

let lifecycleBound = false;

function cleanText(value, maximum = 500) {
    return String(value ?? '').trim().slice(0, maximum);
}

function getChatId(context) {
    return cleanText(context?.getCurrentChatId?.() ?? context?.chatId);
}

function parseBranchFloor(chatId) {
    const match = cleanText(chatId).match(/(?:^|\s)Branch\s*#\s*(\d+)(?:\s|$|-)/iu);
    return match ? Number(match[1]) : null;
}

function getForkTimestamp(message) {
    const raw = message?.send_date ?? message?.timestamp ?? message?.createdAt;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
        return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(String(raw ?? ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function pruneNumericStore(store, firstRemovedMessageId) {
    if (!store || typeof store !== 'object' || Array.isArray(store)) return false;
    let changed = false;
    for (const key of Object.keys(store)) {
        const messageId = Number(key);
        if (Number.isInteger(messageId) && messageId >= firstRemovedMessageId) {
            delete store[key];
            changed = true;
        }
    }
    return changed;
}

function pruneFloorScopedMetadata(context, forkMessageId) {
    const firstRemovedMessageId = forkMessageId + 1;
    const metadata = context?.chatMetadata;
    let changed = false;
    for (const key of FLOOR_SCOPED_METADATA_KEYS) {
        changed = pruneNumericStore(metadata?.[key], firstRemovedMessageId) || changed;
    }
    changed = clearStoryStatusRecords(context, firstRemovedMessageId) || changed;
    changed = clearCharacterDevelopmentRecords(context, firstRemovedMessageId) || changed;
    return changed;
}

function makeRootState(chatId) {
    return {
        version: BRANCH_STATE_VERSION,
        kind: 'root',
        ownerChatId: chatId,
        parentChatId: '',
        forkMessageId: -1,
        forkTimestamp: 0,
        summaryInitialized: true,
        phoneInitialized: true,
    };
}

function makeBranchState(context, chatId, parentChatId) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const namedFloor = parseBranchFloor(chatId);
    const lastMessageId = Math.max(-1, chat.length - 1);
    const forkMessageId = Number.isInteger(namedFloor) && namedFloor >= 0 && namedFloor <= lastMessageId
        ? namedFloor
        : lastMessageId;
    return {
        version: BRANCH_STATE_VERSION,
        kind: 'branch',
        ownerChatId: chatId,
        parentChatId,
        forkMessageId,
        forkTimestamp: getForkTimestamp(chat[forkMessageId]),
        summaryInitialized: false,
        phoneInitialized: false,
        createdAt: Date.now(),
    };
}

/**
 * Detects SillyTavern's copied branch metadata and turns it into an independent
 * KKToolbox save identity. The mutation is synchronous so later CHAT_CHANGED
 * listeners never observe parent-only derived state beyond the fork floor.
 */
export function prepareBranchState(context = globalThis.SillyTavern?.getContext?.()) {
    const metadata = context?.chatMetadata;
    const chatId = getChatId(context);
    if (!metadata || typeof metadata !== 'object' || !chatId) {
        return { state: null, changed: false, createdBranch: false };
    }

    const parentChatId = cleanText(metadata.main_chat);
    const existing = metadata[BRANCH_STATE_KEY];
    const validExisting = existing && typeof existing === 'object' && !Array.isArray(existing);

    if (!validExisting) {
        const state = parentChatId
            ? makeBranchState(context, chatId, parentChatId)
            : makeRootState(chatId);
        metadata[BRANCH_STATE_KEY] = state;
        if (state.kind === 'branch') pruneFloorScopedMetadata(context, state.forkMessageId);
        return { state, changed: true, createdBranch: state.kind === 'branch' };
    }

    const ownerChatId = cleanText(existing.ownerChatId);
    if (ownerChatId === chatId) {
        existing.version = BRANCH_STATE_VERSION;
        return { state: existing, changed: false, createdBranch: false };
    }

    // createBranch() overwrites main_chat with the current parent's chat ID.
    // Therefore a copied owner which equals main_chat is a new fork, while an
    // owner mismatch with a different main_chat is only a renamed chat file.
    if (parentChatId && (!ownerChatId || parentChatId === ownerChatId)) {
        const state = makeBranchState(context, chatId, parentChatId);
        metadata[BRANCH_STATE_KEY] = state;
        pruneFloorScopedMetadata(context, state.forkMessageId);
        return { state, changed: true, createdBranch: true };
    }

    existing.version = BRANCH_STATE_VERSION;
    existing.ownerChatId = chatId;
    return { state: existing, changed: true, createdBranch: false };
}

export function getBranchState(context = globalThis.SillyTavern?.getContext?.()) {
    return prepareBranchState(context).state;
}

export function initializeBranchStateLifecycle(context = globalThis.SillyTavern?.getContext?.()) {
    const persist = (targetContext) => {
        const result = prepareBranchState(targetContext);
        if (result.changed) {
            void Promise.resolve(targetContext?.saveMetadata?.())
                .catch(error => console.warn('[KKToolbox] 分支存档标记保存失败。', error));
        }
        return result;
    };

    persist(context);
    if (lifecycleBound || !context?.eventSource) return false;
    const chatChanged = context?.eventTypes?.CHAT_CHANGED ?? context?.event_types?.CHAT_CHANGED;
    if (!chatChanged) return false;
    context.eventSource.on(chatChanged, () => {
        const current = globalThis.SillyTavern?.getContext?.() ?? context;
        persist(current);
    });
    lifecycleBound = true;
    return true;
}
