import { getMapOwnerKey } from './map-atlas.js';
import { loadAssociatedWorldInfoBooks } from './world-info-manager.js';

const SOURCE_CARD = 'character';
const SOURCE_WORLDBOOK = 'worldbook';
const VALID_SOURCES = new Set([SOURCE_CARD, SOURCE_WORLDBOOK]);
let sourceChooser = null;
let sourceChangeHandler = null;
let promptPromise = null;
let baselineUiBound = false;
const dismissedOwners = new Set();

function cleanText(value, maximum = 12000) {
    return String(value ?? '').trim().slice(0, maximum);
}

function getCharacter(context) {
    return context?.characters?.[context?.characterId] ?? null;
}

function hasCharacterOwner(context) {
    return Boolean(getCharacter(context));
}

function ensureDevelopmentSettings(settings) {
    settings.development ??= {};
    settings.development.baselineSourcesByOwner ??= {};
    return settings.development;
}

export function getDevelopmentBaselineOwnerKey(context = {}) {
    return hasCharacterOwner(context) ? getMapOwnerKey(context) : '';
}

export function getDevelopmentBaselineSource(settings, context) {
    const ownerKey = getDevelopmentBaselineOwnerKey(context);
    if (!ownerKey) return '';
    const source = cleanText(ensureDevelopmentSettings(settings).baselineSourcesByOwner[ownerKey], 40);
    return VALID_SOURCES.has(source) ? source : '';
}

export function setDevelopmentBaselineSource(settings, context, source) {
    const ownerKey = getDevelopmentBaselineOwnerKey(context);
    if (!ownerKey) return false;
    const normalized = cleanText(source, 40);
    const sources = ensureDevelopmentSettings(settings).baselineSourcesByOwner;
    const previous = VALID_SOURCES.has(cleanText(sources[ownerKey], 40)) ? sources[ownerKey] : '';
    if (VALID_SOURCES.has(normalized)) sources[ownerKey] = normalized;
    else delete sources[ownerKey];
    dismissedOwners.delete(ownerKey);
    if (previous === (VALID_SOURCES.has(normalized) ? normalized : '')) return false;
    context?.saveSettingsDebounced?.();
    sourceChangeHandler?.(context, previous, normalized);
    return true;
}

function readCharacterCard(context) {
    const character = getCharacter(context);
    if (!character) return null;
    const data = character.data ?? {};
    const fields = [
        ['角色名', character.name ?? data.name],
        ['角色描述', character.description ?? data.description],
        ['性格', character.personality ?? data.personality],
        ['场景设定', character.scenario ?? data.scenario],
    ].map(([label, value]) => [label, cleanText(value, 8000)])
        .filter(([, value]) => value);
    const text = fields.map(([label, value]) => `【${label}】\n${value}`).join('\n\n');
    const boundedText = cleanText(text, 16000);
    return {
        mode: SOURCE_CARD,
        known: Boolean(boundedText),
        sourceLabel: `酒馆角色卡 · ${cleanText(character.name ?? data.name, 120) || '当前角色'}`,
        entries: boundedText ? [{ title: cleanText(character.name ?? data.name, 120) || '当前角色', text: boundedText }] : [],
    };
}

