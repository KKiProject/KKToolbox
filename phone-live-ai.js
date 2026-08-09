import { generateLiveCompletion } from './rag-client.js';
import { buildPhoneLiveRecord, normalizePhoneLiveState } from './phone-live.js';
import { getPhoneChatId } from './phone-store.js';
import { cleanPhoneText as text } from './phone-utils.js';

function clone(value) {
    return typeof globalThis.structuredClone === 'function'
        ? globalThis.structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function makeId(prefix) {
    const value = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    return `${prefix}-${value}`;
}

function parseJsonObject(raw) {
    const source = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try {
        const parsed = JSON.parse(source);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('结果不是 JSON 对象');
        return parsed;
    } catch (error) {
        const wrapped = new Error(`直播 API 返回了损坏的 JSON：${error.message}`);
        wrapped.cause = error;
        wrapped.rawResponse = source;
        throw wrapped;
    }
}

function integer(value, label, { minimum = 0, maximum = 100_000_000 } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label}必须是数字。`);
    return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function requiredText(value, label, maximum = 500) {
    const result = text(value, maximum);
    if (!result) throw new Error(`${label}不能为空。`);
    return result;
}

function normalizeScene(value, index, phaseId, request) {
    const kind = value?.kind === 'dialogue' ? 'dialogue' : 'narration';
    const speakerType = ['player', 'participant', 'host', 'guest'].includes(value?.speakerType)
        ? value.speakerType
        : kind === 'dialogue' ? 'guest' : '';
    return {
        id: text(value?.id, 120) || `${phaseId}-scene-${index + 1}`,
        kind,
        segment: requiredText(value?.segment, `第 ${index + 1} 幕的阶段名`, 80),
        text: requiredText(value?.text, `第 ${index + 1} 幕的内容`, 800),
        ...(kind === 'dialogue' ? {
            speaker: requiredText(value?.speaker, `第 ${index + 1} 幕的说话人`, 60),
            speakerRole: text(value?.speakerRole, 60) || (speakerType === 'player' ? '主播' : '直播参与者'),
            speakerType,
        } : {}),
    };
}

function normalizeBarrage(value, index, phaseId) {
    return {
        id: text(value?.id, 120) || `${phaseId}-barrage-${index + 1}`,
        author: requiredText(value?.author, `第 ${index + 1} 条弹幕作者`, 60),
        content: requiredText(value?.content, `第 ${index + 1} 条弹幕内容`, 160),
        likes: integer(value?.likes ?? 0, `第 ${index + 1} 条弹幕点赞数`, { maximum: 10_000_000 }),
        replyable: value?.replyable !== false,
    };
}

function normalizeGift(value, index, phaseId) {
    return {
        id: text(value?.id, 120) || `${phaseId}-gift-${index + 1}`,
        author: requiredText(value?.author, `第 ${index + 1} 个礼物赠送者`, 60),
        label: requiredText(value?.label, `第 ${index + 1} 个礼物名称`, 60),
        icon: text(value?.icon, 8) || '🎁',
        value: integer(value?.value ?? 1, `第 ${index + 1} 个礼物价值`, { maximum: 1_000_000 }),
    };
}

export function parsePhoneLiveAiPhase(raw, request = {}) {
    const parsed = parseJsonObject(raw);
    const phaseValue = parsed.phase && typeof parsed.phase === 'object' ? parsed.phase : {};
    const phaseId = text(phaseValue.id, 120) || makeId('live-phase');
    const sceneValues = Array.isArray(phaseValue.scenes) ? phaseValue.scenes : [];
    if (sceneValues.length < 2 || sceneValues.length > 8) throw new Error('每个直播阶段必须生成 2–8 幕。');
    const barrageValues = Array.isArray(phaseValue.barrages) ? phaseValue.barrages : [];
    if (barrageValues.length < 8 || barrageValues.length > 20) throw new Error('每个直播阶段必须生成 8–20 条弹幕。');
    const scenes = sceneValues.map((scene, index) => normalizeScene(scene, index, phaseId, request));
    const playerSpeech = text(request.operation?.speech, 500);
    if (playerSpeech) {
        scenes.unshift({
            id: `${phaseId}-player-speech`,
            kind: 'dialogue',
            segment: request.mode === 'end' ? '准备下播' : '主播发言',
            text: playerSpeech,
            speaker: text(request.profile?.nickname, 60) || '我',
            speakerRole: '主播',
            speakerType: 'player',
        });
    }
    const roomValue = parsed.room && typeof parsed.room === 'object' ? parsed.room : {};
    const room = request.mode === 'start' ? {
        title: requiredText(roomValue.title || request.operation?.title, '直播标题', 120),
        summary: requiredText(roomValue.summary, '直播简介', 300),
        cover: text(roomValue.cover, 80) || '我的直播间',
        initialViewers: integer(roomValue.initialViewers, '初始在线人数', { maximum: 100_000_000 }),
    } : null;
    const gifts = (Array.isArray(phaseValue.gifts) ? phaseValue.gifts : []).slice(0, 5)
        .map((gift, index) => normalizeGift(gift, index, phaseId));
    const phase = {
        id: phaseId,
        mode: request.mode,
        scenes: scenes.slice(0, 9),
        barrages: barrageValues.map((item, index) => normalizeBarrage(item, index, phaseId)),
        gifts,
        viewerDelta: integer(Math.abs(Number(phaseValue.viewerDelta) || 0), '在线人数变化', { maximum: 10_000_000 })
            * (Number(phaseValue.viewerDelta) < 0 ? -1 : 1),
        followerDelta: integer(Math.abs(Number(phaseValue.followerDelta) || 0), '粉丝变化', { maximum: 10_000_000 })
            * (Number(phaseValue.followerDelta) < 0 ? -1 : 1),
        summary: requiredText(phaseValue.summary, '本阶段摘要', 400),
        selectedBarrageIds: (Array.isArray(request.operation?.selectedBarrages) ? request.operation.selectedBarrages : [])
            .map(item => text(item?.id, 120)).filter(Boolean),
        createdAt: Number(request.now) || Date.now(),
    };
    return {
        room,
        phase,
        sessionSummary: requiredText(parsed.sessionSummary, '整场直播摘要', 800),
    };
}

export function applyPhoneLiveAiPhase(state, batch, request = {}) {
    const working = clone(state);
    working.ownLive ??= {};
    const own = working.ownLive;
    if (request.mode === 'start') {
        own.status = 'live';
        own.sessionId = text(request.operation?.sessionId, 120) || makeId('own-live');
        own.setup = clone(request.operation ?? {});
        own.title = batch.room.title;
        own.summary = batch.room.summary;
        own.cover = batch.room.cover;
        own.phases = [];
        own.viewerCount = batch.room.initialViewers;
        own.peakViewers = batch.room.initialViewers;
        own.followerDelta = 0;
        own.giftTotal = 0;
        own.startedAt = Number(request.now) || Date.now();
        own.endedAt = 0;
    } else if (own.status !== 'live') {
        throw new Error('当前没有正在进行的自己的直播。');
    }
    if (own.phases.some(phase => phase.id === batch.phase.id)) throw new Error('直播阶段 ID 重复，未保存本次结果。');
    own.phases.push(batch.phase);
    own.phases = own.phases.slice(-20);
    own.viewerCount = Math.max(0, Math.trunc(Number(own.viewerCount) || 0) + batch.phase.viewerDelta);
    own.peakViewers = Math.max(Math.trunc(Number(own.peakViewers) || 0), own.viewerCount);
    own.followerDelta = Math.trunc(Number(own.followerDelta) || 0) + batch.phase.followerDelta;
    own.giftTotal = Math.max(0, Math.trunc(Number(own.giftTotal) || 0)
        + batch.phase.gifts.reduce((total, gift) => total + gift.value, 0));
    own.sessionSummary = batch.sessionSummary;
    own.generating = false;
    own.lastError = '';
    if (request.mode === 'end') {
        own.status = 'ended';
        own.endedAt = Number(request.now) || Date.now();
        own.records = Array.isArray(own.records) ? own.records : [];
        const record = buildPhoneLiveRecord(own);
        if (record && !own.records.some(item => item.sessionId === record.sessionId)) {
            own.records.push(record);
        }
    }
    Object.keys(state).forEach(key => delete state[key]);
    Object.assign(state, working);
    return { state, ownLive: state.ownLive, phase: batch.phase };
}

export function isPhoneLiveAiReady(settings = {}) {
    const api = settings?.apis?.barrage;
    return Boolean(text(api?.url, 2000) && text(api?.apiKey, 4000) && text(api?.model, 500));
}

export function buildPhoneLiveAiRequest(settings, context, operation = {}, options = {}) {
    const state = normalizePhoneLiveState(settings);
    const mode = ['start', 'next', 'end'].includes(operation?.type) ? operation.type : '';
    if (!mode) throw new Error('不支持的直播操作。');
    const participantIds = new Set((Array.isArray(operation.participantIds)
        ? operation.participantIds
        : state.ownLive.setup?.participantIds ?? []).map(String));
    const participants = (settings.phone?.weibo?.roleAccounts ?? [])
        .filter(account => participantIds.has(String(account.id)) && account.identity?.mode !== 'unbound')
        .map(account => ({
            id: text(account.id, 120),
            nickname: text(account.nickname, 60),
            bio: text(account.bio, 300),
            identity: {
                label: text(account.identity?.label, 100),
                persona: text(account.identity?.persona, 8000),
                note: text(account.identity?.note, 2000),
            },
        }));
    const latestStory = [...(Array.isArray(context?.chat) ? context.chat : [])].reverse()
        .find(message => !message?.is_user && !message?.is_system);
    return {
        mode,
        chatId: getPhoneChatId(context),
        operation: clone(operation),
        profile: clone(settings.phone?.live?.profile ?? settings.phone?.profile ?? { nickname: '我', avatar: '' }),
        userPersona: text(settings.phone?.live?.profile?.persona, 12_000) || text(context?.powerUser?.persona_description
            ?? context?.power_user?.persona_description
            ?? globalThis.power_user?.persona_description, 12_000),
        participants,
        setup: mode === 'start' ? clone(operation) : clone(state.ownLive.setup ?? {}),
        sessionSummary: text(state.ownLive.sessionSummary, 800),
        recentPhases: (state.ownLive.phases ?? []).slice(-2).map(phase => ({
            summary: text(phase.summary, 400),
            scenes: (phase.scenes ?? []).map(scene => `${scene.speaker ? `${scene.speaker}：` : ''}${text(scene.text, 300)}`),
            barrages: (phase.barrages ?? []).slice(0, 12).map(item => `${item.author}：${item.content}`),
        })),
        storyText: text(latestStory?.mes ?? latestStory?.content, 20_000),
        storyContext: clone(options.storyContext ?? {}),
        now: Number(options.now) || Date.now(),
    };
}

export async function requestPhoneLiveOperation(settings, context, operation, options = {}) {
    if (!isPhoneLiveAiReady(settings)) throw new Error('请先配置弹幕/手机共用的 API。');
    const request = buildPhoneLiveAiRequest(settings, context, operation, options);
    const state = settings.phone.live;
    state.ownLive.generating = true;
    state.ownLive.lastError = '';
    await options.saveSettings?.();
    try {
        const generate = options.generateLive ?? generateLiveCompletion;
        const response = await generate({
            barrage: settings.apis.barrage,
            maxTokens: Math.max(4096, Math.min(12_000, Math.trunc(Number(settings.phone?.live?.generationMaxTokens) || 8192))),
            request,
        });
        const batch = parsePhoneLiveAiPhase(response?.content, request);
        const result = applyPhoneLiveAiPhase(state, batch, request);
        await options.saveSettings?.();
        return result;
    } catch (error) {
        state.ownLive.generating = false;
        state.ownLive.lastError = text(error?.message, 500);
        await options.saveSettings?.();
        throw error;
    }
}
