export const SUMMARY_KEY_PREFIX = '[KKT摘要]';
export const SUMMARY_STATE_KEY = 'kktoolbox_summary_state';

const LEGACY_SUMMARY_METADATA_KEY = 'memory_augment_summaries';
const LEGACY_SUMMARY_KEY_PREFIX = '[KKToolbox摘要]';
const SUMMARY_GENERATION_MAX_TOKENS = 1200;
const SUMMARY_BOOK_SUFFIX = '-自动总结';
const SUMMARY_ENTRY_DEPTH = 4;
const WORLD_INFO_POSITION_AT_DEPTH = 4;
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
            lastSummarizedMessageIndex: -1,
            entries: [],
        };
    }
    const state = metadata[SUMMARY_STATE_KEY];
    if (!state || typeof state !== 'object') {
        return null;
    }
    const lastSummarized = Number(state.lastSummarizedMessageIndex);
    state.lastSummarizedMessageIndex = Number.isFinite(lastSummarized) ? Math.trunc(lastSummarized) : -1;
    state.entries = Array.isArray(state.entries) ? state.entries : [];
    delete state.aiRepliesSinceLastSummary;
    delete state.lastCountedReplySignature;
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

function getCurrentCharacter(context) {
    const characterId = Number(context?.characterId);
    const character = Number.isInteger(characterId) ? context?.characters?.[characterId] : null;
    const name = String(character?.name ?? character?.data?.name ?? '').trim();
    return character && name ? { character, name } : null;
}

function getCharacterFileName(character) {
    return String(character?.avatar ?? '').trim().replace(/\.[^/.]+$/, '');
}

async function createSummaryBook(context, bookName) {
    if (typeof context?.createNewWorldInfo === 'function') {
        await context.createNewWorldInfo(bookName);
        return;
    }
    const worldModule = await import('../../../world-info.js');
    const created = await worldModule.createNewWorldInfo(bookName);
    if (!created) {
        throw new Error(`创建摘要世界书失败：${bookName}`);
    }
}

async function bindSummaryBookToCharacter(context, character, bookName) {
    if (typeof context?.bindAdditionalWorldInfoBook === 'function') {
        await context.bindAdditionalWorldInfoBook(bookName);
        return;
    }
    const fileName = getCharacterFileName(character);
    if (!fileName) {
        throw new Error('当前角色缺少头像文件名，无法绑定辅助世界书。');
    }
    const worldModule = await import('../../../world-info.js');
    const charLore = Array.isArray(worldModule.world_info?.charLore)
        ? worldModule.world_info.charLore
        : [];
    let binding = charLore.find(item => item?.name === fileName);
    if (binding?.extraBooks?.includes(bookName)) {
        return;
    }
    if (!binding) {
        binding = { name: fileName, extraBooks: [] };
        charLore.push(binding);
    }
    binding.extraBooks = Array.isArray(binding.extraBooks) ? binding.extraBooks : [];
    binding.extraBooks.push(bookName);
    Object.assign(worldModule.world_info, { charLore });
    context.saveSettingsDebounced?.();
}

async function getSummaryBookName(context, create = false) {
    const current = getCurrentCharacter(context);
    if (!current) {
        if (create) throw new Error('当前没有可用于创建摘要世界书的角色。');
        return '';
    }
    const bookName = `${current.name}${SUMMARY_BOOK_SUFFIX}`;
    if (create) {
        const existing = typeof context?.loadWorldInfo === 'function'
            ? await context.loadWorldInfo(bookName)
            : null;
        if (!existing) {
            await createSummaryBook(context, bookName);
        }
        await bindSummaryBookToCharacter(context, current.character, bookName);
    }
    return bookName;
}

function getImportanceStars(importance) {
    const value = clampInteger(importance, 1, 1, 5);
    return `${'★'.repeat(value)}${'☆'.repeat(5 - value)}`;
}

function getSummaryKey(start, end) {
    return `${SUMMARY_KEY_PREFIX}[第${start + 1}-${end + 1}楼]`;
}

function getLegacySummaryKey(start, end) {
    return `${SUMMARY_KEY_PREFIX}第${start}-${end}楼`;
}

function getRangeFromKey(key) {
    const match = String(key ?? '').match(/第\s*(\d+)\s*-\s*(\d+)\s*楼/);
    return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}

