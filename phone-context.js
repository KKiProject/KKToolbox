import { retrieveAndInject } from './context-manager.js';
import {
    applyStoryStatusOptions,
    formatStoryStatusMessage,
    getLatestStoryStatus,
    getMessageTimelineMetadata,
} from './story-status.js';
import { formatCharacterDevelopmentMessage } from './character-development.js';
import { buildRelevantMapText, getMapAtlas } from './map-atlas.js';
import { normalizeBaseUrl } from './api-utils.js';
import { recallPhoneMemoryEvents } from './phone-memory-recall.js';
import { cleanPhoneText as cleanText } from './phone-utils.js';

const RECALL_MARKER = 'memory_augment_recall_type';

function uniqueText(values, maximum = 32000) {
    const seen = new Set();
    const result = [];
    let length = 0;
    for (const value of values) {
        const text = cleanText(value, maximum);
        if (!text || seen.has(text)) continue;
        const remaining = maximum - length;
        if (remaining <= 0) break;
        const part = text.slice(0, remaining);
        result.push(part);
        seen.add(text);
        length += part.length;
    }
    return result.join('\n\n');
}

function getCharacter(context) {
    return context?.characters?.[context?.characterId] ?? null;
}

function getEmbeddingConfig(settings) {
    const raw = settings?.apis?.embedding ?? {};
    const config = {
        baseUrl: normalizeBaseUrl(raw?.url ?? raw?.baseUrl),
        apiKey: cleanText(raw?.apiKey, 2000),
        model: cleanText(raw?.model, 500),
    };
    return config.baseUrl && config.apiKey && config.model ? config : null;
}

function getCharacterFields(context) {
    const character = getCharacter(context);
    const data = character?.data ?? {};
    return {
        userName: cleanText(context?.name1, 120) || '玩家',
        characterName: cleanText(character?.name ?? data?.name ?? context?.name2, 120) || '当前角色',
        description: cleanText(character?.description ?? data?.description, 12000),
        personality: cleanText(character?.personality ?? data?.personality, 8000),
        scenario: cleanText(character?.scenario ?? data?.scenario, 10000),
        creatorNotes: cleanText(data?.creator_notes ?? character?.creator_notes, 6000),
    };
}