function normalizeName(value) {
    return cleanText(value, 120).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function getImportantCharacterNames(previousStatus, recentMessages) {
    const names = new Set();
    for (const character of previousStatus?.characters ?? []) {
        const name = cleanText(character?.name, 120);
        const role = cleanText(character?.role, 40).toLowerCase();
        if (name && (role === 'user' || role === 'char' || /important|重要/.test(role))) names.add(name);
    }
    for (const message of Array.isArray(recentMessages) ? recentMessages : []) {
        const name = cleanText(message?.name, 120);
        if (name && !/^(user|assistant|system|玩家|角色|ai)$/i.test(name)) names.add(name);
    }
    return [...names];
}

function scoreWorldInfoEntry(entry, names, recentText) {
    const title = normalizeName(entry?.name);
    const keywords = cleanText(entry?.entryKey, 500).split(/[,，|、]/u).map(normalizeName).filter(key => key.length >= 2);
    const contentLead = normalizeName(cleanText(entry?.content, 800));
    const normalizedRecent = normalizeName(recentText);
    let score = 0;
    let matchedKnownCharacter = false;
    for (const nameValue of names) {
        const name = normalizeName(nameValue);
        if (!name) continue;
        if (title === name) {
            score = Math.max(score, 120);
            matchedKnownCharacter = true;
        } else if (title.includes(name) || name.includes(title)) {
            score = Math.max(score, 95);
            matchedKnownCharacter = true;
        }
        if (keywords.some(key => key === name)) {
            score = Math.max(score, 110);
            matchedKnownCharacter = true;
        } else if (keywords.some(key => key.includes(name) || name.includes(key))) {
            score = Math.max(score, 85);
            matchedKnownCharacter = true;
        }
        if (name.length >= 2 && contentLead.includes(name)) {
            score = Math.max(score, 55);
            matchedKnownCharacter = true;
        }
    }
    if (title.length >= 2 && normalizedRecent.includes(title)) score = Math.max(score, 75);
    if (keywords.some(key => normalizedRecent.includes(key))) score = Math.max(score, 65);
    const looksLikeCharacterEntry = /人物|角色|性格|个性|人格|外貌|年龄|身份|关系|习惯|喜好|厌恶|信念|内心|personality|appearance|character|relationship|identity/iu.test(entry?.content ?? '')
        || (/他|她|祂/u.test(entry?.content ?? '') && title.length >= 2 && contentLead.includes(title));
    if (!matchedKnownCharacter && !looksLikeCharacterEntry) return 0;
    return score;
}

async function readWorldbookBaseline(context, previousStatus, recentMessages) {
    const books = (await loadAssociatedWorldInfoBooks(null, context))
        .filter(book => book.linkedToCharacter === true);
    const names = getImportantCharacterNames(previousStatus, recentMessages);
    const recentText = (Array.isArray(recentMessages) ? recentMessages : [])
        .map(message => message?.text ?? '')
        .join('\n');
    const ranked = books.flatMap(book => (book.entries ?? []).map(entry => ({
        book,
        entry,
        score: scoreWorldInfoEntry(entry, names, recentText),
    })))
        .filter(item => item.score > 0)
        .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name, 'zh-CN'))
        .slice(0, 8);
    let remainingCharacters = 18000;
    const selectedEntries = ranked.map(({ book, entry }) => {
        const text = cleanText(entry.content, Math.min(4000, remainingCharacters));
        remainingCharacters -= text.length;
        return { book: book.name, title: entry.name, keys: entry.entryKey, text };
    }).filter(entry => entry.text);
    return {
        mode: SOURCE_WORLDBOOK,
        known: selectedEntries.length > 0,
        sourceLabel: books.length > 0
            ? `关联世界书 · ${books.map(book => book.name).join('、')}`
            : '关联世界书 · 未找到角色关联书',
        searchedNames: names,
        entries: selectedEntries,
        note: selectedEntries.length > 0
            ? '只选取了与当前重要人物明确匹配的条目。'
            : '没有可靠匹配到当前重要人物的设定条目；不得根据身份、阶级、职业或阵营刻板印象推断其原始性格。',
    };
}

export async function getDevelopmentBaselineInfo(settings, context) {
    const source = getDevelopmentBaselineSource(settings, context);
    const books = hasCharacterOwner(context)
        ? (await loadAssociatedWorldInfoBooks(null, context)).filter(book => book.linkedToCharacter === true)
        : [];
    const card = readCharacterCard(context);
    const character = getCharacter(context);
    const cardText = cleanText(character?.description ?? character?.data?.description, 12000);
    const characterName = cleanText(character?.name ?? character?.data?.name, 120);
    const worldLookingCard = /世界观|世界设定|大陆|国家|种族|阵营|势力/u.test(cardText)
        && (!characterName || !cardText.includes(characterName));
    const recommended = books.length > 0 && (worldLookingCard || !cleanText(character?.personality ?? character?.data?.personality))
        ? SOURCE_WORLDBOOK
        : SOURCE_CARD;
    return { source, recommended, linkedBookCount: books.length, linkedBookNames: books.map(book => book.name), cardKnown: card?.known === true };
}