function getImportanceFromKey(key) {
    const stars = String(key ?? '').match(/\[([★☆]{5})\]/)?.[1];
    return stars ? Math.max(1, (stars.match(/★/g) ?? []).length) : 1;
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

async function configureSummaryEntry(context, bookName, uid) {
    await setEntryField(context, bookName, uid, 'constant', true);
    await setEntryField(context, bookName, uid, 'position', WORLD_INFO_POSITION_AT_DEPTH);
    await setEntryField(context, bookName, uid, 'depth', SUMMARY_ENTRY_DEPTH);
    await setEntryField(context, bookName, uid, 'order', 100);
    await setEntryField(context, bookName, uid, 'disable', false);
}

function hasMatchingRange(key, start, end) {
    const range = getRangeFromKey(key);
    if (!range) {
        return false;
    }
    // Before batch entries were introduced, keys used zero-based floor numbers.
    // Accept both forms so the first write with the new format replaces old entries.
    return (range.start === start + 1 && range.end === end + 1)
        || (range.start === start && range.end === end);
}

async function upsertSummaryEntry(context, events, start, end, createdAt) {
    const bookName = await getSummaryBookName(context, true);
    const key = getSummaryKey(start, end);
    const content = formatSummaryContent(events);
    const data = typeof context?.loadWorldInfo === 'function'
        ? await context.loadWorldInfo(bookName)
        : null;
    const matches = Object.entries(data?.entries ?? {}).filter(([, entry]) => {
        const keys = Array.isArray(entry?.key) ? entry.key : [entry?.key];
        return isManagedSummaryEntry(entry) && keys.some(value => hasMatchingRange(value, start, end));
    });

    if (matches.length > 0 && typeof context?.saveWorldInfo === 'function') {
        const [keptUid, keptEntry] = matches[0];
        keptEntry.key = [key];
        keptEntry.content = content;
        keptEntry.constant = true;
        keptEntry.position = WORLD_INFO_POSITION_AT_DEPTH;
        keptEntry.depth = SUMMARY_ENTRY_DEPTH;
        keptEntry.order = 100;
        keptEntry.disable = false;
        for (const [duplicateUid] of matches.slice(1)) {
            delete data.entries[duplicateUid];
        }
        await context.saveWorldInfo(bookName, data, true);
        return {
            start,
            end,
            uid: String(keptEntry.uid ?? keptUid),
            key,
            bookName,
            createdAt,
        };
    }

    const command = `/createentry file=${quoteSlashValue(bookName)} key=${quoteSlashValue(key)} ${quoteSlashValue(content)}`;
    const uid = getPipe(await runSlash(context, command));
    if (!uid) {
        throw new Error(`创建摘要世界书条目失败：${key}`);
    }
    await configureSummaryEntry(context, bookName, uid);
    return {
        start,
        end,
        uid: String(uid),
        key,
        bookName,
        createdAt,
    };
}

async function upsertLegacySummaryEntry(context, record) {
    const bookName = await getSummaryBookName(context, true);
    const key = getLegacySummaryKey(record.start, record.end);
    let uid = await findSummaryEntry(context, bookName, key);
    if (uid) {
        await setEntryField(context, bookName, uid, 'content', record.summary);
    } else {
        const command = `/createentry file=${quoteSlashValue(bookName)} key=${quoteSlashValue(key)} ${quoteSlashValue(record.summary)}`;
        uid = getPipe(await runSlash(context, command));
        if (!uid) {
            throw new Error(`迁移旧摘要世界书条目失败：${key}`);
        }
    }
    await configureSummaryEntry(context, bookName, uid);
    return { ...record, uid: String(uid), key, bookName };
}

function limitText(value, maximum) {
    return Array.from(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, maximum).join('');
}

function getField(block, label, nextLabels = []) {
    const ending = nextLabels.length > 0 ? `(?=\\n(?:${nextLabels.join('|')})\\s*[：:]|$)` : '$';
    const match = block.match(new RegExp(`${label}\\s*[：:]\\s*([\\s\\S]*?)${ending}`, 'm'));
    return String(match?.[1] ?? '').trim();
}

export function parseSummaryEvents(output) {
    const text = String(output ?? '').trim();
    const headers = [...text.matchAll(/\[事件\s*\d+\]/g)];
    const blocks = headers.slice(0, 3).map((header, index) => {
        const start = header.index + header[0].length;
        const end = headers[index + 1]?.index ?? text.length;
        return text.slice(start, end).trim();
    });
    const events = blocks.map((block) => {
        const importanceText = getField(block, '重要度', ['时间', '涉及角色', '地点', '事件概述']);
        const time = getField(block, '时间', ['涉及角色', '地点', '事件概述']);
        const characters = getField(block, '涉及角色', ['地点', '事件概述']);
        const location = getField(block, '地点', ['事件概述']);
        const overview = getField(block, '事件概述');
        if (!overview) {
            return null;
        }
        return {
            importance: clampInteger(importanceText.match(/[1-5]/)?.[0], 1, 1, 5),
            time: limitText(time, 80) || '未明确',
            characters: limitText(characters, 100) || '未明确',
            location: limitText(location, 100) || '未明确',
            overview: limitText(overview, 150),
        };
    }).filter(Boolean);

    if (events.length > 0) {
        return events;
    }
    const fallback = limitText(text, 150);
    return fallback ? [{
        importance: 1,
        time: '未明确',
        characters: '未明确',
        location: '未明确',
        overview: fallback,
    }] : [];
}

export function formatEventContent(event) {
    return [
        `[${getImportanceStars(event.importance)}]`,
        `⏰ ${event.time}`,
        ` ${event.characters}`,
        ` ${event.location}`,
        ` ${event.overview}`,
    ].join('\n');
}

export function formatSummaryContent(events) {
    return [...events]
        .sort((left, right) => right.importance - left.importance)
        .slice(0, 3)
        .map(formatEventContent)
        .join('\n\n');
}

function formatLegacyEventEntry(entry, key) {
    const content = String(entry?.content ?? '').trim();
    if (/^\[[★☆]{5}\]/.test(content)) {
        return content;
    }
    const normalized = content
        .replace(/^涉及角色[：:]\s*/m, ' ')
        .replace(/^地点[：:]\s*/m, ' ')
        .replace(/^事件[：:]\s*/m, ' ');
    return `[${getImportanceStars(getImportanceFromKey(key))}]\n${normalized}`;
}

function formatDialogue(messages, start) {
    return messages.map((message, offset) => {
        const index = start + offset + 1;
        const speaker = String(message?.name ?? (message?.is_user ? '用户' : '角色')).trim();
        const text = String(message?.mes ?? '').trim();
        return `[第 ${index} 楼] ${speaker}: ${text}`;
    }).join('\n');
}

export function buildSummaryPrompt(messages, start, end) {
    return [
        `将以下${end - start + 1}楼的内容提取为1-3个关键事件，按重要度从高到低排列。每个事件严格按以下格式输出，不要输出其他内容：`,
        '',
        '[事件1]',
        '重要度：X（1-5，5为最重要）',
        '时间：（从对话上下文推断的故事内时间点）',
        '涉及角色：（角色名，逗号分隔）',
        '地点：（事件发生的地点）',
        '事件概述：（最多150字，抓取核心骨干和重要细节，忽略氛围描写和无关对话）',
        '',
        '[事件2]',
        '...',
        '',
        '评判标准：',
        '- 有矛盾冲突、清晰脉络、角色关系变化、重大决策的事件 = 高重要度',
        '- 纯日常流水账、寒暄、无实质进展 = 低重要度',
        '- 如果这段对话全是日常闲聊没有值得记录的事件，只输出一个1星事件简单概括即可',
        '',
        `以下是需要分析的对话（第${start + 1}-${end + 1}楼）：`,
        '',
        formatDialogue(messages, start),
    ].join('\n');
}

async function callSummaryModel(context, prompt, generateSummary) {
    if (generateSummary) {
        return generateSummary(prompt, SUMMARY_GENERATION_MAX_TOKENS);
    }
    if (typeof context.generateQuietPrompt !== 'function') {
        throw new Error('generateQuietPrompt is unavailable.');
    }
    return context.generateQuietPrompt(prompt, false, true, '', '', SUMMARY_GENERATION_MAX_TOKENS);
}

async function hideSummarizedMessages(context, start, end, recentMessages, getCurrentContext) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const recentCount = clampInteger(recentMessages, 20, 1, 1000);
    const firstRetainedIndex = Math.max(0, chat.length - recentCount);
    const lastHideableIndex = Math.min(end, firstRetainedIndex - 1);
    const expectedChatId = getChatId(context);

    for (let index = start; index <= lastHideableIndex; index++) {
        if (chat[index]?.is_system === true) {
            continue;
        }
        const current = getCurrentContext?.() ?? context;
        if (getChatId(current) !== expectedChatId || current.chatMetadata !== context.chatMetadata) {
            return;
        }
        await runSlash(current, `/hide ${index}`);
    }
}

