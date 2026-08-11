import {
    clearSummaryMemory,
    generateSummary as generateSummaryWithSideApi,
} from './rag-client.js';
import { getMessageTimelineMetadata } from './story-status.js';

export const SUMMARY_KEY_PREFIX = '[KKT摘要]';
export const SUMMARY_STATE_KEY = 'kktoolbox_summary_state';

const LEGACY_SUMMARY_METADATA_KEY = 'memory_augment_summaries';
const LEGACY_SUMMARY_KEY_PREFIX = '[KKToolbox摘要]';
const SUMMARY_GENERATION_MAX_TOKENS = 1200;
const SUMMARY_BOOK_SUFFIX = '-自动总结';
const SUMMARY_ENTRY_DEPTH = 4;
const SUMMARY_ENTRY_ORDER_BASE = 100;
const HISTORICAL_OVERVIEW_KEY = '[KKT历史概括]';
const HISTORICAL_OVERVIEW_GROUP_SIZE = 5;
const HISTORICAL_OVERVIEW_ORDER = 99;
const WORLD_INFO_POSITION_AT_DEPTH = 4;
const SUMMARY_MIGRATION_VERSION = 2;
const MAX_AUTOMATIC_BACKFILL_BATCHES = 3;
let summaryQueue = Promise.resolve();
const summaryRuntimeByChat = new Map();
let activeSummaryBinding = null;

function clampInteger(value, fallback, minimum, maximum) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function getChatId(context) {
    return context?.getCurrentChatId?.() ?? context?.chatId;
}

function setSummaryRuntime(context, patch = {}) {
    const chatId = getChatId(context);
    if (!chatId) return;
    const previous = summaryRuntimeByChat.get(chatId) ?? {
        phase: 'idle',
        pendingFloors: 0,
        error: '',
    };
    summaryRuntimeByChat.set(chatId, { ...previous, ...patch });
}

async function refreshSummaryBookRuntime(context, bookName, worldModule = null, options = {}) {
    if (options.updateList !== false) {
        const updateList = context?.updateWorldInfoList ?? worldModule?.updateWorldInfoList;
        if (typeof updateList === 'function') {
            await updateList();
        }
    }

    const reloadEditor = context?.reloadWorldInfoEditor ?? worldModule?.reloadEditor;
    if (typeof reloadEditor === 'function') {
        reloadEditor(bookName, false);
    }

    const settingsUpdated = context?.eventTypes?.WORLDINFO_SETTINGS_UPDATED
        ?? context?.event_types?.WORLDINFO_SETTINGS_UPDATED;
    if (settingsUpdated) {
        await context?.eventSource?.emit?.(settingsUpdated);
    }
}

async function saveSummaryBookData(context, bookName, data) {
    await context.saveWorldInfo(bookName, data, true);
    await refreshSummaryBookRuntime(context, bookName, null, { updateList: false });
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
    state.overviewGroups = Array.isArray(state.overviewGroups) ? state.overviewGroups : [];
    state.bookName = String(state.bookName ?? '').trim();
    state.migrationVersion = Math.max(0, Math.trunc(Number(state.migrationVersion) || 0));
    delete state.aiRepliesSinceLastSummary;
    delete state.lastCountedReplySignature;
    return state;
}