export async function ensureDevelopmentBaselineSource(settings, context) {
    const existing = getDevelopmentBaselineSource(settings, context);
    if (existing) return existing;
    const ownerKey = getDevelopmentBaselineOwnerKey(context);
    if (!ownerKey || dismissedOwners.has(ownerKey) || typeof sourceChooser !== 'function') return '';
    if (promptPromise) return promptPromise;
    promptPromise = (async () => {
        const info = await getDevelopmentBaselineInfo(settings, context);
        const selected = await sourceChooser(info, context);
        if (getDevelopmentBaselineOwnerKey(context) !== ownerKey) return '';
        if (VALID_SOURCES.has(selected)) {
            setDevelopmentBaselineSource(settings, context, selected);
            refreshDevelopmentBaselineUi(settings, context);
            return selected;
        }
        dismissedOwners.add(ownerKey);
        return '';
    })().catch((error) => {
        console.warn('[Memory Augment] Character baseline selection failed.', error);
        return '';
    }).finally(() => {
        promptPromise = null;
    });
    return promptPromise;
}

export async function buildCharacterBaselines(settings, context, { previousStatus = null, recentMessages = [] } = {}) {
    const source = getDevelopmentBaselineSource(settings, context);
    if (source === SOURCE_CARD) return readCharacterCard(context);
    if (source === SOURCE_WORLDBOOK) return readWorldbookBaseline(context, previousStatus, recentMessages);
    if (!hasCharacterOwner(context)) {
        return { mode: 'unknown', known: null, sourceLabel: '测试或未知角色环境', entries: [] };
    }
    return null;
}

export async function refreshDevelopmentBaselineUi(settings, context = globalThis.SillyTavern?.getContext?.()) {
    if (typeof document === 'undefined') return;
    const select = document.querySelector('#memory_augment_development_baseline_source');
    const status = document.querySelector('#memory_augment_development_baseline_status');
    if (!select || !status) return;
    const info = await getDevelopmentBaselineInfo(settings, context ?? {});
    select.value = info.source;
    select.disabled = !getDevelopmentBaselineOwnerKey(context ?? {});
    status.textContent = info.source === SOURCE_CARD
        ? '当前角色使用酒馆角色卡作为故事开始前的人物基准。'
        : info.source === SOURCE_WORLDBOOK
            ? `当前角色使用关联世界书作为人物基准；每次只读取与当前重要人物匹配的条目。${info.linkedBookCount ? ` 已关联：${info.linkedBookNames.join('、')}。` : ' 当前没有找到关联世界书。'}`
            : `尚未选择。首次需要判断人物变化时会请你确认；当前建议使用${info.recommended === SOURCE_WORLDBOOK ? '关联世界书' : '酒馆角色卡'}。`;
}

export function initializeDevelopmentBaselineUi(settings, context, options = {}) {
    sourceChooser = options.chooseSource ?? sourceChooser;
    sourceChangeHandler = options.onSourceChanged ?? sourceChangeHandler;
    void refreshDevelopmentBaselineUi(settings, context);
    if (typeof document === 'undefined' || baselineUiBound) return;
    document.querySelector('#memory_augment_development_baseline_source')?.addEventListener('change', (event) => {
        const current = globalThis.SillyTavern?.getContext?.() ?? context;
        setDevelopmentBaselineSource(settings, current, event.currentTarget?.value);
        void refreshDevelopmentBaselineUi(settings, current);
    });
    const chatChanged = context?.eventTypes?.CHAT_CHANGED ?? context?.event_types?.CHAT_CHANGED;
    if (chatChanged) context.eventSource?.on?.(chatChanged, () => setTimeout(() => void refreshDevelopmentBaselineUi(settings), 0));
    baselineUiBound = true;
}

export { SOURCE_CARD, SOURCE_WORLDBOOK };