export async function getSummaries(context) {
    const state = getSummaryState(context?.chatMetadata);
    const bookName = await getSummaryBookName(context, false);
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
    const bookName = await getSummaryBookName(context, false);
    let entryCount = state?.entries.length ?? 0;

    if (bookName && typeof context?.loadWorldInfo === 'function') {
        const data = await context.loadWorldInfo(bookName);
        entryCount = Object.values(data?.entries ?? {}).filter(isManagedSummaryEntry).length;
    }
    const lastSummaryAt = state?.entries.map(item => item.createdAt).filter(Boolean).sort().at(-1) ?? null;
    return {
        entryCount,
        summaryCount: state?.entries.length ?? 0,
        lastSummaryAt,
    };
}

export async function clearAllSummaries(context) {
    const bookName = await getSummaryBookName(context, false);
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
    state.lastSummarizedMessageIndex = -1;
    state.entries = [];
    await context.saveMetadata?.();
    return removed;
}

async function migrateLegacyLorebookEntries(context, state) {
    const bookName = await getSummaryBookName(context, false);
    if (!bookName || typeof context?.loadWorldInfo !== 'function') {
        return 0;
    }
    const data = await context.loadWorldInfo(bookName);
    let migrated = 0;
    let worldInfoChanged = false;
    const entries = Object.entries(data?.entries ?? {});
    const oldEventGroups = new Map();
    const consolidatedUids = new Set();
    for (const [uid, entry] of entries) {
        const key = (Array.isArray(entry?.key) ? entry.key : [])
            .find(value => String(value).startsWith(SUMMARY_KEY_PREFIX) && /\[[★☆]{5}\]/.test(String(value)));
        const range = getRangeFromKey(key);
        if (!key || !range) continue;
        const groupKey = `${range.start}-${range.end}`;
        oldEventGroups.set(groupKey, [...(oldEventGroups.get(groupKey) ?? []), { uid, entry, key, range }]);
    }
    for (const group of oldEventGroups.values()) {
        const sortedGroup = [...group]
            .sort((left, right) => getImportanceFromKey(right.key) - getImportanceFromKey(left.key));
        const [{ entry: keptEntry, range }] = sortedGroup;
        keptEntry.key = [getSummaryKey(range.start, range.end)];
        keptEntry.content = sortedGroup
            .map(item => formatLegacyEventEntry(item.entry, item.key))
            .join('\n\n');
        keptEntry.constant = true;
        keptEntry.position = WORLD_INFO_POSITION_AT_DEPTH;
        keptEntry.depth = SUMMARY_ENTRY_DEPTH;
        keptEntry.order = 100;
        keptEntry.disable = false;
        for (const item of sortedGroup) {
            consolidatedUids.add(String(item.entry.uid ?? item.uid));
        }
        for (const duplicate of sortedGroup.slice(1)) {
            delete data.entries[duplicate.uid];
        }
        worldInfoChanged = true;
        migrated += group.length;
    }
    if (consolidatedUids.size > 0) {
        state.entries = state.entries.filter(item => !consolidatedUids.has(String(item.uid)));
    }
    if (worldInfoChanged && typeof context?.saveWorldInfo === 'function') {
        await context.saveWorldInfo(bookName, data, true);
    }

    for (const entry of Object.values(data?.entries ?? {})) {
        const managedKey = (Array.isArray(entry?.key) ? entry.key : [])
            .find(key => String(key).startsWith(SUMMARY_KEY_PREFIX)
                || String(key).startsWith(LEGACY_SUMMARY_KEY_PREFIX));
        if (!managedKey) {
            continue;
        }
        let range = getRangeFromKey(managedKey) ?? (() => {
            const match = String(managedKey).match(/(\d+)\s*-\s*(\d+)/);
            return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
        })();
        if (!range) {
            continue;
        }
        if (String(managedKey).startsWith(`${SUMMARY_KEY_PREFIX}[第`)) {
            range = { start: Math.max(0, range.start - 1), end: Math.max(0, range.end - 1) };
        }
        let key = String(managedKey);
        if (key.startsWith(LEGACY_SUMMARY_KEY_PREFIX)) {
            key = getLegacySummaryKey(range.start, range.end);
            await setEntryField(context, bookName, entry.uid, 'key', key);
            migrated++;
        }
        if (!state.entries.some(item => String(item.uid) === String(entry.uid))) {
            state.entries.push({ ...range, uid: String(entry.uid), key, bookName, createdAt: '' });
            migrated++;
        }
        state.lastSummarizedMessageIndex = Math.max(state.lastSummarizedMessageIndex, range.end);
    }
    return migrated;
}

