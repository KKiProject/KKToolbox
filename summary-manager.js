export const SUMMARY_KEY_PREFIX = '[KKT摘要]';
export const SUMMARY_STATE_KEY = 'kktoolbox_summary_state';

const LEGACY_SUMMARY_METADATA_KEY = 'memory_augment_summaries';
const LEGACY_SUMMARY_KEY_PREFIX = '[KKToolbox摘要]';
const CHAT_LOREBOOK_METADATA_KEY = 'world_info';
let summaryQueue = Promise.resolve();

function clampInteger(value, fallback, minimum, maximum) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function getChatId(context) {
    return context?.getCurrentChatId?.() ?? context?.chatId;
}

function getSummaryState(metadata, create = false) {
    if (!metadata || typeof metadata !== 'object') {
        return null;
    }
    if (!metadata[SUMMARY_STATE_KEY] && create) {
        metadata[SUMMARY_STATE_KEY] = {
            aiRepliesSinceLastSummary: 0,
            lastSummarizedMessageIndex: -1,
            lastCountedReplySignature: '',
            entries: [],
        };
    }
    const state = metadata[SUMMARY_STATE_KEY];
    if (!state || typeof state !== 'object') {
        return null;
    }
    state.aiRepliesSinceLastSummary = Math.max(0, Math.trunc(Number(state.aiRepliesSinceLastSummary) || 0));
    const lastSummarized = Number(state.lastSummarizedMessageIndex);
    state.lastSummarizedMessageIndex = Number.isFinite(lastSummarized) ? Math.trunc(lastSummarized) : -1;
    state.lastCountedReplySignature = String(state.lastCountedReplySignature ?? '');
    state.entries = Array.isArray(state.entries) ? state.entries : [];
    return state;
}

function quoteSlashValue(value) {
    return `"${String(value ?? '').replace(/([\\"{}|])/g, '\\$1')}"`;
}

async function runSlash(context, command) {
    if (typeof context?.executeSlashCommands !== 'function') {
        throw new Error('executeSlashCommands is unavailable.');
    }
    return context.executeSlashCommands(command);
}

function getPipe(result) {
    return String(result?.pipe ?? '').trim();
}

async function getChatBookName(context, create = false) {
    if (!create) {
        return String(context?.chatMetadata?.[CHAT_LOREBOOK_METADATA_KEY] ?? '').trim();
    }
    const name = getPipe(await runSlash(context, '/getchatbook'));
    if (!name) {
        throw new Error('ST 未返回当前聊天的世界书名称。');
    }
    return name;
}

function getSummaryKey(start, end) {
    return `${SUMMARY_KEY_PREFIX}第${start}-${end}楼`;
}

function getRangeFromKey(key) {
    const match = String(key ?? '').match(/第\s*(\d+)\s*-\s*(\d+)\s*楼/);
    return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}

function isManagedSummaryEntry(entry) {
    const keys = Array.isArray(entry?.key) ? entry.key : [entry?.key];
    return keys.some(key => String(key ?? '').startsWith(SUMMARY_KEY_PREFIX)
        || String(key ?? '').startsWith(LEGACY_SUMMARY_KEY_PREFIX));
}

async function findSummaryEntry(context, bookName, key) {
    const command = `/findentry file=${quoteSlashValue(bookName)} field=key ${quoteSlashValue(key)}`;
    return getPipe(await runSlash(context, command));
}

async function setEntryField(context, bookName, uid, field, value) {
    const command = `/setentryfield file=${quoteSlashValue(bookName)} uid=${quoteSlashValue(uid)} field=${field} ${quoteSlashValue(value)}`;
    await runSlash(context, command);
}

async function upsertSummaryEntry(context, record) {
    const bookName = await getChatBookName(context, true);
    const key = getSummaryKey(record.start, record.end);
    let uid = await findSummaryEntry(context, bookName, key);

    if (uid) {
        await setEntryField(context, bookName, uid, 'content', record.summary);
    } else {
        const command = `/createentry file=${quoteSlashValue(bookName)} key=${quoteSlashValue(key)} ${quoteSlashValue(record.summary)}`;
        uid = getPipe(await runSlash(context, command));
        if (!uid) {
            throw new Error(`创建摘要世界书条目失败：${key}`);
        }
    }

    await setEntryField(context, bookName, uid, 'constant', true);
    await setEntryField(context, bookName, uid, 'position', 0);
    await setEntryField(context, bookName, uid, 'order', 100);
    await setEntryField(context, bookName, uid, 'disable', false);
    return { ...record, uid: String(uid), key, bookName };
}