export function buildPhoneRetrievalQuery(snapshot = {}, recentStory = []) {
    const conversation = snapshot?.conversation ?? {};
    const messages = (Array.isArray(snapshot?.messageRecords) && snapshot.messageRecords.length > 0
        ? snapshot.messageRecords.map(item => item?.text)
        : snapshot?.messages ?? [])
        .map(item => cleanText(item, 1200))
        .filter(Boolean)
        .slice(-5);
    const story = (Array.isArray(recentStory) ? recentStory : [])
        .map(item => cleanText(item, 1200))
        .filter(Boolean)
        .slice(-2);
    return [
        `手机会话：${cleanText(conversation?.name, 160) || '未命名会话'}`,
        messages.length > 0 ? `最近手机消息：\n${messages.join('\n')}` : '',
        story.length > 0 ? `最近线下剧情：\n${story.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
}

export function buildPhoneStoryFoundation(context, personaDescription = '') {
    const fields = getCharacterFields(context);
    return [
        '【故事基础设定】',
        `玩家：${fields.userName}`,
        personaDescription ? `【玩家人设】\n${cleanText(personaDescription, 8000)}` : '',
        `主要角色／当前角色卡：${fields.characterName}`,
        fields.description ? `【角色描述或世界基础】\n${fields.description}` : '',
        fields.personality ? `【初始性格】\n${fields.personality}` : '',
        fields.scenario ? `【初始场景与背景】\n${fields.scenario}` : '',
        fields.creatorNotes ? `【创作者补充】\n${fields.creatorNotes}` : '',
    ].filter(Boolean).join('\n\n');
}

function collectActivatedWorldInfo(result, substitute) {
    if (!result || typeof result !== 'object') return '';
    const values = [result.worldInfoBefore, result.worldInfoAfter];
    for (const entry of result.worldInfoExamples ?? []) values.push(entry?.content);
    for (const group of result.worldInfoDepth ?? []) values.push(...(group?.entries ?? []));
    for (const entry of result.anBefore ?? []) values.push(entry?.content ?? entry);
    for (const entry of result.anAfter ?? []) values.push(entry?.content ?? entry);
    return uniqueText(values.map(value => substitute(cleanText(value, 16000))), 24000);
}

async function loadRuntimeHelpers(clients = {}) {
    if (clients.getWorldInfoPrompt || clients.getPowerUser || clients.getMaxContextSize) {
        return {
            getWorldInfoPrompt: clients.getWorldInfoPrompt,
            getMaxContextSize: clients.getMaxContextSize,
            powerUser: clients.getPowerUser?.() ?? clients.powerUser ?? {},
            substituteParams: clients.substituteParams,
        };
    }
    const [worldModule, scriptModule, powerModule] = await Promise.all([
        import('../../../world-info.js'),
        import('../../../../script.js'),
        import('../../../power-user.js'),
    ]);
    return {
        getWorldInfoPrompt: worldModule.getWorldInfoPrompt,
        getMaxContextSize: scriptModule.getMaxContextSize,
        powerUser: powerModule.power_user ?? {},
        substituteParams: scriptModule.substituteParams,
    };
}

function getWorldInfoScanMessages(query, snapshot, recentStory) {
    const phoneMessages = (Array.isArray(snapshot?.messageRecords) && snapshot.messageRecords.length > 0
        ? snapshot.messageRecords.map(item => item?.text)
        : snapshot?.messages ?? [])
        .map(item => cleanText(item, 3000))
        .filter(Boolean)
        .slice(-30)
        .reverse();
    const storyMessages = (Array.isArray(recentStory) ? recentStory : [])
        .map(item => cleanText(item, 3000))
        .filter(Boolean)
        .slice(-8)
        .reverse();
    return [query, ...phoneMessages, ...storyMessages].filter(Boolean);
}

async function collectWorldInfoContext({ context, snapshot, recentStory, query, helpers }) {
    if (typeof helpers.getWorldInfoPrompt !== 'function') return '';
    const fields = getCharacterFields(context);
    const maxContext = Math.max(2048, Math.trunc(Number(helpers.getMaxContextSize?.()) || 32768));
    const globalScanData = {
        personaDescription: cleanText(helpers.powerUser?.persona_description, 12000),
        characterDescription: fields.description,
        characterPersonality: fields.personality,
        characterDepthPrompt: '',
        scenario: fields.scenario,
        creatorNotes: fields.creatorNotes,
    };
    const result = await helpers.getWorldInfoPrompt(
        getWorldInfoScanMessages(query, snapshot, recentStory),
        maxContext,
        true,
        globalScanData,
    );
    const substitute = value => {
        if (typeof helpers.substituteParams === 'function') {
            try {
                return helpers.substituteParams(value, fields.userName, fields.characterName);
            } catch {
                // Fall through to the two common substitutions.
            }
        }
        return value
            .replace(/{{user}}/gi, fields.userName)
            .replace(/{{char}}/gi, fields.characterName);
    };
    return collectActivatedWorldInfo(result, substitute);
}

async function collectRecalledPhoneMemory({ settings, store, snapshot, query, clients }) {
    const embedding = getEmbeddingConfig(settings);
    const events = await recallPhoneMemoryEvents({
        store,
        query,
        embedding,
        topK: 5,
        excludeIds: (snapshot?.activeMemory ?? []).map(item => item?.id),
        sync: clients.syncPhoneMemory,
        search: clients.searchPhoneMemory,
    });
    return uniqueText(events.map(event => {
        const state = event.status === 'resolved' ? '已解决' : event.status === 'active' ? '仍有效' : '历史事实';
        return `[${state}] ${cleanText(event.summary, 1000)}`;
    }), 8000);
}

function collectDerivedStoryContext(settings, context) {
    let storyStatus = '';
    const statusOptions = settings?.status ?? {};
    if (statusOptions.enabled === true) {
        const record = getLatestStoryStatus(context);
        const timeline = record ? getMessageTimelineMetadata(context, record.messageId) : null;
        storyStatus = formatStoryStatusMessage(
            applyStoryStatusOptions(record?.status, statusOptions),
            timeline,
        )?.content ?? '';
    }

    const characterDevelopment = settings?.development?.enabled === false
        ? ''
        : formatCharacterDevelopmentMessage(context)?.content ?? '';

    let mapContext = '';
    if (settings?.map?.includeInPrompt !== false) {
        const atlas = getMapAtlas(settings, context);
        const location = getLatestStoryStatus(context)?.status?.environment?.location ?? '';
        if (atlas) mapContext = buildRelevantMapText(atlas, location);
    }
    return { storyStatus, characterDevelopment, mapContext };
}

/**
 * Builds generation-only story context for a phone API call. Every source is
 * isolated so a broken vector store or lorebook scan never blocks messaging.
 */
export async function preparePhoneStoryContext(payload = {}, clients = {}) {
    const settings = payload?.settings ?? {};
    const context = payload?.context ?? {};
    const snapshot = payload?.snapshot ?? {};
    const store = payload?.store ?? {};
    const recentStory = payload?.recentStory ?? [];
    const query = buildPhoneRetrievalQuery(snapshot, recentStory);
    let helpers = { powerUser: clients.powerUser ?? {} };
    try {
        helpers = await loadRuntimeHelpers(clients);
    } catch (error) {
        console.warn('[Memory Augment] Phone runtime context helpers are unavailable.', error);
    }

    const retrieveStoryContext = async () => {
        if (!query) return '';
        try {
            const queryChat = [{ role: 'user', is_user: true, is_system: false, content: query, mes: query }];
            await (clients.retrieveAndInject ?? retrieveAndInject)(
                queryChat,
                settings,
                context,
                clients.retrievalClients ?? {},
            );
            return uniqueText(queryChat
                .filter(message => message?.extra?.[RECALL_MARKER])
                .map(message => message?.content ?? message?.mes), 32000);
        } catch (error) {
            console.warn('[Memory Augment] Phone story RAG failed; recent story remains available.', error);
            return '';
        }
    };
    const retrieveWorldInfo = async () => {
        try {
            return await collectWorldInfoContext({ context, snapshot, recentStory, query, helpers });
        } catch (error) {
            console.warn('[Memory Augment] Phone world-info scan failed; semantic and identity context remain available.', error);
            return '';
        }
    };
    const retrievePhoneMemory = async () => {
        try {
            return await collectRecalledPhoneMemory({ settings, store, snapshot, query, clients });
        } catch (error) {
            console.warn('[Memory Augment] Phone online-memory recall failed; recent phone messages remain available.', error);
            return '';
        }
    };
    const [retrievedContext, activatedWorldInfo, phoneMemoryContext] = await Promise.all([
        retrieveStoryContext(),
        retrieveWorldInfo(),
        retrievePhoneMemory(),
    ]);

    const derived = collectDerivedStoryContext(settings, context);
    return {
        query,
        storyFoundation: buildPhoneStoryFoundation(context, helpers.powerUser?.persona_description),
        retrievedContext,
        activatedWorldInfo,
        phoneMemoryContext,
        ...derived,
    };
}