export async function migrateLegacySummaries(context) {
    const metadata = context?.chatMetadata;
    if (!metadata) {
        return 0;
    }
    const hadLegacyCounters = Boolean(metadata[SUMMARY_STATE_KEY]
        && (Object.hasOwn(metadata[SUMMARY_STATE_KEY], 'aiRepliesSinceLastSummary')
            || Object.hasOwn(metadata[SUMMARY_STATE_KEY], 'lastCountedReplySignature')));
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
            const saved = await upsertLegacySummaryEntry(context, record);
            if (!state.entries.some(item => item.start === saved.start && item.end === saved.end)) {
                state.entries.push(saved);
            }
            state.lastSummarizedMessageIndex = Math.max(state.lastSummarizedMessageIndex, record.end);
            migrated++;
        }
        delete metadata[LEGACY_SUMMARY_METADATA_KEY];
    }
    if (migrated > 0 || hadLegacyCounters) {
        await context.saveMetadata?.();
    }
    return migrated;
}

export async function summarizePendingMessages(settings, context, options = {}) {
    const recentMessages = clampInteger(settings?.context?.recentMessages, 20, 1, 1000);
    const batchSize = clampInteger(settings?.context?.summaryBatchSize, 10, 1, 50);
    const chatId = getChatId(context);
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const metadata = context?.chatMetadata;
    if (!chatId || !metadata || chat.length === 0) {
        return { created: 0, pendingFloors: 0 };
    }

    await migrateLegacySummaries(context);
    const state = getSummaryState(metadata, true);
    const start = Math.max(0, state.lastSummarizedMessageIndex + 1);
    const firstIndexInsideRecentWindow = Math.max(0, chat.length - recentMessages);
    const pendingFloors = Math.max(0, firstIndexInsideRecentWindow - start);
    if (pendingFloors < batchSize) {
        return { created: 0, pendingFloors };
    }

    const end = start + batchSize - 1;
    const messages = chat.slice(start, end + 1).map(message => ({
        name: message?.name,
        is_user: message?.is_user,
        mes: message?.mes,
    }));
    const prompt = buildSummaryPrompt(messages, start, end);
    const output = String(await callSummaryModel(context, prompt, options.generateSummary) ?? '').trim();
    if (!output) {
        throw new Error(`Summary model returned empty content for messages ${start}-${end}.`);
    }
    const events = parseSummaryEvents(output);
    if (events.length === 0) {
        throw new Error(`Summary model returned no usable events for messages ${start}-${end}.`);
    }

    const currentContext = options.getCurrentContext?.() ?? context;
    if (getChatId(currentContext) !== chatId || currentContext.chatMetadata !== metadata) {
        return { created: 0, pendingFloors, discarded: true };
    }

    const createdAt = new Date().toISOString();
    const saved = await upsertSummaryEntry(currentContext, events, start, end, createdAt);
    state.entries = state.entries.filter(entry => entry.start !== start || entry.end !== end);
    state.entries.push(saved);
    state.lastSummarizedMessageIndex = end;
    await currentContext.saveMetadata?.();
    await hideSummarizedMessages(
        currentContext,
        start,
        end,
        settings?.context?.recentMessages,
        options.getCurrentContext,
    );
    options.onSaved?.(saved);
    return { created: 1, pendingFloors: pendingFloors - batchSize, start, end };
}