function formatDialogue(messages, start) {
    return messages.map((message, offset) => {
        const index = start + offset;
        const speaker = String(message?.name ?? (message?.is_user ? '用户' : '角色')).trim();
        const text = String(message?.mes ?? '').trim();
        return `[第 ${index} 楼] ${speaker}: ${text}`;
    }).join('\n');
}

export function buildSummaryPrompt(messages, start, end, maxTokens) {
    return [
        '请将以下自上次摘要以来的全部对话压缩为简要摘要，保留关键事件、人物状态变化和重要细节。',
        `摘要应客观、按时间顺序，控制在约 ${maxTokens} tokens 以内，不要续写剧情。`,
        `对话范围：第 ${start}-${end} 楼。`,
        '',
        formatDialogue(messages, start),
    ].join('\n');
}

async function callSummaryModel(context, prompt, maxTokens, generateSummary) {
    if (generateSummary) {
        return generateSummary(prompt, maxTokens);
    }
    if (typeof context.generateQuietPrompt !== 'function') {
        throw new Error('generateQuietPrompt is unavailable.');
    }
    return context.generateQuietPrompt(prompt, false, true, '', '', maxTokens);
}

function getMessageIndex(context, messageId) {
    const numericId = Number(messageId);
    if (Number.isInteger(numericId) && numericId >= 0 && numericId < context.chat.length) {
        return numericId;
    }
    return context.chat.length - 1;
}

function isAiReply(message, type) {
    return type !== 'first_message'
        && message
        && message.is_user !== true
        && message.is_system !== true
        && message?.extra?.type !== 'narrator';
}

function getReplySignature(message, index) {
    return `${index}:${String(message?.send_date ?? '')}:${String(message?.mes ?? '')}`;
}

export async function recordAiReply(context, messageId, type) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    if (!context?.chatMetadata || chat.length === 0) {
        return { counted: false, count: 0 };
    }
    const index = getMessageIndex(context, messageId);
    const message = chat[index];
    if (!isAiReply(message, type)) {
        return { counted: false, count: getSummaryState(context.chatMetadata)?.aiRepliesSinceLastSummary ?? 0 };
    }

    const state = getSummaryState(context.chatMetadata, true);
    const signature = getReplySignature(message, index);
    if (state.lastCountedReplySignature === signature) {
        return { counted: false, count: state.aiRepliesSinceLastSummary, duplicate: true };
    }
    state.lastCountedReplySignature = signature;
    state.aiRepliesSinceLastSummary++;
    await context.saveMetadata?.();
    return { counted: true, count: state.aiRepliesSinceLastSummary, messageIndex: index };
}

export async function getSummaries(context) {
    const state = getSummaryState(context?.chatMetadata);
    const bookName = await getChatBookName(context, false);
    if (!state || !bookName) {
        return [];
    }

    const summaries = [];
    for (const entry of state.entries) {
        if (!entry?.uid) {
            continue;
        }
        const command = `/getentryfield file=${quoteSlashValue(bookName)} field=content ${quoteSlashValue(entry.uid)}`;
        const summary = getPipe(await runSlash(context, command));
        if (summary) {
            summaries.push({
                start: Number(entry.start),
                end: Number(entry.end),
                summary,
                createdAt: String(entry.createdAt ?? ''),
                uid: String(entry.uid),
            });
        }
    }
    return summaries.sort((left, right) => left.start - right.start);
}

export async function getSummaryStatus(context) {
    const state = getSummaryState(context?.chatMetadata);
    const bookName = await getChatBookName(context, false);
    let entryCount = state?.entries.length ?? 0;

    if (bookName && typeof context?.loadWorldInfo === 'function') {
        const data = await context.loadWorldInfo(bookName);
        entryCount = Object.values(data?.entries ?? {}).filter(isManagedSummaryEntry).length;
    }
    const lastSummaryAt = state?.entries.map(item => item.createdAt).filter(Boolean).sort().at(-1) ?? null;
    return {
        entryCount,
        summaryCount: state?.entries.length ?? 0,
        pendingAiReplies: state?.aiRepliesSinceLastSummary ?? 0,
        lastSummaryAt,
    };
}

