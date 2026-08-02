import { generateSummary as generateSummaryWithSideApi } from './rag-client.js';
import { getMessageTimelineMetadata } from './story-status.js';

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
    const settingsUpdated = context?.eventTypes?.WORLDINFO_SETTINGS_UPDATED
        ?? context?.event_types?.WORLDINFO_SETTINGS_UPDATED;
    if (settingsUpdated) await context.eventSource?.emit?.(settingsUpdated);
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

    if (data && typeof context?.saveWorldInfo === 'function') {
        let keptUid;
        let keptEntry;
        if (matches.length > 0) {
            [keptUid, keptEntry] = matches[0];
        } else if (typeof context?.createWorldInfoEntry === 'function') {
            keptEntry = await context.createWorldInfoEntry(bookName, data);
            keptUid = keptEntry?.uid;
        } else {
            const worldModule = await import('../../../world-info.js');
            keptEntry = worldModule.createWorldInfoEntry(bookName, data);
            keptUid = keptEntry?.uid;
        }
        if (!keptEntry || keptUid === undefined || keptUid === null) {
            throw new Error(`创建摘要世界书条目失败：${key}`);
        }
        keptEntry.key = [key];
        keptEntry.comment = key;
        keptEntry.addMemo = true;
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
    await configureSummaryEntry(context, bookName, uid);
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

const COMPLETE_SENTENCE_END = /[。！？…!?；;.!」』）)】]$/u;
const REFUSAL_OR_DRAFT_PATTERN = /(?:抱歉|对不起|无法|不能|不便).{0,30}(?:总结|概括|处理|协助|提供)|(?:内容|题材).{0,20}(?:敏感|不当|违规)|作为(?:一个)?AI|\b(?:drafting|analyzing|analysis|we need|i cannot|i can't|sorry)\b/i;

export function isUnusableSummaryOutput(output) {
    const text = String(output ?? '').trim();
    return !text || REFUSAL_OR_DRAFT_PATTERN.test(text);
}

function normalizeOverview(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const characters = Array.from(text);
    if (characters.length > 150) return `${characters.slice(0, 149).join('')}…`;
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
    const blocks = headers.slice(0, 8).map((header, index) => {
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
    }).filter(Boolean);

    if (events.length > 0) {
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
        .slice(0, 8)
        .map(formatEventContent)
        .join('\n\n');
}

export function isMalformedSummaryContent(content) {
    const text = String(content ?? '').trim();
    return isUnusableSummaryOutput(text)
        || /\[事件\s*\d+\]|(?:重要度|事件概述)\s*[：:]/.test(text)
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
        `以下${end - start + 1}楼只是本次处理窗口，不是事件边界。请按剧情自然发生的事件提取1-8个关键事件，按重要度从高到低排列。跨楼的同一事件应合并；同一楼若发生时间跳跃，应拆成不同事件。每个事件严格按以下格式输出，不要输出其他内容：`,
        '',
        '[事件1]',
        '重要度：X（1-5，5为最重要）',
        '事件概述：（最多150字，抓取核心骨干和重要细节，忽略氛围描写和无关对话）',
        '时间：（优先复制下方时间锚点；未明确就写“未明确”，禁止把历史中的相对时间按总结时的现在重算）',
        '地点：（事件发生的地点）',
        '涉及角色：（角色名，逗号分隔；放在最后）',
        '',
        '[事件2]',
        '...',
        '',
        '评判标准：',
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
        `概括下面第${start + 1}-${end + 1}楼发生的关键事件。`,
        '上一次结构化回答被意外截断，这次只输出一段完整的中文事件概述，最多150字。',
        '不要输出标题、序号、字段名、角色名单或解释；宁可简短，也必须把核心事件写完整。',
        '保留原剧情中的时间关系；楼层数不代表时间流逝，不能自行把“三天前”改成“昨天”。',
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
    for (const entry of Object.values(data?.entries ?? {})) {
        if (!isManagedSummaryEntry(entry)) continue;
        const guardedContent = guardHistoricalSummaryTimes(entry.content);
        if (guardedContent !== String(entry.content ?? '')) {
            entry.content = guardedContent;
            worldInfoChanged = true;
            migrated++;
        }
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
    const malformed = options.repairMalformed === true
        ? await findMalformedSummaryRange(context, state)
        : null;
    const start = malformed?.start ?? Math.max(0, state.lastSummarizedMessageIndex + 1);
    const firstIndexInsideRecentWindow = Math.max(0, chat.length - recentMessages);
    const pendingFloors = Math.max(0, firstIndexInsideRecentWindow - start);
    if (!malformed && pendingFloors < batchSize) {
        return { created: 0, pendingFloors };
    }

    const end = malformed?.end ?? start + batchSize - 1;
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

    const currentContext = options.getCurrentContext?.() ?? context;
    if (getChatId(currentContext) !== chatId || currentContext.chatMetadata !== metadata) {
        return { created: 0, pendingFloors, discarded: true };
    }

    const createdAt = new Date().toISOString();
    const saved = await upsertSummaryEntry(currentContext, events, start, end, createdAt);
    state.entries = state.entries.filter(entry => entry.start !== start || entry.end !== end);
    state.entries.push(saved);
    state.lastSummarizedMessageIndex = Math.max(state.lastSummarizedMessageIndex, end);
    await currentContext.saveMetadata?.();
    await hideSummarizedMessages(
        currentContext,
        start,
        end,
        settings?.context?.recentMessages,
        options.getCurrentContext,
    );
    options.onSaved?.(saved);
    return {
        created: 1,
        pendingFloors: Math.max(0, pendingFloors - (end - start + 1)),
        start,
        end,
        ...(malformed ? { repaired: true } : {}),
    };
}

export async function repairMalformedSummaries(settings, context, options = {}) {
    let repaired = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
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
                return summarizePendingMessages(settings, currentContext, summaryOptions);
            })
            .catch((error) => {
                console.error('[Memory Augment] Automatic summary generation failed.', error);
            });
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