export function initializeSummaryManager(settings, context, options = {}) {
    const messageSent = context.eventTypes?.MESSAGE_SENT ?? context.event_types?.MESSAGE_SENT;
    const chatChanged = context.eventTypes?.CHAT_CHANGED ?? context.event_types?.CHAT_CHANGED;
    if (!messageSent) {
        console.error('[Memory Augment] MESSAGE_SENT event is unavailable for summaries.');
        return;
    }

    const enqueueSummaryCheck = (chatId) => {
        summaryQueue = summaryQueue
            .catch(() => undefined)
            .then(async () => {
                const currentContext = SillyTavern.getContext();
                if (!chatId || getChatId(currentContext) !== chatId) {
                    return null;
                }
                return summarizePendingMessages(settings, currentContext, {
                    getCurrentContext: () => SillyTavern.getContext(),
                    onSaved: options.onSaved,
                });
            })
            .catch(error => console.error('[Memory Augment] Automatic summary generation failed.', error));
    };

    void migrateLegacySummaries(context).then(options.onSaved).catch(error => {
        console.error('[Memory Augment] Legacy summary migration failed.', error);
    });

    context.eventSource.on(messageSent, (messageId) => {
        const eventContext = SillyTavern.getContext();
        const sentIndex = Number(messageId);
        const sentMessage = eventContext.chat?.[sentIndex];
        if (!Number.isInteger(sentIndex) || sentMessage?.is_user !== true) return;
        enqueueSummaryCheck(getChatId(eventContext));
    });

    if (chatChanged) {
        context.eventSource.on(chatChanged, () => {
            const currentContext = SillyTavern.getContext();
            void migrateLegacySummaries(currentContext).then(options.onSaved).catch(error => {
                console.error('[Memory Augment] Legacy summary migration failed.', error);
            });
        });
    }
}