export async function clearAllSummaries(context) {
    const bookName = await getChatBookName(context, false);
    let removed = 0;

    // This ST build exposes no delete-entry STscript command. Use the official
    // getContext world-info methods only for the required bulk deletion.
    if (bookName) {
        if (typeof context?.loadWorldInfo !== 'function' || typeof context?.saveWorldInfo !== 'function') {
            throw new Error('当前 ST 版本没有可用的世界书条目删除 API。');
        }
        const data = await context.loadWorldInfo(bookName);
        for (const [uid, entry] of Object.entries(data?.entries ?? {})) {
            if (isManagedSummaryEntry(entry)) {
                delete data.entries[uid];
                removed++;
            }
        }
        if (removed > 0) {
            await context.saveWorldInfo(bookName, data, true);
        }
    }

    const state = getSummaryState(context?.chatMetadata, true);
    state.aiRepliesSinceLastSummary = 0;
    state.lastSummarizedMessageIndex = -1;
    state.lastCountedReplySignature = '';
    state.entries = [];
    await context.saveMetadata?.();
    return removed;
}

async function migrateLegacyLorebookEntries(context, state) {
    const bookName = await getChatBookName(context, false);
    if (!bookName || typeof context?.loadWorldInfo !== 'function') {
        return 0;
    }
    const data = await context.loadWorldInfo(bookName);
    let migrated = 0;
    for (const entry of Object.values(data?.entries ?? {})) {
        const oldKey = (Array.isArray(entry?.key) ? entry.key : [])
            .find(key => String(key).startsWith(LEGACY_SUMMARY_KEY_PREFIX));
        if (!oldKey) {
            continue;
        }
        const range = getRangeFromKey(oldKey) ?? (() => {
            const match = String(oldKey).match(/(\d+)\s*-\s*(\d+)/);
            return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
        })();
        if (!range) {
            continue;
        }
        const key = getSummaryKey(range.start, range.end);
        await setEntryField(context, bookName, entry.uid, 'key', key);
        if (!state.entries.some(item => String(item.uid) === String(entry.uid))) {
            state.entries.push({ ...range, uid: String(entry.uid), key, bookName, createdAt: '' });
        }
        state.lastSummarizedMessageIndex = Math.max(state.lastSummarizedMessageIndex, range.end);
        migrated++;
    }
    return migrated;
}

export async function migrateLegacySummaries(context) {
    const metadata = context?.chatMetadata;
    if (!metadata) {
        return 0;
    }
    const state = getSummaryState(metadata, true);
    let migrated = await migrateLegacyLorebookEntries(context, state);
    const legacyStore = metadata[LEGACY_SUMMARY_METADATA_KEY];

    if (legacyStore && typeof legacyStore === 'object' && !Array.isArray(legacyStore)) {
        const records = Object.values(legacyStore)
            .filter(item => Number.isInteger(Number(item?.start))
                && Number.isInteger(Number(item?.end))
                && String(item?.summary ?? '').trim())
            .map(item => ({
                start: Number(item.start),
                end: Number(item.end),
                summary: String(item.summary).trim(),
                createdAt: String(item.createdAt ?? new Date().toISOString()),
            }))
            .sort((left, right) => left.start - right.start);
        for (const record of records) {
            const saved = await upsertSummaryEntry(context, record);
            if (!state.entries.some(item => item.start === saved.start && item.end === saved.end)) {
                state.entries.push(saved);
            }
            state.lastSummarizedMessageIndex = Math.max(state.lastSummarizedMessageIndex, record.end);
            migrated++;
        }
        delete metadata[LEGACY_SUMMARY_METADATA_KEY];
    }
    if (migrated > 0 || !metadata[SUMMARY_STATE_KEY]) {
        await context.saveMetadata?.();
    }
    return migrated;
}