function resetSummaryProgress(state) {
    if (!state) return false;
    const changed = state.lastSummarizedMessageIndex !== -1
        || state.entries.length > 0
        || state.overviewGroups.length > 0;
    state.lastSummarizedMessageIndex = -1;
    state.entries = [];
    state.overviewGroups = [];
    return changed;
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

export function buildSummaryBookName(characterName, sequence) {
    const name = String(characterName ?? '').trim();
    const number = Math.trunc(Number(sequence));
    return name && Number.isInteger(number) && number > 0
        ? `${name}${SUMMARY_BOOK_SUFFIX}${number}`
        : '';
}

function isSummaryBookForCharacter(bookName, characterName) {
    const prefix = `${String(characterName ?? '').trim()}${SUMMARY_BOOK_SUFFIX}`;
    const value = String(bookName ?? '').trim();
    if (!prefix || value === prefix) return value === prefix;
    return value.startsWith(prefix)
        && /^[1-9]\d*$/.test(value.slice(prefix.length));
}

async function listWorldInfoBookNames(context) {
    if (typeof context?.getWorldInfoBookNames === 'function') {
        const names = await context.getWorldInfoBookNames();
        if (Array.isArray(names)) return names.map(String);
    }
    try {
        const worldModule = await import('../../../world-info.js');
        return Array.isArray(worldModule.world_names) ? worldModule.world_names.map(String) : null;
    } catch {
        return null;
    }
}

async function findNextSummaryBookName(context, characterName) {
    const names = await listWorldInfoBookNames(context);
    const prefix = `${characterName}${SUMMARY_BOOK_SUFFIX}`;
    if (names) {
        const maximum = names.reduce((current, name) => {
            if (!String(name).startsWith(prefix)) return current;
            const suffix = String(name).slice(prefix.length);
            return /^[1-9]\d*$/.test(suffix) ? Math.max(current, Number(suffix)) : current;
        }, 0);
        return buildSummaryBookName(characterName, maximum + 1);
    }
    if (typeof context?.loadWorldInfo === 'function') {
        for (let sequence = 1; sequence <= 100000; sequence++) {
            const candidate = buildSummaryBookName(characterName, sequence);
            if (!await context.loadWorldInfo(candidate)) return candidate;
        }
    }
    throw new Error('无法为当前存档分配新的自动总结编号。');
}

async function syncSummaryBookBinding(context, character, characterName, bookName, bindCurrent = true) {
    if (typeof context?.syncSummaryWorldInfoBook === 'function') {
        await context.syncSummaryWorldInfoBook({ character, characterName, bookName, bindCurrent });
        await refreshSummaryBookRuntime(context, bookName);
        return;
    }
    if (typeof context?.bindAdditionalWorldInfoBook === 'function') {
        if (bindCurrent) await context.bindAdditionalWorldInfoBook(bookName);
        await refreshSummaryBookRuntime(context, bookName);
        return;
    }

    const fileName = getCharacterFileName(character);
    if (!fileName) {
        if (bindCurrent) throw new Error('当前角色缺少头像文件名，无法绑定辅助世界书。');
        return;
    }
    const worldModule = await import('../../../world-info.js');
    const charLore = Array.isArray(worldModule.world_info?.charLore)
        ? worldModule.world_info.charLore
        : [];
    let binding = charLore.find(item => item?.name === fileName);
    const previousBooks = Array.isArray(binding?.extraBooks) ? binding.extraBooks : [];
    const nextBooks = previousBooks.filter(name => (
        name === bookName || !isSummaryBookForCharacter(name, characterName)
    ));
    if (bindCurrent && !nextBooks.includes(bookName)) nextBooks.push(bookName);
    const changed = nextBooks.length !== previousBooks.length
        || nextBooks.some((name, index) => name !== previousBooks[index]);
    if (changed) {
        if (!binding) {
            binding = { name: fileName, extraBooks: nextBooks };
            charLore.push(binding);
        } else {
            binding.extraBooks = nextBooks;
        }
        Object.assign(worldModule.world_info, { charLore });
        context.saveSettingsDebounced?.();
        await refreshSummaryBookRuntime(context, bookName, worldModule);
    }
}

async function createSummaryBook(context, bookName) {
    if (typeof context?.createNewWorldInfo === 'function') {
        await context.createNewWorldInfo(bookName);
        await refreshSummaryBookRuntime(context, bookName);
        return;
    }
    const worldModule = await import('../../../world-info.js');
    const created = await worldModule.createNewWorldInfo(bookName);
    if (!created) {
        throw new Error(`创建摘要世界书失败：${bookName}`);
    }
    await refreshSummaryBookRuntime(context, bookName, worldModule);
}

async function bindSummaryBookToCharacter(context, character, bookName) {
    const current = getCurrentCharacter(context);
    await syncSummaryBookBinding(context, character, current?.name ?? '', bookName, true);
}

async function getSummaryBookName(context, create = false) {
    const current = getCurrentCharacter(context);
    if (!current) {
        if (create) throw new Error('当前没有可用于创建摘要世界书的角色。');
        return '';
    }
    const state = getSummaryState(context?.chatMetadata, create);
    const entryBookName = state?.entries
        ?.map(entry => String(entry?.bookName ?? '').trim())
        .find(Boolean);
    const hasLegacySummaryState = Boolean(entryBookName
        || state?.entries?.length
        || state?.overviewGroups?.length
        || Number(state?.lastSummarizedMessageIndex) >= 0);
    const legacyBookName = `${current.name}${SUMMARY_BOOK_SUFFIX}`;
    const chatBoundBookName = isSummaryBookForCharacter(
        context?.chatMetadata?.world_info,
        current.name,
    ) ? String(context.chatMetadata.world_info).trim() : '';
    let bookName = state?.bookName
        || entryBookName
        || chatBoundBookName
        || (hasLegacySummaryState
            ? legacyBookName
            : '');
    if (create) {
        if (!bookName) bookName = await findNextSummaryBookName(context, current.name);
        if (!bookName) throw new Error('当前聊天缺少可用于创建摘要世界书的存档标识。');
        if (state && state.bookName !== bookName) {
            state.bookName = bookName;
            await context.saveMetadata?.();
        }
        const bindingKey = `${String(getChatId(context) ?? '')}:${bookName}`;
        const knownBookNames = await listWorldInfoBookNames(context);
        const existing = knownBookNames
            ? knownBookNames.includes(bookName)
            : typeof context?.loadWorldInfo === 'function'
                ? await context.loadWorldInfo(bookName)
                : null;
        if (!existing) {
            // The user may delete the active summary lorebook directly in ST.
            // Its saved UIDs and progress then point at entries which can never
            // exist in the recreated file, so restart from the first eligible
            // floor before any reader can query those stale UIDs.
            if (resetSummaryProgress(state)) await context.saveMetadata?.();
            await createSummaryBook(context, bookName);
        }
        // The runtime cache only avoids reloading the book. Always reconcile
        // charLore so a manual unbind or an earlier failed save cannot leave
        // the RAG state and SillyTavern's real character binding out of sync.
        await bindSummaryBookToCharacter(context, current.character, bookName);
        activeSummaryBinding = { metadata: context.chatMetadata, key: bindingKey };
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

function isHistoricalOverviewEntry(entry) {
    const keys = Array.isArray(entry?.key) ? entry.key : [entry?.key];
    return keys.some(key => String(key ?? '') === HISTORICAL_OVERVIEW_KEY);
}

async function createWorldInfoEntry(context, bookName, data) {
    if (typeof context?.createWorldInfoEntry === 'function') {
        return context.createWorldInfoEntry(bookName, data);
    }
    const worldModule = await import('../../../world-info.js');
    return worldModule.createWorldInfoEntry(bookName, data);
}

async function ensureHistoricalOverviewEntryInData(context, bookName, data) {
    const match = Object.entries(data?.entries ?? {})
        .find(([, entry]) => isHistoricalOverviewEntry(entry));
    let uid = match?.[0];
    let entry = match?.[1];
    let created = false;
    if (!entry) {
        entry = await createWorldInfoEntry(context, bookName, data);
        uid = String(entry?.uid ?? '');
        created = true;
    }
    if (!entry || !uid) throw new Error('创建历史概括世界书条目失败。');
    const expected = {
        key: [HISTORICAL_OVERVIEW_KEY],
        comment: '历史概括（每5条自动总结更新）',
        addMemo: true,
        constant: true,
        position: WORLD_INFO_POSITION_AT_DEPTH,
        depth: SUMMARY_ENTRY_DEPTH,
        order: HISTORICAL_OVERVIEW_ORDER,
        disable: false,
    };
    let changed = created;
    for (const [field, value] of Object.entries(expected)) {
        if (JSON.stringify(entry[field]) !== JSON.stringify(value)) {
            entry[field] = value;
            changed = true;
        }
    }
    entry.content = String(entry.content ?? '');
    return { uid: String(entry.uid ?? uid), entry, changed };
}

function getManagedSummaryRange(entry) {
    const keys = Array.isArray(entry?.key) ? entry.key : [entry?.key];
    const managedKey = keys.find(key => String(key ?? '').startsWith(SUMMARY_KEY_PREFIX)
        || String(key ?? '').startsWith(LEGACY_SUMMARY_KEY_PREFIX));
    return getRangeFromKey(managedKey);
}

function rebuildSummaryProgressFromBook(state, bookName, data) {
    if (!state) return false;
    const records = [];
    for (const [uid, entry] of Object.entries(data?.entries ?? {})) {
        const managedKey = (Array.isArray(entry?.key) ? entry.key : [entry?.key])
            .find(key => String(key ?? '').startsWith(SUMMARY_KEY_PREFIX)
                || String(key ?? '').startsWith(LEGACY_SUMMARY_KEY_PREFIX));
        if (!managedKey) continue;
        let range = getRangeFromKey(managedKey);
        if (!range) continue;
        if (String(managedKey).startsWith(`${SUMMARY_KEY_PREFIX}[第`)) {
            range = { start: Math.max(0, range.start - 1), end: Math.max(0, range.end - 1) };
        }
        records.push({
            ...range,
            uid: String(entry?.uid ?? uid),
            key: String(managedKey),
            bookName,
            createdAt: String(state.entries.find(item => String(item?.uid) === String(entry?.uid ?? uid))?.createdAt ?? ''),
        });
    }
    records.sort(compareSummaryRanges);
    let contiguousEnd = -1;
    for (const record of records) {
        if (record.start > contiguousEnd + 1) break;
        contiguousEnd = Math.max(contiguousEnd, record.end);
    }
    const before = JSON.stringify({
        entries: state.entries,
        lastSummarizedMessageIndex: state.lastSummarizedMessageIndex,
    });
    state.entries = records;
    state.lastSummarizedMessageIndex = contiguousEnd;
    if (before !== JSON.stringify({ entries: state.entries, lastSummarizedMessageIndex: contiguousEnd })) {
        state.overviewGroups = [];
        return true;
    }
    return false;
}

function compareSummaryRanges(left, right) {
    return left.start - right.start || left.end - right.end;
}

function normalizeManagedSummaryOrders(data) {
    const managedEntries = Object.entries(data?.entries ?? {})
        .map(([uid, entry]) => ({ uid, entry, range: getManagedSummaryRange(entry) }))
        .filter(item => item.range)
        .sort((left, right) => compareSummaryRanges(left.range, right.range)
            || String(left.uid).localeCompare(String(right.uid), undefined, { numeric: true }));
    let changed = false;
    managedEntries.forEach(({ entry }, index) => {
        const order = SUMMARY_ENTRY_ORDER_BASE + index;
        if (Number(entry.order) !== order) {
            entry.order = order;
            changed = true;
        }
    });
    return changed;
}

function getSummaryOrder(records, start, end) {
    const ranges = (Array.isArray(records) ? records : [])
        .map(record => ({ start: Number(record?.start), end: Number(record?.end) }))
        .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end)
            && (range.start !== start || range.end !== end));
    ranges.push({ start, end });
    ranges.sort(compareSummaryRanges);
    return SUMMARY_ENTRY_ORDER_BASE + ranges.findIndex(range => range.start === start && range.end === end);
}

async function findSummaryEntry(context, bookName, key) {
    const command = `/findentry file=${quoteSlashValue(bookName)} field=key ${quoteSlashValue(key)}`;
    return getPipe(await runSlash(context, command));
}

async function setEntryField(context, bookName, uid, field, value) {
    const command = `/setentryfield file=${quoteSlashValue(bookName)} uid=${quoteSlashValue(uid)} field=${field} ${quoteSlashValue(value)}`;
    await runSlash(context, command);
}

async function configureSummaryEntry(context, bookName, uid, order = SUMMARY_ENTRY_ORDER_BASE) {
    await setEntryField(context, bookName, uid, 'constant', false);
    await setEntryField(context, bookName, uid, 'position', WORLD_INFO_POSITION_AT_DEPTH);
    await setEntryField(context, bookName, uid, 'depth', SUMMARY_ENTRY_DEPTH);
    await setEntryField(context, bookName, uid, 'order', order);
    await setEntryField(context, bookName, uid, 'disable', false);
}

async function ensureHistoricalOverviewEntry(context, bookName) {
    if (typeof context?.loadWorldInfo === 'function' && typeof context?.saveWorldInfo === 'function') {
        const data = await context.loadWorldInfo(bookName);
        if (data) {
            const result = await ensureHistoricalOverviewEntryInData(context, bookName, data);
            if (result.changed) await saveSummaryBookData(context, bookName, data);
            return result;
        }
    }
    let uid = await findSummaryEntry(context, bookName, HISTORICAL_OVERVIEW_KEY);
    if (!uid) {
        uid = getPipe(await runSlash(
            context,
            `/createentry file=${quoteSlashValue(bookName)} key=${quoteSlashValue(HISTORICAL_OVERVIEW_KEY)} ""`,
        ));
    }
    if (!uid) throw new Error('创建历史概括世界书条目失败。');
    await setEntryField(context, bookName, uid, 'constant', true);
    await setEntryField(context, bookName, uid, 'position', WORLD_INFO_POSITION_AT_DEPTH);
    await setEntryField(context, bookName, uid, 'depth', SUMMARY_ENTRY_DEPTH);
    await setEntryField(context, bookName, uid, 'order', HISTORICAL_OVERVIEW_ORDER);
    await setEntryField(context, bookName, uid, 'disable', false);
    return { uid: String(uid), entry: null, changed: true };
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

async function upsertSummaryEntry(context, events, start, end, createdAt, order = SUMMARY_ENTRY_ORDER_BASE) {
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

    if (data && typeof context?.saveWorldInfo === 'function') {
        let keptUid;
        let keptEntry;
        if (matches.length > 0) {
            [keptUid, keptEntry] = matches[0];
        } else {
            keptEntry = await createWorldInfoEntry(context, bookName, data);
            keptUid = keptEntry?.uid;
        }
        if (!keptEntry || keptUid === undefined || keptUid === null) {
            throw new Error(`创建摘要世界书条目失败：${key}`);
        }
        keptEntry.key = [key];
        keptEntry.comment = key;
        keptEntry.addMemo = true;
        keptEntry.content = content;
        keptEntry.constant = false;
        keptEntry.position = WORLD_INFO_POSITION_AT_DEPTH;
        keptEntry.depth = SUMMARY_ENTRY_DEPTH;
        keptEntry.order = order;
        keptEntry.disable = false;
        for (const [duplicateUid] of matches.slice(1)) {
            delete data.entries[duplicateUid];
        }
        await ensureHistoricalOverviewEntryInData(context, bookName, data);
        normalizeManagedSummaryOrders(data);
        await saveSummaryBookData(context, bookName, data);
        const verified = await context.loadWorldInfo(bookName);
        if (String(verified?.entries?.[keptUid]?.content ?? '').trim() !== content) {
            throw new Error(`摘要世界书正文保存失败：${key}`);
        }
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
    await setEntryField(context, bookName, uid, 'content', content);
    await configureSummaryEntry(context, bookName, uid, order);
    await ensureHistoricalOverviewEntry(context, bookName);
    const verifiedContent = getPipe(await runSlash(
        context,
        `/getentryfield file=${quoteSlashValue(bookName)} field=content ${quoteSlashValue(uid)}`,
    ));
    if (verifiedContent !== content) {
        throw new Error(`摘要世界书正文保存失败：${key}`);
    }
    return {
        start,
        end,
        uid: String(uid),
        key,
        bookName,
        createdAt,
    };
}

async function upsertLegacySummaryEntry(context, record, order = SUMMARY_ENTRY_ORDER_BASE) {
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
    await configureSummaryEntry(context, bookName, uid, order);
    await ensureHistoricalOverviewEntry(context, bookName);
    return { ...record, uid: String(uid), key, bookName };
}

function limitText(value, maximum) {
    return Array.from(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, maximum).join('');
}

const COMPLETE_SENTENCE_END = /[。！？…!?；;.!」』）)】]$/u;
const SUMMARY_EVENT_LIMIT = 5;
const SUMMARY_OVERVIEW_LIMIT = 150;
const INCOMPLETE_ELLIPSIS_END = /(?:…|\.\.\.)[」』）)】]?$/u;
const REFUSAL_OR_DRAFT_PATTERN = /(?:抱歉|对不起|无法|不能|不便).{0,30}(?:总结|概括|处理|协助|提供)|(?:内容|题材).{0,20}(?:敏感|不当|违规)|作为(?:一个)?AI|\b(?:drafting|analyzing|analysis|we need|i cannot|i can't|sorry)\b/i;

export function isUnusableSummaryOutput(output) {
    const text = String(output ?? '').trim();
    return !text || REFUSAL_OR_DRAFT_PATTERN.test(text);
}

function normalizeOverview(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (Array.from(text).length > SUMMARY_OVERVIEW_LIMIT) return '';
    if (INCOMPLETE_ELLIPSIS_END.test(text)) return '';
    return COMPLETE_SENTENCE_END.test(text) ? text : '';
}

function getField(block, label, nextLabels = []) {
    const ending = nextLabels.length > 0 ? `(?=\\s+(?:${nextLabels.join('|')})\\s*[：:]|$)` : '$';
    const match = block.match(new RegExp(`${label}\\s*[：:]\\s*([\\s\\S]*?)${ending}`, 'm'));
    return String(match?.[1] ?? '').trim();
}

export function parseSummaryEvents(output) {
    const text = String(output ?? '').trim();
    if (isUnusableSummaryOutput(text)) return [];
    const headers = [...text.matchAll(/\[事件\s*\d+\]/g)];
    if (headers.length > SUMMARY_EVENT_LIMIT) return [];
    const blocks = headers.map((header, index) => {
        const start = header.index + header[0].length;
        const end = headers[index + 1]?.index ?? text.length;
        return text.slice(start, end).trim();
    });
    const events = blocks.map((block) => {
        const importanceText = getField(block, '重要度', ['事件概述', '时间', '地点', '涉及角色']);
        const overview = getField(block, '事件概述', ['重要度', '时间', '地点', '涉及角色']);
        const time = getField(block, '时间', ['重要度', '事件概述', '地点', '涉及角色']);
        const location = getField(block, '地点', ['重要度', '事件概述', '时间', '涉及角色']);
        const characters = getField(block, '涉及角色', ['重要度', '事件概述', '时间', '地点']);
        const normalizedOverview = normalizeOverview(overview);
        if (!normalizedOverview) {
            return null;
        }
        return {
            importance: clampInteger(importanceText.match(/[1-5]/)?.[0], 1, 1, 5),
            time: limitText(time, 80) || '未明确',
            characters: limitText(characters, 100) || '未明确',
            location: limitText(location, 100) || '未明确',
            overview: normalizedOverview,
        };
    });

    if (events.length > 0 && events.every(Boolean)) {
        return events;
    }
    if (headers.length > 0 || /(?:重要度|事件概述|涉及角色|地点|时间)\s*[：:]/.test(text)) {
        return [];
    }
    const fallback = normalizeOverview(text);
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
        `⏰ 固定历史时间锚点：${event.time}（不得按当前回合重新解释）`,
        ` ${event.characters}`,
        ` ${event.location}`,
        ` ${event.overview}`,
    ].join('\n');
}

function guardHistoricalSummaryTimes(content) {
    return String(content ?? '').replace(
        /^⏰\s+(?!固定历史时间锚点：)(.+)$/gmu,
        '⏰ 固定历史时间锚点：$1（不得按当前回合重新解释）',
    );
}

export function formatSummaryContent(events) {
    return [...events]
        .sort((left, right) => right.importance - left.importance)
        .slice(0, SUMMARY_EVENT_LIMIT)
        .map(formatEventContent)
        .join('\n\n');
}

export function isMalformedSummaryContent(content) {
    const text = String(content ?? '').trim();
    const hasLegacyForcedTruncation = text.split(/\r?\n/).some((line) => {
        const value = line.trim();
        return Array.from(value).length === SUMMARY_OVERVIEW_LIMIT && INCOMPLETE_ELLIPSIS_END.test(value);
    });
    return isUnusableSummaryOutput(text)
        || /\[事件\s*\d+\]|(?:重要度|事件概述)\s*[：:]/.test(text)
        || hasLegacyForcedTruncation
        || !COMPLETE_SENTENCE_END.test(text);
}

async function findMalformedSummaryRange(context, state) {
    const bookName = await getSummaryBookName(context, false);
    if (!bookName || typeof context?.loadWorldInfo !== 'function') return null;
    const data = await context.loadWorldInfo(bookName);
    const records = [...state.entries]
        .filter(entry => Number.isInteger(Number(entry?.start)) && Number.isInteger(Number(entry?.end)))
        .sort((left, right) => Number(left.start) - Number(right.start));
    for (const record of records) {
        const entry = data?.entries?.[record.uid];
        if (!entry || isMalformedSummaryContent(entry.content)) {
            return { start: Number(record.start), end: Number(record.end), uid: String(record.uid ?? '') };
        }
    }
    return null;
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

function formatSummaryTimeline(timelineContext) {
    const lines = (Array.isArray(timelineContext) ? timelineContext : [])
        .flatMap((item) => {
            const parts = [
                `第 ${Number(item.messageId) + 1} 楼`,
                item.sceneTime && `场景时间=${item.sceneTime}`,
                item.mainlineTime && `主线时间=${item.mainlineTime}`,
                item.sceneAnchorId && `场景锚点=${item.sceneAnchorId}`,
                item.mainlineAnchorId && `主线锚点=${item.mainlineAnchorId}`,
            ].filter(Boolean);
            const floor = parts.length > 1 ? parts.join('｜') : '';
            const segments = (Array.isArray(item.segments) ? item.segments : [])
                .filter(segment => segment?.startQuote && (segment?.anchorLabel || segment?.time))
                .map(segment => `  ↳ 从“${limitText(segment.startQuote, 60)}”开始｜片段时间=${segment.anchorLabel || segment.time}｜类型=${segment.mode || 'unknown'}`);
            return [floor, ...segments].filter(Boolean);
        })
        .filter(Boolean);
    return lines.length > 0 ? lines.join('\n') : '（这段旧剧情尚未建立时间锚点；无法确定时写“未明确”，禁止猜测。）';
}

export function buildSummaryPrompt(messages, start, end, timelineContext = []) {
    return [
        `以下${end - start + 1}楼只是本次处理窗口，不是事件边界。通常提取1-3个关键事件；只有确实存在彼此独立的事件或明确时间跳跃时才可增加，但绝对不超过5个。按重要度从高到低排列。跨楼的同一事件必须合并，不能把同一件事的动作、对话和结果拆成多个事件。每个事件严格按以下格式输出，不要输出其他内容：`,
        '',
        '[事件1]',
        '重要度：X（1-5，5为最重要）',
        '事件概述：（只写1-2句完整的剧情骨架：谁因为什么做了什么，造成什么结果、关系或局势变化；通常不超过100字，绝不超过150字）',
        '时间：（优先复制下方时间锚点；未明确就写“未明确”，禁止把历史中的相对时间按总结时的现在重算）',
        '地点：（事件发生的地点）',
        '涉及角色：（角色名，逗号分隔；放在最后）',
        '',
        '[事件2]',
        '...',
        '',
        '评判标准：',
        '- 这是梗概，不是正文摘录；不要复述动作、对话、外貌、气氛和细枝末节，原文细节会由 RAG 另行召回',
        '- 同一矛盾、同一场对话、同一行动及其直接结果算一个事件，禁止为了凑数量拆开',
        '- 有矛盾冲突、清晰脉络、角色关系变化、重大决策的事件 = 高重要度',
        '- 纯日常流水账、寒暄、无实质进展 = 低重要度',
        '- 如果这段对话全是日常闲聊没有值得记录的事件，只输出一个1星事件简单概括即可',
        '- “昨天、三天前、十年前”等词只相对于它所在的场景时间有效；不要因为当前主线后来推进而改写其间隔',
        '- 回忆、转述历史与主线正在发生是不同时间层；只提到旧事，不代表主线倒退',
        '',
        '以下是插件保存的时间锚点（优先级高于你对楼层间隔的猜测）：',
        formatSummaryTimeline(timelineContext),
        '',
        `以下是需要分析的对话（第${start + 1}-${end + 1}楼）：`,
        '',
        formatDialogue(messages, start),
    ].join('\n');
}

function buildSummaryRetryPrompt(messages, start, end, timelineContext = []) {
    return [
        `重新概括下面第${start + 1}-${end + 1}楼发生的关键事件。上一次回答存在事件过多、概述过长、格式错误或句子不完整的问题。`,
        '通常只提取1-3个事件；只有明确独立事件或时间跳跃才可增加，绝对不超过5个。同一事件的起因、行动和结果必须合并。',
        '每个事件都按“[事件N]、重要度、事件概述、时间、地点、涉及角色”的原格式输出，不要输出解释。',
        '事件概述只写1-2句完整的因果骨架，通常不超过100字，绝不超过150字；不要复述细节，不要用省略号收尾。',
        '保留原剧情中的时间关系；楼层数不代表时间流逝，不能自行把“三天前”改成“昨天”。',
        '',
        '输出格式：',
        '[事件1]',
        '重要度：X',
        '事件概述：完整的简短概述。',
        '时间：未明确',
        '地点：未明确',
        '涉及角色：角色名',
        '',
        '时间锚点：',
        formatSummaryTimeline(timelineContext),
        '',
        formatDialogue(messages, start),
    ].join('\n');
}

async function callSummaryModel(settings, _context, prompt, generateSummary) {
    if (generateSummary) {
        return generateSummary(prompt, SUMMARY_GENERATION_MAX_TOKENS);
    }
    const sideApi = settings?.apis?.barrage;
    if (String(sideApi?.url ?? '').trim()
        && String(sideApi?.apiKey ?? '').trim()
        && String(sideApi?.model ?? '').trim()) {
        const response = await generateSummaryWithSideApi({
            barrage: sideApi,
            prompt,
            maxTokens: SUMMARY_GENERATION_MAX_TOKENS,
        });
        return response?.content;
    }
    throw new Error('请先填写完整的副 API 地址、Key 和模型；自动总结不会调用正文主 API。');
}

function hashText(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function getOverviewGroupKey(start, end) {
    return `${start}-${end}`;
}

function getOverviewBlockHeader(start, end) {
    return `【历史概括·第${start + 1}-${end + 1}楼】`;
}

export function buildHistoricalOverviewPrompt(summaries) {
    const sorted = [...summaries].sort((left, right) => left.start - right.start);
    const start = sorted[0]?.start ?? 0;
    const end = sorted.at(-1)?.end ?? start;
    return [
        `请把下面第${start + 1}-${end + 1}楼的5份阶段事件总结整理成一段长期历史概括。`,
        '只概括已经明确发生的主线、重要关系变化、关键决定和仍有后续影响的事实，不要添加推测。',
        '不同事件不要强行补出因果；不得把角色行为夸张成性格突变、立场转变或权力挑战。',
        '保留原有时间锚点和先后关系；“昨天、三天前”等相对时间只能沿用原总结含义，不能按现在重新计算。',
        '输出一段完整中文正文，最多400字，不要标题、序号、字段名、前言或解释。',
        '',
        ...sorted.map(item => [
            `【第${item.start + 1}-${item.end + 1}楼总结】`,
            item.summary,
        ].join('\n')),
    ].join('\n\n');
}

function normalizeHistoricalOverviewOutput(output) {
    const text = String(output ?? '')
        .replace(/^```[^\n]*\n?|```$/g, '')
        .replace(/^历史概括\s*[：:]?\s*/u, '')
        .trim();
    if (isUnusableSummaryOutput(text)) return '';
    return limitText(text, 400);
}

function replaceOverviewBlock(content, start, end, overview) {
    const header = getOverviewBlockHeader(start, end);
    const block = `${header}\n${overview}`;
    const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}[\\s\\S]*?(?=\\n\\n【历史概括·第\\d+-\\d+楼】|$)`, 'u');
    const current = String(content ?? '').trim();
    if (pattern.test(current)) return current.replace(pattern, block).trim();
    return [current, block].filter(Boolean).join('\n\n');
}

async function saveHistoricalOverviewBlock(context, bookName, start, end, overview) {
    if (typeof context?.loadWorldInfo === 'function' && typeof context?.saveWorldInfo === 'function') {
        const data = await context.loadWorldInfo(bookName);
        if (data) {
            const { entry } = await ensureHistoricalOverviewEntryInData(context, bookName, data);
            entry.content = replaceOverviewBlock(entry.content, start, end, overview);
            await saveSummaryBookData(context, bookName, data);
            return;
        }
    }
    const { uid } = await ensureHistoricalOverviewEntry(context, bookName);
    const current = getPipe(await runSlash(
        context,
        `/getentryfield file=${quoteSlashValue(bookName)} field=content ${quoteSlashValue(uid)}`,
    ));
    await setEntryField(context, bookName, uid, 'content', replaceOverviewBlock(current, start, end, overview));
}

export async function updateHistoricalOverview(settings, context, options = {}) {
    const state = getSummaryState(context?.chatMetadata, true);
    const summaries = await getSummaries(context);
    const completeGroupCount = Math.floor(summaries.length / HISTORICAL_OVERVIEW_GROUP_SIZE);
    if (!state || completeGroupCount === 0) return { updated: 0 };

    let target = null;
    for (let index = 0; index < completeGroupCount; index++) {
        const group = summaries.slice(
            index * HISTORICAL_OVERVIEW_GROUP_SIZE,
            (index + 1) * HISTORICAL_OVERVIEW_GROUP_SIZE,
        );
        const start = group[0].start;
        const end = group.at(-1).end;
        const sourceHash = hashText(group.map(item => `${item.uid}\n${item.start}-${item.end}\n${item.summary}`).join('\n\n'));
        const saved = state.overviewGroups.find(item => item.key === getOverviewGroupKey(start, end));
        if (saved?.sourceHash !== sourceHash) {
            target = { group, start, end, sourceHash };
            break;
        }
    }
    if (!target) return { updated: 0 };

    const expectedChatId = getChatId(context);
    const prompt = buildHistoricalOverviewPrompt(target.group);
    const output = normalizeHistoricalOverviewOutput(await callSummaryModel(
        settings,
        context,
        prompt,
        options.generateSummary,
    ));
    if (!output) throw new Error(`历史概括生成失败：第${target.start + 1}-${target.end + 1}楼。`);
    const currentContext = options.getCurrentContext?.() ?? context;
    if (getChatId(currentContext) !== expectedChatId || currentContext.chatMetadata !== context.chatMetadata) {
        return { updated: 0, discarded: true };
    }
    const bookName = await getSummaryBookName(currentContext, true);
    await saveHistoricalOverviewBlock(currentContext, bookName, target.start, target.end, output);
    state.overviewGroups = state.overviewGroups
        .filter(item => item.key !== getOverviewGroupKey(target.start, target.end));
    state.overviewGroups.push({
        key: getOverviewGroupKey(target.start, target.end),
        start: target.start,
        end: target.end,
        sourceHash: target.sourceHash,
    });
    await currentContext.saveMetadata?.();
    options.onSaved?.({ type: 'historical-overview', start: target.start, end: target.end });
    return { updated: 1, start: target.start, end: target.end };
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

    const knownBookNames = await listWorldInfoBookNames(context);
    if (knownBookNames && !knownBookNames.includes(bookName)) {
        if (resetSummaryProgress(state)) await context.saveMetadata?.();
        return [];
    }

    const canLoadDirectly = typeof context?.loadWorldInfo === 'function';
    const data = canLoadDirectly
        ? await context.loadWorldInfo(bookName)
        : null;
    if (data && rebuildSummaryProgressFromBook(state, bookName, data)) {
        await context.saveMetadata?.();
    }
    const summaries = [];
    for (const entry of state.entries) {
        if (entry?.uid === undefined || entry?.uid === null || String(entry.uid).trim() === '') {
            continue;
        }
        const direct = String(data?.entries?.[entry.uid]?.content ?? '').trim();
        // If the official loader returned the book, an absent UID is genuinely
        // absent. Falling back to STscript here only opens an error popup for a
        // deleted entry and cannot recover any content.
        const summary = direct || (!canLoadDirectly ? getPipe(await runSlash(
            context,
            `/getentryfield file=${quoteSlashValue(bookName)} field=content ${quoteSlashValue(entry.uid)}`,
        )) : '');
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

export async function getSummaryStatus(context, settings = {}) {
    const state = getSummaryState(context?.chatMetadata);
    const bookName = await getSummaryBookName(context, false);
    let entryCount = state?.entries.length ?? 0;

    if (bookName && typeof context?.loadWorldInfo === 'function') {
        const data = await context.loadWorldInfo(bookName);
        entryCount = Object.values(data?.entries ?? {}).filter(isManagedSummaryEntry).length;
    }
    const lastSummaryAt = state?.entries.map(item => item.createdAt).filter(Boolean).sort().at(-1) ?? null;
    const recentMessages = clampInteger(settings?.context?.recentMessages, 20, 1, 1000);
    const batchSize = clampInteger(settings?.context?.summaryBatchSize, 15, 1, 50);
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const nextStart = Math.max(0, (state?.lastSummarizedMessageIndex ?? -1) + 1);
    const firstIndexInsideRecentWindow = Math.max(0, chat.length - recentMessages);
    const calculatedPendingFloors = Math.max(0, firstIndexInsideRecentWindow - nextStart);
    const runtime = summaryRuntimeByChat.get(getChatId(context)) ?? {};
    return {
        entryCount,
        summaryCount: state?.entries.length ?? 0,
        lastSummaryAt,
        bookName,
        batchSize,
        pendingFloors: calculatedPendingFloors,
        phase: String(runtime.phase ?? (calculatedPendingFloors >= batchSize ? 'pending' : 'idle')),
        error: String(runtime.error ?? ''),
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
            } else if (isHistoricalOverviewEntry(entry)) {
                delete data.entries[uid];
            }
        }
        if (removed > 0) {
            await saveSummaryBookData(context, bookName, data);
        }
    }

    const state = getSummaryState(context?.chatMetadata, true);
    resetSummaryProgress(state);
    await context.saveMetadata?.();
    const chatId = getChatId(context);
    if (chatId && typeof globalThis.location !== 'undefined') {
        try {
            await clearSummaryMemory(chatId);
        } catch (error) {
            console.warn('[Memory Augment] Failed to clear summary vectors.', error);
        }
    }
    return removed;
}

export function regenerateAllSummaries(settings, context, options = {}) {
    const expectedChatId = getChatId(context);
    const expectedMetadata = context?.chatMetadata;
    const task = async () => {
        const activeContext = options.getCurrentContext?.() ?? context;
        if (!expectedChatId
            || getChatId(activeContext) !== expectedChatId
            || activeContext.chatMetadata !== expectedMetadata) {
            return { removed: 0, created: 0, pendingFloors: 0, discarded: true };
        }

        const removed = await clearAllSummaries(activeContext);
        options.onProgress?.({ removed, created: 0, pendingFloors: 0 });
        const batchSize = clampInteger(settings?.context?.summaryBatchSize, 15, 1, 50);
        const maximumBatches = Math.ceil((activeContext.chat?.length ?? 0) / batchSize) + 2;
        let created = 0;
        let pendingFloors = 0;
        for (let attempt = 0; attempt < maximumBatches; attempt++) {
            const currentContext = options.getCurrentContext?.() ?? activeContext;
            if (getChatId(currentContext) !== expectedChatId
                || currentContext.chatMetadata !== expectedMetadata) {
                return { removed, created, pendingFloors, discarded: true };
            }
            const result = await summarizePendingMessages(settings, currentContext, {
                ...options,
                onSaved: options.onSaved,
            });
            pendingFloors = Number(result?.pendingFloors) || 0;
            if (result?.created !== 1 || result?.discarded) break;
            created++;
            options.onProgress?.({ removed, created, pendingFloors });
            if (pendingFloors < batchSize) break;
        }
        return { removed, created, pendingFloors };
    };

    summaryQueue = summaryQueue.catch(() => undefined).then(task).catch((error) => {
        const activeContext = options.getCurrentContext?.() ?? context;
        if (getChatId(activeContext) === expectedChatId
            && activeContext.chatMetadata === expectedMetadata) {
            setSummaryRuntime(activeContext, {
                phase: 'error',
                error: String(error?.message ?? error),
            });
            options.onProgress?.({ error });
        }
        throw error;
    });
    return summaryQueue;
}

export function regenerateSummaryRange(settings, context, startFloor, endFloor, options = {}) {
    const firstFloor = Math.trunc(Number(startFloor));
    const lastFloor = Math.trunc(Number(endFloor));
    if (!Number.isInteger(firstFloor) || !Number.isInteger(lastFloor) || firstFloor < 1 || lastFloor < 1) {
        return Promise.reject(new Error('请输入有效的起止楼层。'));
    }
    const requestedStart = Math.min(firstFloor, lastFloor) - 1;
    const requestedEnd = Math.max(firstFloor, lastFloor) - 1;
    const expectedChatId = getChatId(context);
    const expectedMetadata = context?.chatMetadata;
    const task = async () => {
        const activeContext = options.getCurrentContext?.() ?? context;
        if (!expectedChatId
            || getChatId(activeContext) !== expectedChatId
            || activeContext.chatMetadata !== expectedMetadata) {
            return { regenerated: 0, ranges: [], discarded: true };
        }
        await migrateLegacySummaries(activeContext);
        // This also reconciles metadata with the entries that really exist in
        // the book, so manually deleted UIDs can never become repair targets.
        await getSummaries(activeContext);
        const state = getSummaryState(activeContext.chatMetadata, true);
        const targets = state.entries
            .map(entry => ({
                start: Number(entry?.start),
                end: Number(entry?.end),
            }))
            .filter(range => Number.isInteger(range.start)
                && Number.isInteger(range.end)
                && range.end >= requestedStart
                && range.start <= requestedEnd)
            .sort(compareSummaryRanges);
        if (targets.length === 0) {
            throw new Error('指定范围内还没有已生成的摘要条目。');
        }

        const completed = [];
        for (const target of targets) {
            setSummaryRuntime(activeContext, {
                phase: 'repairing',
                start: target.start,
                end: target.end,
                error: '',
            });
            options.onProgress?.({ regenerated: completed.length, target });
            const events = await generateSummaryEventsForRange(
                settings,
                activeContext,
                target.start,
                target.end,
                options,
            );
            const currentContext = options.getCurrentContext?.() ?? activeContext;
            if (getChatId(currentContext) !== expectedChatId
                || currentContext.chatMetadata !== expectedMetadata) {
                return { regenerated: completed.length, ranges: completed, discarded: true };
            }
            const order = getSummaryOrder(state.entries, target.start, target.end);
            const saved = await upsertSummaryEntry(
                currentContext,
                events,
                target.start,
                target.end,
                new Date().toISOString(),
                order,
            );
            state.entries = state.entries
                .filter(entry => Number(entry.start) !== target.start || Number(entry.end) !== target.end);
            state.entries.push(saved);
            state.entries.sort(compareSummaryRanges);
            await currentContext.saveMetadata?.();
            completed.push({ start: target.start + 1, end: target.end + 1 });
            options.onSaved?.(saved);
        }

        // Rebuild only historical overview groups whose source summaries
        // changed. Detailed summaries remain successful even if an overview
        // request happens to fail.
        for (let attempt = 0; attempt < completed.length; attempt++) {
            try {
                const result = await updateHistoricalOverview(settings, activeContext, options);
                if (result?.updated !== 1) break;
            } catch (error) {
                console.warn('[Memory Augment] Historical overview refresh after range regeneration failed.', error);
                break;
            }
        }
        const recentMessages = clampInteger(settings?.context?.recentMessages, 20, 1, 1000);
        const firstIndexInsideRecentWindow = Math.max(0, (activeContext.chat?.length ?? 0) - recentMessages);
        const pendingFloors = Math.max(0, firstIndexInsideRecentWindow - (state.lastSummarizedMessageIndex + 1));
        setSummaryRuntime(activeContext, { phase: 'idle', pendingFloors, error: '' });
        options.onProgress?.({ regenerated: completed.length, ranges: completed, pendingFloors });
        return { regenerated: completed.length, ranges: completed, pendingFloors };
    };

    summaryQueue = summaryQueue.catch(() => undefined).then(task).catch((error) => {
        const activeContext = options.getCurrentContext?.() ?? context;
        if (getChatId(activeContext) === expectedChatId
            && activeContext.chatMetadata === expectedMetadata) {
            setSummaryRuntime(activeContext, {
                phase: 'error',
                error: String(error?.message ?? error),
            });
            options.onProgress?.({ error });
        }
        throw error;
    });
    return summaryQueue;
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
        keptEntry.constant = false;
        keptEntry.position = WORLD_INFO_POSITION_AT_DEPTH;
        keptEntry.depth = SUMMARY_ENTRY_DEPTH;
        keptEntry.order = SUMMARY_ENTRY_ORDER_BASE;
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
    for (const entry of Object.values(data?.entries ?? {})) {
        if (!isManagedSummaryEntry(entry)) continue;
        const expected = {
            constant: false,
            position: WORLD_INFO_POSITION_AT_DEPTH,
            depth: SUMMARY_ENTRY_DEPTH,
            disable: false,
        };
        for (const [field, value] of Object.entries(expected)) {
            if (entry[field] !== value) {
                entry[field] = value;
                worldInfoChanged = true;
            }
        }
        const guardedContent = guardHistoricalSummaryTimes(entry.content);
        if (guardedContent !== String(entry.content ?? '')) {
            entry.content = guardedContent;
            worldInfoChanged = true;
            migrated++;
        }
    }
    if (normalizeManagedSummaryOrders(data)) {
        worldInfoChanged = true;
    }
    if (Object.values(data?.entries ?? {}).some(isManagedSummaryEntry)) {
        const overview = await ensureHistoricalOverviewEntryInData(context, bookName, data);
        if (overview.changed) worldInfoChanged = true;
    }
    if (worldInfoChanged && typeof context?.saveWorldInfo === 'function') {
        await saveSummaryBookData(context, bookName, data);
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

async function reconcileLegacySummaryBook(context, state) {
    const current = getCurrentCharacter(context);
    if (!current || typeof context?.loadWorldInfo !== 'function') {
        return false;
    }

    const claimedHistory = Boolean(
        state.entries.length
        || state.overviewGroups.length
        || state.lastSummarizedMessageIndex >= 0,
    );
    const entryBookNames = state.entries
        .map(entry => String(entry?.bookName ?? '').trim())
        .filter(Boolean);
    const chatBoundBookName = isSummaryBookForCharacter(
        context?.chatMetadata?.world_info,
        current.name,
    ) ? String(context.chatMetadata.world_info).trim() : '';
    const primaryCandidates = [...new Set([
        ...entryBookNames,
        state.bookName,
        chatBoundBookName,
    ].filter(name => isSummaryBookForCharacter(name, current.name)))];

    let populatedBookName = '';
    for (const candidate of primaryCandidates) {
        const data = await context.loadWorldInfo(candidate);
        if (Object.values(data?.entries ?? {}).some(isManagedSummaryEntry)) {
            populatedBookName = candidate;
            break;
        }
    }

    // Only a chat which already carries summary progress may claim the old,
    // unsuffixed lorebook. A new chat must never adopt another save's history.
    if (!populatedBookName && claimedHistory) {
        const legacyBookName = `${current.name}${SUMMARY_BOOK_SUFFIX}`;
        if (!primaryCandidates.includes(legacyBookName)) {
            const legacyData = await context.loadWorldInfo(legacyBookName);
            if (Object.values(legacyData?.entries ?? {}).some(isManagedSummaryEntry)) {
                populatedBookName = legacyBookName;
            }
        }
    }

    if (populatedBookName) {
        const changed = state.bookName !== populatedBookName
            || state.entries.length > 0
            || state.lastSummarizedMessageIndex >= 0;
        state.bookName = populatedBookName;
        // Rebuild these two fields from the entries which really exist in the
        // selected lorebook. This removes stale UIDs and impossible progress.
        state.entries = [];
        state.lastSummarizedMessageIndex = -1;
        return changed;
    }

    if (claimedHistory) {
        // The metadata says old floors were summarized, but no safe candidate
        // contains a summary. Keep the allocated name, discard only the false
        // progress, and let normal backfill recreate summaries from this chat.
        state.entries = [];
        state.overviewGroups = [];
        state.lastSummarizedMessageIndex = -1;
        return true;
    }
    return false;
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
    const previousBookName = state.bookName;
    const reconciliationChanged = state.migrationVersion < SUMMARY_MIGRATION_VERSION
        ? await reconcileLegacySummaryBook(context, state)
        : false;
    const selectedBookName = await getSummaryBookName(context, true);
    const selectionChanged = Boolean(selectedBookName && previousBookName !== selectedBookName);
    if (selectionChanged) state.bookName = selectedBookName;
    const legacyStore = metadata[LEGACY_SUMMARY_METADATA_KEY];
    if (state.migrationVersion >= SUMMARY_MIGRATION_VERSION
        && !hadLegacyCounters
        && !(legacyStore && typeof legacyStore === 'object' && !Array.isArray(legacyStore))) {
        if (selectionChanged) await context.saveMetadata?.();
        return 0;
    }
    const needsVersionSave = state.migrationVersion !== SUMMARY_MIGRATION_VERSION;
    let migrated = await migrateLegacyLorebookEntries(context, state);

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
            const order = getSummaryOrder(state.entries, record.start, record.end);
            const saved = await upsertLegacySummaryEntry(context, record, order);
            if (!state.entries.some(item => item.start === saved.start && item.end === saved.end)) {
                state.entries.push(saved);
            }
            state.lastSummarizedMessageIndex = Math.max(state.lastSummarizedMessageIndex, record.end);
            migrated++;
        }
        delete metadata[LEGACY_SUMMARY_METADATA_KEY];
    }
    state.migrationVersion = SUMMARY_MIGRATION_VERSION;
    if (migrated > 0 || hadLegacyCounters || needsVersionSave || selectionChanged || reconciliationChanged) {
        await context.saveMetadata?.();
    }
    return migrated;
}

async function generateSummaryEventsForRange(settings, context, start, end, options = {}) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const messages = chat.slice(start, end + 1).map(message => ({
        name: message?.name,
        is_user: message?.is_user,
        mes: message?.mes,
    }));
    const timelineContext = Array.from({ length: end - start + 1 }, (_, offset) => {
        const messageId = start + offset;
        const timeline = getMessageTimelineMetadata(context, messageId);
        return timeline ? { messageId, ...timeline } : null;
    }).filter(Boolean);
    const prompt = buildSummaryPrompt(messages, start, end, timelineContext);
    let output = String(await callSummaryModel(settings, context, prompt, options.generateSummary) ?? '').trim();
    let events = parseSummaryEvents(output);
    if (events.length === 0) {
        const retryPrompt = buildSummaryRetryPrompt(messages, start, end, timelineContext);
        output = String(await callSummaryModel(settings, context, retryPrompt, options.generateSummary) ?? '').trim();
        events = parseSummaryEvents(output);
    }
    if (events.length === 0) {
        throw new Error(`Summary model returned no usable events for messages ${start}-${end}.`);
    }
    return events;
}

export async function summarizePendingMessages(settings, context, options = {}) {
    const recentMessages = clampInteger(settings?.context?.recentMessages, 20, 1, 1000);
    const batchSize = clampInteger(settings?.context?.summaryBatchSize, 15, 1, 50);
    const chatId = getChatId(context);
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const metadata = context?.chatMetadata;
    if (!chatId || !metadata || chat.length === 0) {
        return { created: 0, pendingFloors: 0 };
    }

    await migrateLegacySummaries(context);
    const state = getSummaryState(metadata, true);
    let overviewUpdated = 0;
    try {
        const overviewResult = await updateHistoricalOverview(settings, context, options);
        overviewUpdated = overviewResult?.updated ?? 0;
    } catch (error) {
        console.warn('[Memory Augment] Historical overview update failed; detailed summaries remain available.', error);
    }
    const malformed = options.repairMalformed === true
        ? await findMalformedSummaryRange(context, state)
        : null;
    const start = malformed?.start ?? Math.max(0, state.lastSummarizedMessageIndex + 1);
    const firstIndexInsideRecentWindow = Math.max(0, chat.length - recentMessages);
    const pendingFloors = Math.max(0, firstIndexInsideRecentWindow - start);
    if (!malformed && pendingFloors < batchSize) {
        setSummaryRuntime(context, { phase: 'idle', pendingFloors, error: '' });
        return { created: 0, pendingFloors, ...(overviewUpdated ? { overviewUpdated } : {}) };
    }

    const end = malformed?.end ?? start + batchSize - 1;
    setSummaryRuntime(context, {
        phase: malformed ? 'repairing' : 'summarizing',
        pendingFloors,
        start,
        end,
        error: '',
    });
    const events = await generateSummaryEventsForRange(settings, context, start, end, options);

    const currentContext = options.getCurrentContext?.() ?? context;
    if (getChatId(currentContext) !== chatId || currentContext.chatMetadata !== metadata) {
        setSummaryRuntime(context, { phase: 'idle', pendingFloors, error: '' });
        return { created: 0, pendingFloors, discarded: true };
    }

    const createdAt = new Date().toISOString();
    const order = getSummaryOrder(state.entries, start, end);
    const saved = await upsertSummaryEntry(currentContext, events, start, end, createdAt, order);
    state.entries = state.entries.filter(entry => entry.start !== start || entry.end !== end);
    state.entries.push(saved);
    state.lastSummarizedMessageIndex = Math.max(state.lastSummarizedMessageIndex, end);
    await currentContext.saveMetadata?.();
    if (!overviewUpdated) {
        try {
            const overviewResult = await updateHistoricalOverview(settings, currentContext, options);
            overviewUpdated = overviewResult?.updated ?? 0;
        } catch (error) {
            console.warn('[Memory Augment] Historical overview update failed; detailed summaries remain available.', error);
        }
    }
    await hideSummarizedMessages(
        currentContext,
        start,
        end,
        settings?.context?.recentMessages,
        options.getCurrentContext,
    );
    options.onSaved?.(saved);
    const remainingFloors = Math.max(0, pendingFloors - (end - start + 1));
    setSummaryRuntime(currentContext, {
        phase: remainingFloors >= batchSize ? 'pending' : 'idle',
        pendingFloors: remainingFloors,
        error: '',
    });
    return {
        created: 1,
        pendingFloors: remainingFloors,
        start,
        end,
        ...(overviewUpdated ? { overviewUpdated } : {}),
        ...(malformed ? { repaired: true } : {}),
    };
}

export async function repairMalformedSummaries(settings, context, options = {}) {
    let repaired = 0;
    const state = getSummaryState(context?.chatMetadata);
    const maximumAttempts = Math.min(200, Math.max(20, state?.entries?.length ?? 0));
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
        const state = getSummaryState(context?.chatMetadata);
        if (!state || !await findMalformedSummaryRange(context, state)) break;
        const result = await summarizePendingMessages(settings, context, {
            ...options,
            repairMalformed: true,
        });
        if (!result?.repaired) break;
        repaired++;
    }
    return repaired;
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
                const summaryOptions = {
                    getCurrentContext: () => SillyTavern.getContext(),
                    onSaved: options.onSaved,
                    generateSummary: options.generateSummary,
                };
                let result = null;
                for (let attempt = 0; attempt < MAX_AUTOMATIC_BACKFILL_BATCHES; attempt++) {
                    const activeContext = SillyTavern.getContext();
                    if (getChatId(activeContext) !== chatId) break;
                    result = await summarizePendingMessages(settings, activeContext, summaryOptions);
                    options.onStatus?.();
                    if (result?.created !== 1 || result?.discarded) break;

                    const batchSize = clampInteger(settings?.context?.summaryBatchSize, 15, 1, 50);
                    if (Number(result.pendingFloors) < batchSize) break;
                }
                return result;
            })
            .catch((error) => {
                const activeContext = SillyTavern.getContext();
                if (getChatId(activeContext) === chatId) {
                    setSummaryRuntime(activeContext, {
                        phase: 'error',
                        error: String(error?.message ?? error),
                    });
                    options.onStatus?.();
                }
                console.error('[Memory Augment] Automatic summary generation failed.', error);
            });
    };

    const migrateAndCheck = (targetContext) => {
        const chatId = getChatId(targetContext);
        void migrateLegacySummaries(targetContext)
            .then((migrated) => {
                if (migrated > 0) options.onSaved?.();
                enqueueSummaryCheck(chatId);
            })
            .catch(error => {
                setSummaryRuntime(targetContext, {
                    phase: 'error',
                    error: String(error?.message ?? error),
                });
                options.onStatus?.();
                console.error('[Memory Augment] Legacy summary migration failed.', error);
            });
    };

    // Existing chats may already have a large unsummarized backlog when the
    // extension is installed. Check immediately instead of waiting for the
    // next player message.
    migrateAndCheck(context);

    context.eventSource.on(messageSent, (messageId) => {
        const eventContext = SillyTavern.getContext();
        const sentIndex = Number(messageId);
        const sentMessage = eventContext.chat?.[sentIndex];
        const latestMessage = eventContext.chat?.at?.(-1);
        if (Number.isInteger(sentIndex) && sentMessage) {
            if (sentMessage.is_user !== true) return;
        } else if (latestMessage?.is_user !== true) {
            return;
        }
        enqueueSummaryCheck(getChatId(eventContext));
    });

    if (chatChanged) {
        context.eventSource.on(chatChanged, () => {
            const currentContext = SillyTavern.getContext();
            migrateAndCheck(currentContext);
        });
    }
}
