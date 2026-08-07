export const PHONE_STORE_VERSION = 3;
export const PHONE_MESSAGE_TYPES = Object.freeze([
    'text',
    'voice',
    'image',
    'redpacket',
    'group_redpacket',
    'location',
    'sticker',
]);
export const PHONE_IDENTITY_MODES = Object.freeze(['unbound', 'character_card', 'worldbook', 'custom']);
export const PHONE_MEMORY_EVENT_TYPES = Object.freeze([
    'platform_fact',
    'explicit_action',
    'commitment',
    'conflict',
    'confirmed_reaction',
    'unknown_state',
]);
export const PHONE_MEMORY_EVENT_STATUSES = Object.freeze(['informational', 'active', 'resolved']);

const storeCache = new Map();
const writeLocks = new Map();
const preparedStoryInjections = new Map();
const PHONE_CONTEXT_MARKER = 'memory_augment_phone_context';
const PHONE_MAIN_CONTEXT_CHAR_LIMIT = 50_000;
const PHONE_PENDING_RAW_CHAR_TARGET = 46_000;

function cleanText(value, maximum = 4000) {
    return String(value ?? '').trim().slice(0, maximum);
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

function makeId(prefix = 'item') {
    const random = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}-${random}`;
}

export function createPhoneRoundId() {
    return makeId('round');
}

export function getPhoneChatId(context = globalThis.SillyTavern?.getContext?.()) {
    return cleanText(context?.getCurrentChatId?.() ?? context?.chatId, 500);
}

function getPhoneScope(chatId) {
    const id = cleanText(chatId, 500);
    if (!id) return null;
    const fileName = `kktoolbox_phone_${hashHex(id)}.json`;
    return {
        id,
        fileName,
        url: `/user/files/${fileName}`,
    };
}

export function createEmptyPhoneStore(chatId = '') {
    return {
        version: PHONE_STORE_VERSION,
        chatId: cleanText(chatId, 500),
        profile: normalizePhoneProfile(),
        conversations: [],
        onlineMemory: { events: [] },
        updatedAt: 0,
    };
}

export function normalizePhoneProfile(value = {}) {
    return {
        nickname: cleanText(value?.nickname, 80) || '我',
        avatar: cleanText(value?.avatar, 4000),
    };
}

function normalizeClaim(value) {
    return {
        name: cleanText(value?.name, 80),
        amount: Math.max(0, Number(value?.amount) || 0).toFixed(2),
    };
}

function normalizeMessageReference(value = {}) {
    const content = cleanText(value?.content, 1000);
    const sender = cleanText(value?.sender, 80);
    const conversationName = cleanText(value?.conversationName, 120);
    if (!content && !sender && !conversationName) return null;
    return {
        messageId: cleanText(value?.messageId ?? value?.id, 120),
        sender,
        content,
        conversationName,
    };
}

export function normalizePhoneIdentity(value = {}) {
    const mode = PHONE_IDENTITY_MODES.includes(value?.mode) ? value.mode : 'unbound';
    return {
        mode,
        sourceKey: cleanText(value?.sourceKey, 500),
        label: cleanText(value?.label, 160) || (mode === 'unbound' ? '尚未绑定' : '自定义人物'),
        persona: cleanText(value?.persona, 16000),
        note: cleanText(value?.note, 4000),
    };
}

export function normalizePhoneMessage(value) {
    const type = PHONE_MESSAGE_TYPES.includes(value?.type) ? value.type : 'text';
    return {
        id: cleanText(value?.id, 120) || makeId('msg'),
        roundId: cleanText(value?.roundId, 120),
        sender: cleanText(value?.sender, 80) || '未知联系人',
        fromUser: value?.fromUser === true,
        type,
        content: cleanText(value?.content, 4000),
        assetUrl: cleanText(value?.assetUrl, 4000),
        stickerName: cleanText(value?.stickerName ?? value?.sticker, 120),
        amount: Math.max(0, Number(value?.amount) || 0).toFixed(2),
        count: Math.max(0, Math.trunc(Number(value?.count) || 0)),
        duration: Math.max(1, Math.min(60, Math.trunc(Number(value?.duration) || 1))),
        claims: Array.isArray(value?.claims) ? value.claims.map(normalizeClaim).filter(item => item.name) : [],
        quote: normalizeMessageReference(value?.quote),
        forwardedFrom: normalizeMessageReference(value?.forwardedFrom),
        editedAt: Number.isFinite(Number(value?.editedAt)) ? Number(value.editedAt) : 0,
        timestamp: Number.isFinite(Number(value?.timestamp)) ? Number(value.timestamp) : Date.now(),
        queued: value?.queued === true,
        storyPending: value?.storyPending === true,
    };
}

function normalizeRoundSummary(value = {}) {
    return {
        id: cleanText(value?.id ?? value?.roundId, 120),
        summary: cleanText(value?.summary, 1200),
        createdAt: Number.isFinite(Number(value?.createdAt)) ? Number(value.createdAt) : Date.now(),
        updatedAt: Number.isFinite(Number(value?.updatedAt)) ? Number(value.updatedAt) : Date.now(),
    };
}

function normalizeConversationMessages(values) {
    const messages = (Array.isArray(values) ? values : []).map(normalizePhoneMessage);
    let activeLegacyRound = '';
    for (const message of messages) {
        if (message.roundId) {
            activeLegacyRound = message.roundId;
            continue;
        }
        if (message.fromUser || !activeLegacyRound) activeLegacyRound = createPhoneRoundId();
        message.roundId = activeLegacyRound;
    }
    return messages;
}

export function normalizePhoneMemoryEvent(value = {}) {
    const type = PHONE_MEMORY_EVENT_TYPES.includes(value?.type) ? value.type : 'explicit_action';
    const defaultStatus = ['commitment', 'conflict'].includes(type) ? 'active' : 'informational';
    const status = PHONE_MEMORY_EVENT_STATUSES.includes(value?.status) ? value.status : defaultStatus;
    return {
        id: cleanText(value?.id, 120) || makeId('online-memory'),
        type,
        summary: cleanText(value?.summary, 600),
        participants: [...new Set((Array.isArray(value?.participants) ? value.participants : [])
            .map(item => cleanText(item, 80)).filter(Boolean))],
        conversationId: cleanText(value?.conversationId, 120),
        sourceMessageIds: [...new Set((Array.isArray(value?.sourceMessageIds) ? value.sourceMessageIds : [])
            .map(item => cleanText(item, 120)).filter(Boolean))],
        evidenceQuotes: [...new Set((Array.isArray(value?.evidenceQuotes) ? value.evidenceQuotes : [])
            .map(item => cleanText(item, 500)).filter(Boolean))],
        certainty: 'explicit',
        manualOverride: value?.manualOverride === true,
        status,
        pending: value?.pending === true,
        createdAt: Number.isFinite(Number(value?.createdAt)) ? Number(value.createdAt) : Date.now(),
        updatedAt: Number.isFinite(Number(value?.updatedAt)) ? Number(value.updatedAt) : Date.now(),
        resolvedAt: status === 'resolved'
            ? (Number.isFinite(Number(value?.resolvedAt)) ? Number(value.resolvedAt) : Date.now())
            : 0,
        consumedAt: Number.isFinite(Number(value?.consumedAt)) ? Number(value.consumedAt) : 0,
    };
}

function normalizeConversation(value) {
    const type = value?.type === 'group' ? 'group' : 'direct';
    const members = type === 'group'
        ? [...new Set((Array.isArray(value?.members) ? value.members : [])
            .map(member => cleanText(member, 80))
            .filter(Boolean))]
        : [];
    const rawMemberIdentities = value?.memberIdentities && typeof value.memberIdentities === 'object'
        ? value.memberIdentities
        : {};
    const messages = normalizeConversationMessages(value?.messages);
    const existingSummaries = new Map((Array.isArray(value?.rounds) ? value.rounds : [])
        .map(normalizeRoundSummary)
        .filter(item => item.id)
        .map(item => [item.id, item]));
    const rounds = [];
    const seenRounds = new Set();
    for (const message of messages) {
        if (seenRounds.has(message.roundId)) continue;
        seenRounds.add(message.roundId);
        const saved = existingSummaries.get(message.roundId);
        rounds.push(saved ?? {
            id: message.roundId,
            summary: '',
            createdAt: message.timestamp,
            updatedAt: message.timestamp,
        });
    }
    return {
        id: cleanText(value?.id, 120) || makeId(type),
        type,
        name: cleanText(value?.name, 120) || (type === 'group' ? '新群聊' : '新好友'),
        avatar: cleanText(value?.avatar, 4000),
        members,
        identity: normalizePhoneIdentity(value?.identity),
        memberIdentities: Object.fromEntries(members.map(member => [
            member,
            normalizePhoneIdentity(rawMemberIdentities[member]),
        ])),
        messages,
        rounds,
        createdAt: Number.isFinite(Number(value?.createdAt)) ? Number(value.createdAt) : Date.now(),
    };
}

export function normalizePhoneStore(value, chatId = '') {
    const store = value && typeof value === 'object' ? value : {};
    return {
        version: PHONE_STORE_VERSION,
        chatId: cleanText(chatId || store.chatId, 500),
        profile: normalizePhoneProfile(store?.profile),
        conversations: (Array.isArray(store.conversations) ? store.conversations : [])
            .map(normalizeConversation),
        onlineMemory: {
            events: (Array.isArray(store?.onlineMemory?.events) ? store.onlineMemory.events : [])
                .map(normalizePhoneMemoryEvent)
                .filter(event => event.summary),
        },
        updatedAt: Number(store.updatedAt) || 0,
    };
}

function getRequestHeaders() {
    return {
        'Content-Type': 'application/json',
        ...(globalThis.SillyTavern?.getContext?.().getRequestHeaders?.() ?? {}),
    };
}

function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

export async function loadPhoneStore(context = globalThis.SillyTavern?.getContext?.(), options = {}) {
    const chatId = getPhoneChatId(context);
    const scope = getPhoneScope(chatId);
    if (!scope) return createEmptyPhoneStore('');
    if (!options.force && storeCache.has(chatId)) return storeCache.get(chatId);
    const response = await fetch(`${scope.url}?v=${Date.now()}`, {
        headers: getRequestHeaders(),
        cache: 'no-store',
    });
    if (response.status === 404) {
        const empty = createEmptyPhoneStore(chatId);
        storeCache.set(chatId, empty);
        return empty;
    }
    if (!response.ok) throw new Error(`读取手机数据失败（${response.status}）。`);
    const store = normalizePhoneStore(await response.json(), chatId);
    storeCache.set(chatId, store);
    return store;
}

export async function savePhoneStore(store, context = globalThis.SillyTavern?.getContext?.()) {
    const chatId = getPhoneChatId(context) || cleanText(store?.chatId, 500);
    const scope = getPhoneScope(chatId);
    if (!scope) throw new Error('请先在酒馆中打开一个角色卡聊天，再创建手机联系人、群聊或消息。');
    const previous = writeLocks.get(chatId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
        const normalized = normalizePhoneStore(store, chatId);
        normalized.updatedAt = Date.now();
        const response = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                name: scope.fileName,
                data: encodeBase64Utf8(`${JSON.stringify(normalized)}\n`),
            }),
        });
        if (!response.ok) throw new Error(`保存手机数据失败（${response.status}）。`);
        Object.assign(store, normalized);
        storeCache.set(chatId, store);
        return store;
    });
    writeLocks.set(chatId, current);
    try {
        return await current;
    } finally {
        if (writeLocks.get(chatId) === current) writeLocks.delete(chatId);
    }
}

export function createPhoneConversation(store, input = {}) {
    const conversation = normalizeConversation({
        ...input,
        id: makeId(input?.type === 'group' ? 'group' : 'direct'),
        createdAt: Date.now(),
        messages: [],
    });
    store.conversations.push(conversation);
    return conversation;
}

export function renamePhoneConversation(store, conversationId, name) {
    const conversation = store?.conversations?.find(item => item.id === conversationId);
    const nextName = cleanText(name, 120);
    if (!conversation || !nextName) return null;
    conversation.name = nextName;
    return conversation;
}

export function removePhoneConversation(store, conversationId) {
    const conversations = store?.conversations;
    if (!Array.isArray(conversations)) return null;
    const index = conversations.findIndex(item => item.id === conversationId);
    if (index < 0) return null;
    const [conversation] = conversations.splice(index, 1);
    if (Array.isArray(store?.onlineMemory?.events)) {
        store.onlineMemory.events = store.onlineMemory.events
            .filter(event => event.conversationId !== conversationId);
    }
    return conversation;
}

export function appendPhoneMessage(store, conversationId, input = {}) {
    const conversation = store.conversations.find(item => item.id === conversationId);
    if (!conversation) throw new Error('没有找到这个联系人或群聊。');
    const message = normalizePhoneMessage({
        ...input,
        id: makeId('msg'),
        roundId: cleanText(input?.roundId, 120) || createPhoneRoundId(),
        timestamp: Date.now(),
        queued: input?.queued === true,
        storyPending: input?.queued === true ? false : input?.storyPending !== false,
    });
    conversation.messages.push(message);
    conversation.rounds ??= [];
    if (!conversation.rounds.some(round => round.id === message.roundId)) {
        conversation.rounds.push({
            id: message.roundId,
            summary: '',
            createdAt: message.timestamp,
            updatedAt: message.timestamp,
        });
    }
    return message;
}

function invalidatePhoneRound(conversation, roundId) {
    const round = conversation.rounds?.find(item => item.id === roundId);
    if (!round) return;
    round.summary = '';
    round.updatedAt = Date.now();
}

function removeMemoryEventsBackedByMessage(store, conversationId, message) {
    if (!Array.isArray(store?.onlineMemory?.events)) return 0;
    const before = store.onlineMemory.events.length;
    store.onlineMemory.events = store.onlineMemory.events.filter(event => {
        if (event.conversationId !== conversationId) return true;
        const sourceIds = Array.isArray(event.sourceMessageIds) ? event.sourceMessageIds : [];
        const explicitlyOnlyFromMessage = sourceIds.length === 1 && sourceIds[0] === message.id;
        const quotesBackedByMessage = (event.evidenceQuotes ?? [])
            .some(quote => quoteExistsInMessages(quote, [message]));
        return !explicitlyOnlyFromMessage && !quotesBackedByMessage;
    });
    return before - store.onlineMemory.events.length;
}

export function updatePhoneMessage(store, conversationId, messageId, changes = {}) {
    const conversation = store?.conversations?.find(item => item.id === conversationId);
    const message = conversation?.messages?.find(item => item.id === messageId);
    if (!conversation || !message) return null;
    const removedMemoryEvents = removeMemoryEventsBackedByMessage(store, conversationId, message);
    if (changes.content !== undefined) message.content = cleanText(changes.content, 4000);
    if (changes.stickerName !== undefined) message.stickerName = cleanText(changes.stickerName, 120);
    message.editedAt = Date.now();
    message.storyPending = message.queued !== true;
    invalidatePhoneRound(conversation, message.roundId);
    return { message, removedMemoryEvents };
}

export function forwardPhoneMessages(store, sourceConversationId, targetConversationId, messageIds, sender = '我') {
    const source = store?.conversations?.find(item => item.id === sourceConversationId);
    const target = store?.conversations?.find(item => item.id === targetConversationId);
    const selected = new Set((Array.isArray(messageIds) ? messageIds : []).map(String));
    if (!source || !target || selected.size === 0) return [];
    const roundId = createPhoneRoundId();
    return source.messages
        .filter(message => selected.has(message.id))
        .map(message => appendPhoneMessage(store, target.id, {
            ...message,
            roundId,
            sender: cleanText(sender, 80) || '我',
            fromUser: true,
            forwardedFrom: {
                messageId: message.id,
                sender: message.sender,
                content: formatPhoneMessageForAi(message),
                conversationName: source.name,
            },
            editedAt: 0,
            queued: true,
            storyPending: false,
        }));
}

export function getQueuedPhoneMessages(store, conversationId) {
    const conversation = store?.conversations?.find(item => item.id === conversationId);
    return conversation?.messages?.filter(message => message.queued === true) ?? [];
}

export function commitQueuedPhoneMessages(store, conversationId) {
    const conversation = store?.conversations?.find(item => item.id === conversationId);
    if (!conversation) return null;
    const messages = conversation.messages.filter(message => message.queued === true);
    if (messages.length === 0) return null;
    const roundId = messages[0].roundId || createPhoneRoundId();
    const abandonedRoundIds = new Set(messages.map(message => message.roundId).filter(id => id && id !== roundId));
    for (const message of messages) {
        message.roundId = roundId;
        message.queued = false;
        message.storyPending = true;
    }
    conversation.rounds = (conversation.rounds ?? []).filter(round => (
        !abandonedRoundIds.has(round.id)
        || conversation.messages.some(message => message.roundId === round.id)
    ));
    if (!conversation.rounds.some(round => round.id === roundId)) {
        conversation.rounds.push({
            id: roundId,
            summary: '',
            createdAt: messages[0].timestamp,
            updatedAt: Date.now(),
        });
    }
    return { roundId, messages };
}

export function removeLatestPhoneReply(store, conversationId) {
    const conversation = store?.conversations?.find(item => item.id === conversationId);
    if (!conversation) return null;
    const latestReply = [...conversation.messages]
        .reverse()
        .find(message => message.fromUser !== true && message.queued !== true);
    if (!latestReply) return null;
    const removed = conversation.messages.filter(message => (
        message.roundId === latestReply.roundId
        && message.fromUser !== true
        && message.queued !== true
    ));
    const removedIds = new Set(removed.map(message => message.id));
    conversation.messages = conversation.messages.filter(message => !removedIds.has(message.id));
    invalidatePhoneRound(conversation, latestReply.roundId);
    const before = store?.onlineMemory?.events?.length ?? 0;
    if (Array.isArray(store?.onlineMemory?.events)) {
        store.onlineMemory.events = store.onlineMemory.events.filter(event => {
            if (event.conversationId !== conversationId) return true;
            if ((event.sourceMessageIds ?? []).some(id => removedIds.has(id))) return false;
            return !(event.evidenceQuotes ?? []).some(quote => quoteExistsInMessages(quote, removed));
        });
    }
    return {
        roundId: latestReply.roundId,
        messages: removed,
        removedMemoryEvents: before - (store?.onlineMemory?.events?.length ?? 0),
    };
}

export function removePhoneMessage(store, conversationId, messageId) {
    const conversation = store?.conversations?.find(item => item.id === conversationId);
    if (!conversation) return null;
    const index = conversation.messages.findIndex(message => message.id === messageId);
    if (index < 0) return null;
    const [message] = conversation.messages.splice(index, 1);
    const roundStillExists = conversation.messages.some(item => item.roundId === message.roundId);
    if (roundStillExists) {
        invalidatePhoneRound(conversation, message.roundId);
    } else {
        conversation.rounds = (conversation.rounds ?? []).filter(round => round.id !== message.roundId);
    }
    const removedMemoryEvents = removeMemoryEventsBackedByMessage(store, conversationId, message);
    return { message, removedMemoryEvents };
}

export function setPhoneRoundSummary(store, conversationId, roundId, summary) {
    const conversation = store?.conversations?.find(item => item.id === conversationId);
    const id = cleanText(roundId, 120);
    const content = cleanText(summary, 1200);
    if (!conversation || !id || !content) return null;
    conversation.rounds ??= [];
    let round = conversation.rounds.find(item => item.id === id);
    if (!round) {
        round = { id, summary: '', createdAt: Date.now(), updatedAt: Date.now() };
        conversation.rounds.push(round);
    }
    round.summary = content;
    round.updatedAt = Date.now();
    return round;
}

export function getRecentRoundMessages(conversation, roundLimit = 30) {
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    const maximum = Math.max(1, Math.trunc(Number(roundLimit) || 30));
    const recentRoundIds = [];
    const seen = new Set();
    for (let index = messages.length - 1; index >= 0 && recentRoundIds.length < maximum; index--) {
        const id = cleanText(messages[index]?.roundId, 120);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        recentRoundIds.push(id);
    }
    const allowed = new Set(recentRoundIds);
    return messages.filter(message => allowed.has(message.roundId));
}

function normalizeComparableText(value) {
    return cleanText(value, 4000).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function quoteExistsInMessages(quote, messages) {
    const needle = cleanText(quote, 500);
    if (!needle) return false;
    return messages.some(message => {
        const haystacks = [
            message?.content,
            message?.stickerName,
            formatPhoneMessageForAi(message),
        ].map(value => String(value ?? ''));
        return haystacks.some(value => value.includes(needle));
    });
}

function explicitReactionIsSupported(summary, evidenceQuotes) {
    const markers = [
        '看见', '看到', '看过', '看了', '读过', '读了', '听见', '听到', '知道', '理解',
        '赞同', '反对', '接受', '拒绝', '喜欢', '讨厌', '满意', '不满', '开心', '高兴',
        '难过', '伤心', '生气', '愤怒', '害羞', '尴尬', '感动', '震惊', '害怕', '后悔',
        '无所谓', '恶心', '心疼', '笑死', '气死', '吓死',
    ];
    const summaryText = String(summary ?? '');
    const evidenceText = evidenceQuotes.join('\n');
    return markers.some(marker => summaryText.includes(marker) && evidenceText.includes(marker));
}

/**
 * Accepts only evidence-backed online memories. The model may suggest records,
 * but it cannot create a record unless every quoted piece exists verbatim in
 * the persisted phone messages.
 */
export function recordPhoneMemoryEvents(store, conversationId, suggestions = [], options = {}) {
    store.onlineMemory ??= { events: [] };
    store.onlineMemory.events ??= [];
    const conversation = store.conversations.find(item => item.id === conversationId);
    if (!conversation) return { added: [], resolved: [] };
    const sourceMessages = Array.isArray(options.messages) ? options.messages : conversation.messages;
    const sourceIds = new Set(sourceMessages.map(message => cleanText(message?.id, 120)).filter(Boolean));
    const existingIds = new Set(store.onlineMemory.events.map(event => event.id));
    const resolved = [];

    for (const candidate of suggestions) {
        for (const eventId of Array.isArray(candidate?.resolvesEventIds) ? candidate.resolvesEventIds : []) {
            const id = cleanText(eventId, 120);
            const event = store.onlineMemory.events.find(item => item.id === id && item.status === 'active');
            const quotes = (Array.isArray(candidate?.evidenceQuotes) ? candidate.evidenceQuotes : [])
                .map(item => cleanText(item, 500)).filter(Boolean);
            if (!event || quotes.length === 0 || !quotes.every(quote => quoteExistsInMessages(quote, sourceMessages))) continue;
            event.status = 'resolved';
            event.resolvedAt = Date.now();
            event.updatedAt = event.resolvedAt;
            event.pending = true;
            resolved.push(event);
        }
    }

    const added = [];
    for (const candidate of suggestions) {
        const type = PHONE_MEMORY_EVENT_TYPES.includes(candidate?.type) ? candidate.type : '';
        const summary = cleanText(candidate?.summary, 600);
        const evidenceQuotes = (Array.isArray(candidate?.evidenceQuotes) ? candidate.evidenceQuotes : [])
            .map(item => cleanText(item, 500)).filter(Boolean);
        if (!type || !summary || evidenceQuotes.length === 0) continue;
        if (!evidenceQuotes.every(quote => quoteExistsInMessages(quote, sourceMessages))) continue;
        if (type === 'confirmed_reaction' && !explicitReactionIsSupported(summary, evidenceQuotes)) continue;
        const duplicateKey = `${type}:${normalizeComparableText(summary)}`;
        if (store.onlineMemory.events.some(event => {
            if (event.type !== type) return false;
            if (`${event.type}:${normalizeComparableText(event.summary)}` === duplicateKey) return true;
            return evidenceQuotes.some(quote => event.evidenceQuotes?.includes(quote));
        })) continue;
        const requestedIds = (Array.isArray(candidate?.sourceMessageIds) ? candidate.sourceMessageIds : [])
            .map(item => cleanText(item, 120)).filter(id => sourceIds.has(id));
        const event = normalizePhoneMemoryEvent({
            ...candidate,
            id: makeId('online-memory'),
            conversationId,
            sourceMessageIds: requestedIds.length > 0 ? requestedIds : [...sourceIds],
            evidenceQuotes,
            certainty: 'explicit',
            pending: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        if (existingIds.has(event.id)) continue;
        store.onlineMemory.events.push(event);
        existingIds.add(event.id);
        added.push(event);
    }
    return { added, resolved };
}

export function updatePhoneMemoryEvent(store, eventId, changes = {}) {
    const event = store?.onlineMemory?.events?.find(item => item.id === eventId);
    if (!event) return null;
    if (changes.summary !== undefined) event.summary = cleanText(changes.summary, 600) || event.summary;
    if (changes.status !== undefined && PHONE_MEMORY_EVENT_STATUSES.includes(changes.status)) {
        event.status = changes.status;
        event.resolvedAt = changes.status === 'resolved' ? Date.now() : 0;
    }
    event.manualOverride = true;
    event.updatedAt = Date.now();
    event.pending = true;
    return event;
}

export function removePhoneMemoryEvent(store, eventId) {
    const events = store?.onlineMemory?.events;
    if (!Array.isArray(events)) return false;
    const index = events.findIndex(item => item.id === eventId);
    if (index < 0) return false;
    events.splice(index, 1);
    return true;
}

function createRandom(seed) {
    let value = stableHash(seed) || 1;
    return () => {
        value ^= value << 13;
        value ^= value >>> 17;
        value ^= value << 5;
        return (value >>> 0) / 0x100000000;
    };
}

export function splitGroupRedPacket(total, names, requestedCount, seed = '') {
    const cents = Math.round(Math.max(0, Number(total) || 0) * 100);
    const participants = [...new Set((Array.isArray(names) ? names : [])
        .map(name => cleanText(name, 80))
        .filter(Boolean))];
    const count = Math.min(
        participants.length,
        Math.max(1, Math.trunc(Number(requestedCount) || participants.length)),
        cents,
    );
    if (count <= 0) return [];
    const random = createRandom(`${seed}\n${cents}\n${participants.join('|')}`);
    for (let index = participants.length - 1; index > 0; index -= 1) {
        const target = Math.floor(random() * (index + 1));
        [participants[index], participants[target]] = [participants[target], participants[index]];
    }
    let remaining = cents - count;
    const weights = Array.from({ length: count }, () => 0.2 + random());
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    const shares = weights.map(weight => 1 + Math.floor(remaining * weight / weightTotal));
    let assigned = shares.reduce((sum, value) => sum + value, 0);
    while (assigned < cents) {
        shares[Math.floor(random() * count)] += 1;
        assigned += 1;
    }
    while (assigned > cents) {
        const index = Math.floor(random() * count);
        if (shares[index] <= 1) continue;
        shares[index] -= 1;
        assigned -= 1;
    }
    return shares.map((share, index) => ({
        name: participants[index],
        amount: (share / 100).toFixed(2),
    }));
}

export function normalizePhoneStickers(settings) {
    settings.phone ??= {};
    settings.phone.stickers = (Array.isArray(settings.phone.stickers) ? settings.phone.stickers : [])
        .map(value => ({
            id: cleanText(value?.id, 120) || makeId('sticker'),
            name: cleanText(value?.name, 120),
            url: cleanText(value?.url, 4000),
        }))
        .filter(value => value.name && value.url);
    return settings.phone.stickers;
}

export function addPhoneSticker(settings, input = {}) {
    const stickers = normalizePhoneStickers(settings);
    const name = cleanText(input?.name, 120);
    const url = cleanText(input?.url, 4000);
    if (!name || !url) throw new Error('表情包需要名称和图片。');
    const existing = stickers.find(item => item.name === name);
    if (existing) {
        existing.url = url;
        return existing;
    }
    const sticker = { id: makeId('sticker'), name, url };
    stickers.push(sticker);
    return sticker;
}

export function removePhoneSticker(settings, stickerId) {
    const stickers = normalizePhoneStickers(settings);
    const index = stickers.findIndex(item => item.id === stickerId);
    if (index < 0) return false;
    stickers.splice(index, 1);
    return true;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

export async function uploadPhoneImage(file, prefix = 'asset') {
    if (!(file instanceof Blob)) throw new Error('没有选择图片。');
    if (file.size > 8 * 1024 * 1024) throw new Error('图片不能超过 8 MiB。');
    const extensions = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
    };
    const extension = extensions[file.type];
    if (!extension) throw new Error('只支持 PNG、JPG、WebP 和 GIF 图片。');
    const fileName = `kktoolbox_phone_${cleanText(prefix, 30).replace(/[^a-z0-9_-]/gi, '_')}_${makeId('img').replace(/[^a-z0-9_-]/gi, '')}.${extension}`;
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            name: fileName,
            data: arrayBufferToBase64(await file.arrayBuffer()),
        }),
    });
    if (!response.ok) throw new Error(`上传图片失败（${response.status}）。`);
    const payload = await response.json().catch(() => ({}));
    const path = cleanText(payload?.path, 4000) || `user/files/${fileName}`;
    return path.startsWith('/') ? path : `/${path}`;
}

export function formatPhoneMessageForAi(message) {
    const typeLabels = {
        text: '文字', voice: '语音文字', image: '图片描述', redpacket: '红包',
        group_redpacket: '群红包', location: '位置', sticker: '表情包',
    };
    const details = message.type === 'sticker'
        ? message.stickerName
        : ['redpacket', 'group_redpacket'].includes(message.type)
            ? `${message.amount}元 ${message.content}`.trim()
            : message.content;
    const references = [
        message.forwardedFrom
            ? `【转发自${message.forwardedFrom.conversationName || '其他会话'} · ${message.forwardedFrom.sender || '未知'}】`
            : '',
        message.quote
            ? `【引用${message.quote.sender || '未知'}：${message.quote.content || '消息'}】`
            : '',
    ].filter(Boolean).join('');
    return `${references}${message.sender} [${typeLabels[message.type] ?? '文字'}]: ${details}`;
}

export function buildPhoneAiSnapshot(store, conversationId, stickers = [], limit = null) {
    const conversation = store.conversations.find(item => item.id === conversationId);
    if (!conversation) return null;
    const hasRoundLimit = Number.isFinite(Number(limit)) && Number(limit) > 0;
    const deliveredMessages = conversation.messages.filter(message => message.queued !== true);
    const deliveredConversation = { ...conversation, messages: deliveredMessages };
    const recentMessages = hasRoundLimit
        ? getRecentRoundMessages(deliveredConversation, limit)
        : deliveredMessages;
    const recentRoundIds = new Set(recentMessages.map(message => message.roundId));
    const olderRoundSummaries = (conversation.rounds ?? [])
        .filter(round => !recentRoundIds.has(round.id) && cleanText(round.summary, 1200))
        .map(round => ({ id: round.id, summary: cleanText(round.summary, 1200) }));
    const activeMemory = (store?.onlineMemory?.events ?? [])
        .filter(event => event.conversationId === conversationId && event.status === 'active');
    return {
        profile: { ...store.profile },
        conversation: {
            id: conversation.id,
            type: conversation.type,
            name: conversation.name,
            members: [...conversation.members],
            identity: normalizePhoneIdentity(conversation.identity),
            memberIdentities: Object.fromEntries(conversation.members.map(member => [
                member,
                normalizePhoneIdentity(conversation.memberIdentities?.[member]),
            ])),
        },
        messages: recentMessages.map(formatPhoneMessageForAi),
        messageRecords: recentMessages.map(message => ({
            id: message.id,
            roundId: message.roundId,
            text: formatPhoneMessageForAi(message),
        })),
        olderRoundSummaries,
        roundSummaries: (conversation.rounds ?? [])
            .filter(round => cleanText(round.summary, 1200))
            .map(round => ({ id: round.id, summary: cleanText(round.summary, 1200) })),
        activeMemory: activeMemory.map(event => ({
            id: event.id,
            type: event.type,
            summary: event.summary,
            participants: [...event.participants],
        })),
        stickers: stickers.map(item => item.name),
    };
}

function getPhoneContextSelection(store, limit = 12, recalledEvents = []) {
    const allMessages = store.conversations
        .flatMap(conversation => conversation.messages
            .filter(message => message.queued !== true)
            .map(message => ({ conversation, message })))
        .sort((left, right) => left.message.timestamp - right.message.timestamp);
    const pendingMessages = allMessages.filter(item => item.message.storyPending === true);
    const pendingIds = new Set(pendingMessages.map(item => item.message.id));
    const recentRoundKeys = [];
    const seenRounds = new Set();
    for (let index = allMessages.length - 1; index >= 0 && recentRoundKeys.length < Math.max(1, limit); index--) {
        const item = allMessages[index];
        const key = `${item.conversation.id}:${item.message.roundId}`;
        if (seenRounds.has(key)) continue;
        seenRounds.add(key);
        recentRoundKeys.push(key);
    }
    const recentRoundSet = new Set(recentRoundKeys);
    const recent = allMessages.filter(item => (
        recentRoundSet.has(`${item.conversation.id}:${item.message.roundId}`)
        && !pendingIds.has(item.message.id)
    ));
    const messages = [...pendingMessages, ...recent]
        .sort((left, right) => left.message.timestamp - right.message.timestamp);
    const automaticEvents = (store?.onlineMemory?.events ?? [])
        .filter(event => event.pending === true || event.status === 'active')
        .sort((left, right) => left.updatedAt - right.updatedAt);
    const eventIds = new Set(automaticEvents.map(event => event.id));
    const events = [
        ...(Array.isArray(recalledEvents) ? recalledEvents : []).filter(event => !eventIds.has(event.id)),
        ...automaticEvents,
    ];
    return {
        messages,
        events,
        pendingMessageIds: pendingMessages.map(item => item.message.id),
        pendingEventIds: automaticEvents.filter(event => event.pending).map(event => event.id),
    };
}

function formatPhoneMemoryEvent(event, store) {
    const labels = {
        platform_fact: '平台内容事实',
        explicit_action: '明确操作',
        commitment: '约定／承诺',
        conflict: '尚未解决的线上冲突',
        confirmed_reaction: '已明确表达的反应',
        unknown_state: '仍未确认的状态',
    };
    const conversation = store.conversations.find(item => item.id === event.conversationId);
    const state = event.status === 'resolved' ? '（已解决）' : event.status === 'active' ? '（仍有效）' : '';
    return `[${labels[event.type] ?? '线上事实'}${state}${conversation ? ` · ${conversation.name}` : ''}] ${event.summary}`;
}

export function buildPhonePromptContext(store, limit = 12, recalledEvents = []) {
    const selection = getPhoneContextSelection(store, limit, recalledEvents);
    const { messages, events } = selection;
    if (messages.length === 0 && events.length === 0) return '';
    const pendingItems = messages.filter(item => item.message.storyPending === true);
    const recentItems = messages.filter(item => item.message.storyPending !== true);
    const groupedPending = [];
    const pendingByRound = new Map();
    for (const item of pendingItems) {
        const key = `${item.conversation.id}:${item.message.roundId}`;
        let group = pendingByRound.get(key);
        if (!group) {
            group = { conversation: item.conversation, roundId: item.message.roundId, items: [] };
            pendingByRound.set(key, group);
            groupedPending.push(group);
        }
        group.items.push(item);
    }
    const rawBlocks = groupedPending.map(group => [
        `[线上轮次 · ${group.conversation.type === 'group' ? '群聊' : '单聊'}·${group.conversation.name}]`,
        ...group.items.map(({ message }) => formatPhoneMessageForAi(message)),
    ].join('\n'));
    let pendingText = rawBlocks.join('\n\n');
    if (pendingText.length > PHONE_PENDING_RAW_CHAR_TARGET) {
        const recentRaw = [];
        let recentLength = 0;
        let firstRawIndex = rawBlocks.length;
        for (let index = rawBlocks.length - 1; index >= 0; index--) {
            const blockLength = rawBlocks[index].length + 2;
            if (recentLength + blockLength > PHONE_PENDING_RAW_CHAR_TARGET * 0.68 && recentRaw.length > 0) break;
            recentRaw.unshift(rawBlocks[index]);
            recentLength += blockLength;
            firstRawIndex = index;
        }
        const olderSummaries = groupedPending.slice(0, firstRawIndex).map(group => {
            const stored = group.conversation.rounds?.find(round => round.id === group.roundId)?.summary;
            const fallback = group.items.map(({ message }) => formatPhoneMessageForAi(message)).join('；');
            return `[${group.conversation.name}] ${cleanText(stored || fallback, 1200)}`;
        });
        const recentSection = recentRaw.length > 0
            ? `【最近线上轮次原文】\n${recentRaw.join('\n\n')}`
            : '';
        const summaryBudget = Math.max(0, PHONE_PENDING_RAW_CHAR_TARGET - recentSection.length - 2);
        let summarySection = '';
        if (olderSummaries.length > 0 && summaryBudget > 0) {
            const heading = '【较早线上轮次概括】\n';
            const lineBudget = Math.max(12, Math.floor((summaryBudget - heading.length) / olderSummaries.length) - 1);
            const lines = olderSummaries.map(summary => cleanText(summary, lineBudget));
            summarySection = `${heading}${lines.join('\n')}`.slice(0, summaryBudget);
        }
        pendingText = [summarySection, recentSection].filter(Boolean).join('\n\n');
    }
    const eventText = events.map(event => formatPhoneMemoryEvent(event, store)).join('\n');
    const recentText = recentItems.map(({ conversation, message }) => (
        `[近期${conversation.type === 'group' ? '群聊' : '单聊'}·${conversation.name}] ${formatPhoneMessageForAi(message)}`
    )).join('\n');
    const header = [
        '【线上通讯与手机内容】',
        '以下只记录手机中确实出现的内容、明确操作与有逐字证据的约定或反应。',
        '“已发送／已收到／平台上存在”不等于某人已经看见、理解、赞同或产生情绪；未明确发生的状态必须保持未知。',
    ].join('\n');
    let remaining = Math.max(0, PHONE_MAIN_CONTEXT_CHAR_LIMIT - header.length - 8);
    const sections = [];
    for (const value of [pendingText, eventText, recentText]) {
        if (!value || remaining <= 0) continue;
        const part = value.slice(0, remaining);
        sections.push(part);
        remaining -= part.length + 2;
    }
    return [header, ...sections].join('\n\n');
}

export function formatPhoneContextMessage(store, limit = 12, recalledEvents = []) {
    const content = buildPhonePromptContext(store, limit, recalledEvents);
    if (!content) return null;
    const selection = getPhoneContextSelection(store, limit, recalledEvents);
    const guard = '这些内容属于正文世界已经发生的线上部分；涉及约定、承诺与冲突时应保持连续性。如与最新用户回复冲突，以最新用户回复为最高准则。不得推测任何未明确的查看状态或人物反应，也不得把模拟媒体形式误认为真实转账、定位或图片识别。';
    const boundedContent = content.slice(0, Math.max(0, PHONE_MAIN_CONTEXT_CHAR_LIMIT - guard.length - 1));
    const fullContent = `${boundedContent}\n${guard}`;
    return {
        role: 'system',
        content: fullContent,
        name: 'KKToolbox Phone Activity',
        is_user: false,
        is_system: false,
        mes: fullContent,
        extra: {
            type: 'narrator',
            [PHONE_CONTEXT_MARKER]: true,
            phone_message_ids: selection.pendingMessageIds,
            phone_event_ids: selection.pendingEventIds,
        },
    };
}

export function injectPhoneContext(chat, store, limit = 12, recalledEvents = []) {
    if (!Array.isArray(chat) || chat.some(message => message?.extra?.[PHONE_CONTEXT_MARKER])) return false;
    const message = formatPhoneContextMessage(store, limit, recalledEvents);
    if (!message) return false;
    const chatId = cleanText(store?.chatId, 500);
    if (chatId) {
        const prepared = preparedStoryInjections.get(chatId) ?? { messageIds: new Set(), eventIds: new Set() };
        for (const id of message.extra.phone_message_ids ?? []) prepared.messageIds.add(id);
        for (const id of message.extra.phone_event_ids ?? []) prepared.eventIds.add(id);
        preparedStoryInjections.set(chatId, prepared);
    }
    let insertionIndex = -1;
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        if (chat[index]?.is_user || chat[index]?.role === 'user') {
            insertionIndex = index;
            break;
        }
    }
    chat.splice(insertionIndex >= 0 ? insertionIndex : Math.max(0, chat.length - 1), 0, message);
    return true;
}

/** Marks only phone facts that were prepared for a successfully rendered main reply as consumed. */
export async function consumePreparedPhoneContext(context = globalThis.SillyTavern?.getContext?.()) {
    const chatId = getPhoneChatId(context);
    const prepared = preparedStoryInjections.get(chatId);
    if (!chatId || !prepared) return false;
    preparedStoryInjections.delete(chatId);
    const store = await loadPhoneStore(context);
    let changed = false;
    for (const conversation of store.conversations) {
        for (const message of conversation.messages) {
            if (!prepared.messageIds.has(message.id) || message.storyPending !== true) continue;
            message.storyPending = false;
            changed = true;
        }
    }
    const consumedAt = Date.now();
    for (const event of store.onlineMemory?.events ?? []) {
        if (!prepared.eventIds.has(event.id) || event.pending !== true) continue;
        event.pending = false;
        event.consumedAt = consumedAt;
        changed = true;
    }
    if (changed) await savePhoneStore(store, context);
    return changed;
}

export function clearPreparedPhoneContext(chatId) {
    return preparedStoryInjections.delete(cleanText(chatId, 500));
}