export async function summarizePendingMessages(settings, context, options = {}) {
    const interval = clampInteger(settings?.context?.summaryInterval, 5, 1, 50);
    const maxTokens = clampInteger(settings?.context?.summaryMaxTokens, 500, 50, 4000);
    const chatId = getChatId(context);
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const metadata = context?.chatMetadata;
    if (!chatId || !metadata || chat.length === 0) {
        return { created: 0, pendingReplies: 0 };
    }

    await migrateLegacySummaries(context);
    const state = getSummaryState(metadata, true);
    if (state.aiRepliesSinceLastSummary < interval) {
        return { created: 0, pendingReplies: state.aiRepliesSinceLastSummary };
    }

    const requestedEnd = Number(options.endMessageIndex);
    const end = Number.isInteger(requestedEnd)
        ? Math.min(chat.length - 1, Math.max(0, requestedEnd))
        : chat.length - 1;
    const start = Math.min(end, Math.max(0, state.lastSummarizedMessageIndex + 1));
    const messages = chat.slice(start, end + 1).map(message => ({
        name: message?.name,
        is_user: message?.is_user,
        mes: message?.mes,
    }));
    const prompt = buildSummaryPrompt(messages, start, end, maxTokens);
    const summary = String(await callSummaryModel(context, prompt, maxTokens, options.generateSummary) ?? '').trim();
    if (!summary) {
        throw new Error(`Summary model returned empty content for messages ${start}-${end}.`);
    }

    const currentContext = options.getCurrentContext?.() ?? context;
    if (getChatId(currentContext) !== chatId || currentContext.chatMetadata !== metadata) {
        return { created: 0, pendingReplies: state.aiRepliesSinceLastSummary, discarded: true };
    }

    const record = { start, end, summary, createdAt: new Date().toISOString() };
    const saved = await upsertSummaryEntry(currentContext, record);
    state.entries = state.entries.filter(item => !(item.start === start && item.end === end));
    state.entries.push(saved);
    state.lastSummarizedMessageIndex = end;
    state.aiRepliesSinceLastSummary = 0;
    await currentContext.saveMetadata?.();
    options.onSaved?.(saved);
    return { created: 1, pendingReplies: 0, start, end };
}

export function initializeSummaryManager(settings, context, options = {}) {
    const messageReceived = context.eventTypes?.MESSAGE_RECEIVED ?? context.event_types?.MESSAGE_RECEIVED;
    const messageRendered = context.eventTypes?.CHARACTER_MESSAGE_RENDERED
        ?? context.event_types?.CHARACTER_MESSAGE_RENDERED;
    const chatChanged = context.eventTypes?.CHAT_CHANGED ?? context.event_types?.CHAT_CHANGED;
    if (!messageReceived) {
        console.error('[Memory Augment] MESSAGE_RECEIVED event is unavailable for summaries.');
        return;
    }

    let pendingReply = null;
    const enqueueReply = ({ chatId, messageId, type }) => {
        summaryQueue = summaryQueue
            .catch(() => undefined)
            .then(async () => {
                const currentContext = SillyTavern.getContext();
                if (!chatId || getChatId(currentContext) !== chatId) {
                    return null;
                }
                const counted = await recordAiReply(currentContext, messageId, type);
                if (!counted.counted) {
                    return counted;
                }
                return summarizePendingMessages(settings, currentContext, {
                    endMessageIndex: counted.messageIndex,
                    getCurrentContext: () => SillyTavern.getContext(),
                    onSaved: options.onSaved,
                });
            })
            .catch(error => console.error('[Memory Augment] Automatic summary generation failed.', error));
    };

    void migrateLegacySummaries(context).then(options.onSaved).catch(error => {
        console.error('[Memory Augment] Legacy summary migration failed.', error);
    });

    context.eventSource.on(messageReceived, (messageId, type) => {
        const eventContext = SillyTavern.getContext();
        pendingReply = { chatId: getChatId(eventContext), messageId, type };
        if (!messageRendered) {
            enqueueReply(pendingReply);
            pendingReply = null;
        }
    });

    if (messageRendered) {
        context.eventSource.on(messageRendered, (messageId, type) => {
            const currentChatId = getChatId(SillyTavern.getContext());
            if (pendingReply?.chatId === currentChatId
                && String(pendingReply.messageId) === String(messageId)
                && pendingReply.type === type) {
                enqueueReply(pendingReply);
            }
            pendingReply = null;
        });
    }

    if (chatChanged) {
        context.eventSource.on(chatChanged, () => {
            pendingReply = null;
            const currentContext = SillyTavern.getContext();
            void migrateLegacySummaries(currentContext).then(options.onSaved).catch(error => {
                console.error('[Memory Augment] Legacy summary migration failed.', error);
            });
        });
    }
}
