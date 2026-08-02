export const STORY_STATUS_METADATA_KEY = 'memory_augment_story_statuses';
export const STORY_TIMELINE_METADATA_KEY = 'memory_augment_story_timeline';

const STORY_STATUS_MARKER = 'memory_augment_story_status';
const TIMELINE_TRANSITIONS = new Set(['unchanged', 'advance', 'jump', 'enter_flashback', 'return_mainline', 'unknown']);
const TIMELINE_MODES = new Set(['mainline', 'flashback', 'flashforward', 'mention', 'unknown']);
let statusUiBound = false;

export function shouldShowStoryFloatingButton(options) {
    return options?.showFloatingButton !== false;
}

function cleanText(value, maximum = 1200) {
    return String(value ?? '').trim().slice(0, maximum);
}

function cleanList(value) {
    const source = Array.isArray(value) ? value : cleanText(value) ? [value] : [];
    return source.map(item => cleanText(item, 500)).filter(Boolean);
}

export function normalizeTimelineUpdate(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const transitionValue = cleanText(source.transition ?? source.change ?? source.时间变化, 40).toLowerCase();
    const transition = TIMELINE_TRANSITIONS.has(transitionValue) ? transitionValue : 'unknown';
    const rawSegments = Array.isArray(source.segments ?? source.时间段) ? (source.segments ?? source.时间段) : [];
    const segments = rawSegments.map((segment) => {
        if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return null;
        const modeValue = cleanText(segment.mode ?? segment.类型, 40).toLowerCase();
        const mode = TIMELINE_MODES.has(modeValue) ? modeValue : 'unknown';
        const messageId = Number(segment.messageId ?? segment.message_id ?? segment.楼层);
        const normalized = {
            messageId: Number.isInteger(messageId) ? messageId : null,
            startQuote: cleanText(segment.startQuote ?? segment.start_quote ?? segment.开始原文, 160),
            time: cleanText(segment.time ?? segment.时间, 300),
            relation: cleanText(segment.relation ?? segment.relationToMainline ?? segment.与主线关系, 300),
            mode,
        };
        return normalized.startQuote || normalized.time || normalized.relation ? normalized : null;
    }).filter(Boolean).slice(0, 24);
    return {
        transition,
        currentTime: cleanText(source.currentTime ?? source.current_time ?? source.当前场景时间, 300),
        mainlineTime: cleanText(source.mainlineTime ?? source.mainline_time ?? source.主线现在, 300),
        elapsed: cleanText(source.elapsed ?? source.delta ?? source.经过时间, 300),
        evidence: cleanText(source.evidence ?? source.依据, 500),
        segments,
    };
}

function getTimelineStore(metadata, create = false) {
    const existing = metadata?.[STORY_TIMELINE_METADATA_KEY];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        existing.version = 1;
        existing.anchors ??= {};
        existing.messageStates ??= {};
        existing.messageSegments ??= {};
        return existing;
    }
    if (!create || !metadata || typeof metadata !== 'object') return null;
    metadata[STORY_TIMELINE_METADATA_KEY] = { version: 1, anchors: {}, messageStates: {}, messageSegments: {} };
    return metadata[STORY_TIMELINE_METADATA_KEY];
}

function isValidTimelineMessage(context, messageId, record) {
    const message = context?.chat?.[Number(messageId)];
    return Boolean(message && !message.is_user && !message.is_system
        && (!record?.sourceHash || record.sourceHash === hashStorySource(message.mes)));
}

export function getLatestStoryTimeline(context, { beforeMessageId = Number.POSITIVE_INFINITY } = {}) {
    const store = getTimelineStore(context?.chatMetadata);
    if (!store) return null;
    const ids = Object.keys(store.messageStates)
        .map(Number)
        .filter(id => Number.isInteger(id) && id < beforeMessageId)
        .sort((left, right) => right - left);
    for (const messageId of ids) {
        const state = store.messageStates[String(messageId)];
        if (!isValidTimelineMessage(context, messageId, state)) continue;
        return { messageId, state, store };
    }
    return null;
}

function makeTimelineAnchor(store, messageId, suffix, values) {
    let id = `t${messageId}-${suffix}`;
    let duplicate = 2;
    while (store.anchors[id]) id = `t${messageId}-${suffix}-${duplicate++}`;
    store.anchors[id] = {
        id,
        label: cleanText(values?.label, 300) || '时间未明确',
        mode: TIMELINE_MODES.has(values?.mode) ? values.mode : 'unknown',
        relativeTo: cleanText(values?.relativeTo, 120),
        relation: cleanText(values?.relation, 300),
        sourceMessageId: Number(messageId),
    };
    return id;
}

export function applyStoryTimelineUpdate(context, messageId, status, update, sourceHash = '') {
    const numericId = Number(messageId);
    const normalizedStatus = normalizeStoryStatus(status);
    if (!Number.isInteger(numericId) || !normalizedStatus) return { status: normalizedStatus, timeline: null };
    const store = getTimelineStore(context?.chatMetadata, true);
    const previous = getLatestStoryTimeline(context, { beforeMessageId: numericId });
    const timelineUpdate = normalizeTimelineUpdate(update);
    const previousScene = previous?.store?.anchors?.[previous.state.sceneAnchorId];
    const previousMainline = previous?.store?.anchors?.[previous.state.mainlineAnchorId];
    let sceneAnchorId = previous?.state?.sceneAnchorId ?? '';
    let mainlineAnchorId = previous?.state?.mainlineAnchorId ?? '';
    let transition = timelineUpdate.transition;

    if (!previous) {
        const sceneLabel = timelineUpdate.currentTime || normalizedStatus.environment.time || '时间未明确';
        if (transition === 'enter_flashback' && timelineUpdate.mainlineTime) {
            mainlineAnchorId = makeTimelineAnchor(store, numericId, 'initial-mainline', {
                label: timelineUpdate.mainlineTime,
                mode: 'mainline',
            });
            sceneAnchorId = makeTimelineAnchor(store, numericId, 'initial-flashback', {
                label: sceneLabel,
                mode: 'flashback',
                relativeTo: mainlineAnchorId,
                relation: timelineUpdate.elapsed || timelineUpdate.evidence || '位于主线之前',
            });
        } else {
            sceneAnchorId = makeTimelineAnchor(store, numericId, 'initial', { label: sceneLabel, mode: 'mainline' });
            mainlineAnchorId = sceneAnchorId;
            transition = 'unchanged';
        }
    } else if (transition === 'advance' || transition === 'jump') {
        const label = timelineUpdate.currentTime || normalizedStatus.environment.time || previousMainline?.label;
        const anchorId = makeTimelineAnchor(store, numericId, 'mainline', {
            label,
            mode: 'mainline',
            relativeTo: previous.state.mainlineAnchorId,
            relation: timelineUpdate.elapsed || timelineUpdate.evidence || '正文明确推进了时间',
        });
        sceneAnchorId = anchorId;
        mainlineAnchorId = anchorId;
    } else if (transition === 'enter_flashback') {
        sceneAnchorId = makeTimelineAnchor(store, numericId, 'flashback', {
            label: timelineUpdate.currentTime || normalizedStatus.environment.time || '回忆时间未明确',
            mode: 'flashback',
            relativeTo: previous.state.mainlineAnchorId,
            relation: timelineUpdate.elapsed || timelineUpdate.evidence || '进入历史场景',
        });
        mainlineAnchorId = previous.state.mainlineAnchorId;
    } else if (transition === 'return_mainline') {
        sceneAnchorId = previous.state.mainlineAnchorId;
        mainlineAnchorId = previous.state.mainlineAnchorId;
    } else {
        transition = transition === 'unchanged' ? 'unchanged' : 'unknown';
        sceneAnchorId = previous.state.sceneAnchorId;
        mainlineAnchorId = previous.state.mainlineAnchorId;
    }

    const sceneAnchor = store.anchors[sceneAnchorId] ?? previousScene;
    const mainlineAnchor = store.anchors[mainlineAnchorId] ?? previousMainline;
    if (sceneAnchor?.label) normalizedStatus.environment.time = sceneAnchor.label;

    const segmentMessageIds = new Set([
        numericId,
        ...timelineUpdate.segments
            .map(segment => Number(segment.messageId))
            .filter(Number.isInteger),
    ]);
    for (const segmentMessageId of segmentMessageIds) {
        const key = String(segmentMessageId);
        store.messageSegments[key] = (store.messageSegments[key] ?? [])
            .filter(segment => Number(segment?.ownerMessageId) !== numericId);
    }

    const storedSegments = [];
    for (const [index, segment] of timelineUpdate.segments.entries()) {
        const segmentMessageId = Number.isInteger(segment.messageId) ? segment.messageId : numericId;
        let anchorId = sceneAnchorId;
        if (segment.mode === 'mainline' && (!segment.time || segment.time === sceneAnchor?.label)) {
            anchorId = mainlineAnchorId;
        } else if (segment.time || segment.relation) {
            anchorId = makeTimelineAnchor(store, numericId, `segment-${index + 1}`, {
                label: segment.time || '历史时间未明确',
                mode: segment.mode,
                relativeTo: mainlineAnchorId,
                relation: segment.relation,
            });
        }
        const record = { ...segment, anchorId, messageId: segmentMessageId, ownerMessageId: numericId };
        storedSegments.push(record);
        store.messageSegments[String(segmentMessageId)] ??= [];
        store.messageSegments[String(segmentMessageId)].push(record);
    }
    if (!store.messageSegments[String(numericId)]?.length) {
        const fallbackSegment = {
            messageId: numericId,
            startQuote: '',
            time: sceneAnchor?.label ?? normalizedStatus.environment.time,
            relation: sceneAnchor?.relation ?? '',
            mode: sceneAnchor?.mode ?? 'unknown',
            anchorId: sceneAnchorId,
            ownerMessageId: numericId,
        };
        store.messageSegments[String(numericId)] = [fallbackSegment];
        storedSegments.push(fallbackSegment);
    }

    const state = {
        sceneAnchorId,
        mainlineAnchorId,
        transition,
        elapsed: timelineUpdate.elapsed,
        evidence: timelineUpdate.evidence,
        sourceHash: cleanText(sourceHash, 32),
        timestamp: Math.floor(Date.now() / 1000),
    };
    store.messageStates[String(numericId)] = state;
    return { status: normalizedStatus, timeline: { state, sceneAnchor, mainlineAnchor, segments: storedSegments } };
}

function describeTimelinePath(store, fromAnchorId, toAnchorId) {
    if (!fromAnchorId || !toAnchorId) return '关系未明确';
    if (fromAnchorId === toAnchorId) return '与当前主线处于同一时间锚点';
    const forwardPath = (sourceId) => {
        const steps = [];
        let cursor = store.anchors[toAnchorId];
        const visited = new Set();
        while (cursor && !visited.has(cursor.id)) {
            visited.add(cursor.id);
            if (cursor.relativeTo === sourceId) {
                steps.unshift(cursor.relation || `随后到达${cursor.label}`);
                return steps;
            }
            if (!cursor.relativeTo) break;
            steps.unshift(cursor.relation || `随后到达${cursor.label}`);
            cursor = store.anchors[cursor.relativeTo];
        }
        return null;
    };
    const direct = forwardPath(fromAnchorId);
    if (direct) return direct.join(' → ');
    const source = store.anchors[fromAnchorId];
    const target = store.anchors[toAnchorId];
    const fromReference = source?.relativeTo ? forwardPath(source.relativeTo) : null;
    if (source?.relativeTo && (source.relativeTo === toAnchorId || fromReference)) {
        const base = store.anchors[source.relativeTo];
        return [
            source.relation || `位于${base?.label ?? '某主线锚点'}附近`,
            `参照点：${base?.label ?? '未明确'}`,
            ...(fromReference?.length ? [`参照点至当前：${fromReference.join(' → ')}`] : []),
        ].join('；');
    }
    return `历史锚点“${source?.label ?? '未明确'}”；当前主线“${target?.label ?? '未明确'}”；精确间隔未确定`;
}

export function getMessageTimelineMetadata(context, messageId) {
    const numericId = Number(messageId);
    if (!Number.isInteger(numericId)) return null;
    const exactOrPrevious = getLatestStoryTimeline(context, { beforeMessageId: numericId + 1 });
    if (!exactOrPrevious) return null;
    const { store, state } = exactOrPrevious;
    const preceding = getLatestStoryTimeline(context, { beforeMessageId: numericId });
    const latest = getLatestStoryTimeline(context);
    const scene = store.anchors[state.sceneAnchorId];
    const mainline = store.anchors[state.mainlineAnchorId];
    const currentMainline = latest?.store?.anchors?.[latest.state.mainlineAnchorId] ?? mainline;
    const precedingScene = preceding?.store?.anchors?.[preceding.state.sceneAnchorId];
    const precedingMainline = preceding?.store?.anchors?.[preceding.state.mainlineAnchorId];
    const segments = (store.messageSegments[String(numericId)] ?? []).map(segment => ({
        ...segment,
        anchorLabel: store.anchors[segment.anchorId]?.label ?? segment.time,
        relationToCurrent: describeTimelinePath(store, segment.anchorId, latest?.state?.mainlineAnchorId),
    }));
    return {
        sceneAnchorId: state.sceneAnchorId,
        sceneTime: scene?.label ?? '',
        mainlineAnchorId: state.mainlineAnchorId,
        mainlineTime: mainline?.label ?? '',
        precedingSceneAnchorId: preceding?.state?.sceneAnchorId ?? '',
        precedingSceneTime: precedingScene?.label ?? '',
        precedingMainlineAnchorId: preceding?.state?.mainlineAnchorId ?? '',
        precedingMainlineTime: precedingMainline?.label ?? '',
        precedingRelationToCurrent: describeTimelinePath(
            store,
            preceding?.state?.sceneAnchorId,
            latest?.state?.mainlineAnchorId,
        ),
        currentMainlineTime: currentMainline?.label ?? '',
        relationToCurrent: describeTimelinePath(store, state.sceneAnchorId, latest?.state?.mainlineAnchorId),
        segments,
    };
}

export function correctLatestStoryTime(context, value) {
    const nextTime = cleanText(value, 300);
    if (!nextTime) return false;
    const latest = getLatestStoryTimeline(context);
    const latestStatus = getLatestStoryStatus(context);
    if (!latest || !latestStatus) return false;
    const { store, state, messageId } = latest;
    const scene = store.anchors[state.sceneAnchorId];
    if (!scene) return false;
    scene.label = nextTime;
    scene.manual = true;
    if (state.sceneAnchorId === state.mainlineAnchorId) {
        const mainline = store.anchors[state.mainlineAnchorId];
        if (mainline) {
            mainline.label = nextTime;
            mainline.manual = true;
        }
    }
    const statusStore = getStatusStore(context?.chatMetadata, true);
    const record = statusStore[String(latestStatus.messageId)];
    const normalized = normalizeStoryStatus(record?.status ?? record);
    if (normalized) {
        normalized.environment.time = nextTime;
        statusStore[String(latestStatus.messageId)] = {
            ...(record && typeof record === 'object' ? record : {}),
            status: normalized,
            timestamp: Math.floor(Date.now() / 1000),
        };
    }
    state.manual = true;
    state.timestamp = Math.floor(Date.now() / 1000);
    store.messageStates[String(messageId)] = state;
    return true;
}

export function hashStorySource(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeStoryStatus(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const environmentSource = value.environment ?? value.环境 ?? {};
    const eventSource = value.event ?? value.事件 ?? {};
    const characterSource = value.characters ?? value.人物 ?? [];
    const characters = (Array.isArray(characterSource) ? characterSource : [])
        .map((character) => {
            if (!character || typeof character !== 'object' || Array.isArray(character)) return null;
            const extrasSource = character.extras ?? character.其他 ?? [];
            const extras = (Array.isArray(extrasSource) ? extrasSource : [])
                .map(extra => ({
                    label: cleanText(extra?.label ?? extra?.名称, 80),
                    value: cleanText(extra?.value ?? extra?.内容, 500),
                }))
                .filter(extra => extra.label && extra.value);
            const normalized = {
                name: cleanText(character.name ?? character.姓名 ?? character.角色, 120),
                role: cleanText(character.role ?? character.身份, 40),
                appearance: cleanText(character.appearance ?? character.外貌, 500),
                action: cleanText(character.action ?? character.动作, 500),
                emotion: cleanText(character.emotion ?? character.情绪, 500),
                desire: cleanText(character.desire ?? character.欲望, 500),
                innerThoughts: cleanText(character.innerThoughts ?? character.inner_thoughts ?? character['内心OS'] ?? character.内心, 800),
                extras,
            };
            return normalized.name ? normalized : null;
        })
        .filter(Boolean);

    const normalized = {
        environment: {
            time: cleanText(environmentSource.time ?? environmentSource.时间, 300),
            location: cleanText(environmentSource.location ?? environmentSource.地点, 500),
            season: cleanText(environmentSource.season ?? environmentSource.季节, 120),
            weather: cleanText(environmentSource.weather ?? environmentSource.天气, 300),
        },
        characters,
        event: {
            activity: cleanText(eventSource.activity ?? eventSource.current ?? eventSource.当前事件 ?? eventSource.正在做什么, 800),
            situation: cleanText(eventSource.situation ?? eventSource.形势, 800),
            goals: cleanList(eventSource.goals ?? eventSource.目标),
        },
    };

    const hasContent = Object.values(normalized.environment).some(Boolean)
        || normalized.characters.length > 0
        || normalized.event.activity
        || normalized.event.situation
        || normalized.event.goals.length > 0;
    return hasContent ? normalized : null;
}

export function applyStoryStatusOptions(value, options = {}) {
    const normalized = normalizeStoryStatus(value);
    if (!normalized) return null;
    if (Array.isArray(options?.customFields)) {
        const allowedFields = new Set(options.customFields
            .filter(field => field?.enabled !== false)
            .map(field => cleanText(field?.label, 80))
            .filter(Boolean));
        for (const character of normalized.characters) {
            character.extras = character.extras.filter(extra => allowedFields.has(extra.label));
        }
    }
    if (options?.showGoals === false) normalized.event.goals = [];
    return normalized;
}

export function parseSideResponse(content) {
    const raw = cleanText(content, 200_000);
    if (!raw) return { barrage: '', status: null, timeline: normalizeTimelineUpdate(null), development: null };

    const candidates = [
        raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''),
    ];
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        candidates.push(raw.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of [...new Set(candidates)]) {
        try {
            const parsed = JSON.parse(candidate);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            return {
                barrage: cleanText(parsed.barrage ?? parsed.弹幕, 100_000),
                status: normalizeStoryStatus(parsed.status ?? parsed.状态),
                timeline: normalizeTimelineUpdate(parsed.timeline ?? parsed.时间线),
                development: parsed.development ?? parsed.人物发展 ?? null,
            };
        } catch {
            // Some compatible providers ignore JSON-only instructions. Try the
            // tagged and plain-text fallbacks below instead.
        }
    }

    const barrageMatch = raw.match(/<barrage>([\s\S]*?)<\/barrage>/i);
    const statusMatch = raw.match(/<status>([\s\S]*?)<\/status>/i);
    let taggedStatus = null;
    if (statusMatch) {
        try {
            taggedStatus = normalizeStoryStatus(JSON.parse(statusMatch[1].trim()));
        } catch {
            taggedStatus = null;
        }
    }
    if (barrageMatch || taggedStatus) {
        return { barrage: cleanText(barrageMatch?.[1], 100_000), status: taggedStatus, timeline: normalizeTimelineUpdate(null), development: null };
    }

    return { barrage: raw, status: null, timeline: normalizeTimelineUpdate(null), development: null };
}

function getStatusStore(metadata, create = false) {
    const existing = metadata?.[STORY_STATUS_METADATA_KEY];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing;
    if (create && metadata && typeof metadata === 'object') {
        metadata[STORY_STATUS_METADATA_KEY] = {};
        return metadata[STORY_STATUS_METADATA_KEY];
    }
    return {};
}

export function saveStoryStatus(context, messageId, status, sourceHash) {
    const normalized = normalizeStoryStatus(status);
    const numericId = Number(messageId);
    if (!normalized || !Number.isInteger(numericId)) return false;
    const store = getStatusStore(context?.chatMetadata, true);
    store[String(numericId)] = {
        status: normalized,
        sourceHash: cleanText(sourceHash, 32),
        timestamp: Math.floor(Date.now() / 1000),
    };
    return true;
}

export function getLatestStoryStatus(context, { beforeMessageId = Number.POSITIVE_INFINITY } = {}) {
    const store = getStatusStore(context?.chatMetadata);
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const ids = Object.keys(store)
        .map(Number)
        .filter(id => Number.isInteger(id) && id < beforeMessageId)
        .sort((left, right) => right - left);

    for (const messageId of ids) {
        const record = store[String(messageId)];
        const message = chat[messageId];
        const status = normalizeStoryStatus(record?.status ?? record);
        if (!message || message.is_user || message.is_system || !status) continue;
        if (record?.sourceHash && record.sourceHash !== hashStorySource(message.mes)) continue;
        return { messageId, status, timestamp: Number(record?.timestamp) || 0 };
    }
    return null;
}

export function getStoryStatusAt(context, messageId) {
    const numericId = Number(messageId);
    if (!Number.isInteger(numericId)) return null;
    const record = getStatusStore(context?.chatMetadata)[String(numericId)];
    const message = context?.chat?.[numericId];
    const status = normalizeStoryStatus(record?.status ?? record);
    if (!message || message.is_user || message.is_system || !status) return null;
    if (record?.sourceHash && record.sourceHash !== hashStorySource(message.mes)) return null;
    return { messageId: numericId, status, timestamp: Number(record?.timestamp) || 0 };
}

function statusLines(status, timeline = null) {
    const lines = ['【当前剧情状态（上一轮结束时）】'];
    const environment = status.environment ?? {};
    const environmentParts = [
        environment.time && `时间：${environment.time}`,
        environment.location && `地点：${environment.location}`,
        environment.season && `季节：${environment.season}`,
        environment.weather && `天气：${environment.weather}`,
    ].filter(Boolean);
    if (environmentParts.length > 0) lines.push(`环境｜${environmentParts.join('；')}`);

    for (const character of status.characters ?? []) {
        const parts = [
            character.appearance && `外貌：${character.appearance}`,
            character.action && `动作：${character.action}`,
            character.emotion && `情绪：${character.emotion}`,
            character.desire && `欲望：${character.desire}`,
            character.innerThoughts && `内心OS：${character.innerThoughts}`,
            ...(character.extras ?? []).map(extra => `${extra.label}：${extra.value}`),
        ].filter(Boolean);
        lines.push(`人物｜${character.name}${character.role ? `（${character.role}）` : ''}｜${parts.join('；') || '状态未明确'}`);
    }

    const eventParts = [
        status.event?.activity && `当前：${status.event.activity}`,
        status.event?.situation && `形势：${status.event.situation}`,
        status.event?.goals?.length && `目标：${status.event.goals.join('；')}`,
    ].filter(Boolean);
    if (eventParts.length > 0) lines.push(`事件｜${eventParts.join('；')}`);
    if (timeline) {
        lines.push([
            '时间线｜',
            timeline.sceneTime && `当前场景：${timeline.sceneTime}`,
            timeline.mainlineTime && `主线现在：${timeline.mainlineTime}`,
            timeline.relationToCurrent && `锚点关系：${timeline.relationToCurrent}`,
        ].filter(Boolean).join('；'));
    }
    lines.push('这是上一轮结束时的当前状态。最新用户消息若明确推进或跳跃时间，应据此更新；若没有明确时间变化，必须保持这里的时间，不得按楼层自行推进。');
    lines.push('历史召回和回忆中的“昨天、三天前、十年前”属于各自的历史时间锚点，不得把它们当成主线现在。');
    return lines;
}

export function formatStoryStatusMessage(status, timeline = null) {
    const normalized = normalizeStoryStatus(status);
    if (!normalized) return null;
    const content = statusLines(normalized, timeline).join('\n');
    return {
        role: 'system',
        content,
        name: 'KKToolbox Story Status',
        is_user: false,
        is_system: false,
        mes: content,
        extra: { type: 'narrator', [STORY_STATUS_MARKER]: true },
    };
}

export function injectLatestStoryStatus(chat, context) {
    if (!Array.isArray(chat) || chat.some(message => message?.extra?.[STORY_STATUS_MARKER])) return false;
    const options = context?.extensionSettings?.['st-memory-augment']?.status ?? {};
    if (options.enabled !== true) return false;
    const persistentChat = Array.isArray(context?.chat) ? context.chat : [];
    let latestUserId = Number.POSITIVE_INFINITY;
    for (let index = persistentChat.length - 1; index >= 0; index--) {
        if (persistentChat[index]?.is_user) {
            latestUserId = index;
            break;
        }
    }
    const record = getLatestStoryStatus(context, { beforeMessageId: latestUserId });
    const timeline = record ? getMessageTimelineMetadata(context, record.messageId) : null;
    const message = formatStoryStatusMessage(applyStoryStatusOptions(record?.status, options), timeline);
    if (!message) return false;

    let insertionIndex = -1;
    for (let index = chat.length - 1; index >= 0; index--) {
        if (chat[index]?.is_user || chat[index]?.role === 'user') {
            insertionIndex = index;
            break;
        }
    }
    chat.splice(insertionIndex >= 0 ? insertionIndex : Math.max(0, chat.length - 1), 0, message);
    return true;
}

function appendRow(container, label, value) {
    if (!value) return;
    const row = document.createElement('div');
    row.className = 'memory-augment-story-status-row';
    const heading = document.createElement('span');
    heading.textContent = label;
    const content = document.createElement('strong');
    content.textContent = value;
    row.append(heading, content);
    container.append(row);
}

function renderStatusRecord(record) {
    if (typeof document === 'undefined') return;
    const empty = document.querySelector('#memory_augment_story_status_empty');
    const content = document.querySelector('#memory_augment_story_status_content');
    if (!empty || !content) return;
    content.replaceChildren();
    if (!record?.status) {
        empty.hidden = false;
        content.hidden = true;
        return;
    }

    empty.hidden = true;
    content.hidden = false;
    const status = record.status;
    const environment = document.createElement('section');
    environment.innerHTML = '<h4>环境</h4>';
    appendRow(environment, '时间', status.environment.time);
    if (record.timeline?.mainlineTime
        && record.timeline.mainlineTime !== status.environment.time) {
        appendRow(environment, '主线现在', record.timeline.mainlineTime);
        appendRow(environment, '时间关系', record.timeline.relationToCurrent);
    }
    if (status.environment.time) {
        const editTime = document.createElement('button');
        editTime.type = 'button';
        editTime.className = 'menu_button memory-augment-story-time-edit';
        editTime.textContent = '修正剧情时间';
        editTime.addEventListener('click', () => document.dispatchEvent(new CustomEvent(
            'memory-augment-edit-story-time',
            { detail: { value: status.environment.time } },
        )));
        environment.append(editTime);
    }
    appendRow(environment, '地点', status.environment.location);
    appendRow(environment, '季节', status.environment.season);
    appendRow(environment, '天气', status.environment.weather);
    content.append(environment);

    const characters = document.createElement('section');
    characters.innerHTML = '<h4>人物</h4>';
    for (const character of status.characters) {
        const card = document.createElement('article');
        const heading = document.createElement('h5');
        heading.textContent = `${character.name}${character.role ? ` · ${character.role}` : ''}`;
        card.append(heading);
        appendRow(card, '外貌', character.appearance);
        appendRow(card, '动作', character.action);
        appendRow(card, '情绪', character.emotion);
        appendRow(card, '欲望', character.desire);
        appendRow(card, '内心 OS', character.innerThoughts);
        for (const extra of character.extras) appendRow(card, extra.label, extra.value);
        characters.append(card);
    }
    content.append(characters);

    const event = document.createElement('section');
    event.innerHTML = '<h4>事件</h4>';
    appendRow(event, '当前', status.event.activity);
    appendRow(event, '形势', status.event.situation);
    appendRow(event, '目标', status.event.goals.join('；'));
    content.append(event);
}

export function refreshStoryStatusUi(context = globalThis.SillyTavern?.getContext?.()) {
    const record = getLatestStoryStatus(context);
    const options = context?.extensionSettings?.['st-memory-augment']?.status ?? {};
    renderStatusRecord(options.enabled === true && record
        ? {
            ...record,
            status: applyStoryStatusOptions(record.status, options),
            timeline: getMessageTimelineMetadata(context, record.messageId),
        }
        : null);
    const empty = typeof document === 'undefined' ? null : document.querySelector('#memory_augment_story_status_empty');
    if (empty) empty.textContent = options.enabled === true
        ? 'AI 第一次回复后会在这里生成状态。'
        : '剧情状态栏已关闭，可在 KKToolbox 设置中重新开启。';
    const root = typeof document === 'undefined' ? null : document.querySelector('#memory_augment_story_status_root');
    if (root) {
        root.hidden = false;
        const ball = root.querySelector('#memory_augment_story_status_ball');
        const panel = root.querySelector('#memory_augment_story_status_panel');
        const showFloatingButton = shouldShowStoryFloatingButton(options);
        if (ball) ball.hidden = !showFloatingButton;
        if (!showFloatingButton && panel) {
            panel.hidden = true;
            ball?.setAttribute('aria-expanded', 'false');
        }
    }
}

export function shouldCloseStoryPanelForPointer(root, panel, target) {
    if (panel?.hidden || !target || root?.contains?.(target)) return false;
    if (typeof target.closest === 'function' && target.closest('dialog.popup, .popup')) return false;
    return true;
}

function applySavedPosition(root, settings) {
    const xRatio = Number(settings?.status?.position?.x);
    const yRatio = Number(settings?.status?.position?.y);
    if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)) return;
    const ball = root.querySelector('#memory_augment_story_status_ball');
    const width = ball?.offsetWidth || 48;
    const height = ball?.offsetHeight || 48;
    const x = Math.max(8, Math.min(globalThis.innerWidth - width - 8, xRatio * (globalThis.innerWidth - width)));
    const y = Math.max(8, Math.min(globalThis.innerHeight - height - 8, yRatio * (globalThis.innerHeight - height)));
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.dataset.horizontal = x < globalThis.innerWidth / 2 ? 'left' : 'right';
    root.dataset.vertical = y < globalThis.innerHeight / 2 ? 'top' : 'bottom';
}

function bindStatusDragging(root, settings, context) {
    const ball = root.querySelector('#memory_augment_story_status_ball');
    const header = root.querySelector('#memory_augment_story_status_panel > header');
    let drag = null;
    let suppressClick = false;

    const startDrag = (event) => {
        if (event.button !== 0 || event.target.closest?.('#memory_augment_story_status_close')) return;
        const rectangle = root.getBoundingClientRect();
        drag = { startX: event.clientX, startY: event.clientY, left: rectangle.left, top: rectangle.top };
        root.classList.add('is-dragging');
        event.preventDefault();
    };
    const moveDrag = (event) => {
        if (!drag) return;
        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;
        if (Math.abs(deltaX) + Math.abs(deltaY) > 5) suppressClick = true;
        const width = ball?.offsetWidth || 48;
        const height = ball?.offsetHeight || 48;
        const x = Math.max(8, Math.min(globalThis.innerWidth - width - 8, drag.left + deltaX));
        const y = Math.max(8, Math.min(globalThis.innerHeight - height - 8, drag.top + deltaY));
        root.style.left = `${x}px`;
        root.style.top = `${y}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        root.dataset.horizontal = x < globalThis.innerWidth / 2 ? 'left' : 'right';
        root.dataset.vertical = y < globalThis.innerHeight / 2 ? 'top' : 'bottom';
    };
    const finishDrag = () => {
        if (!drag) return;
        const rectangle = root.getBoundingClientRect();
        settings.status.position = {
            x: Math.max(0, Math.min(1, rectangle.left / Math.max(1, globalThis.innerWidth - rectangle.width))),
            y: Math.max(0, Math.min(1, rectangle.top / Math.max(1, globalThis.innerHeight - rectangle.height))),
        };
        context.saveSettingsDebounced?.();
        drag = null;
        root.classList.remove('is-dragging');
    };

    ball?.addEventListener('pointerdown', startDrag);
    header?.addEventListener('pointerdown', startDrag);
    globalThis.addEventListener('pointermove', moveDrag);
    globalThis.addEventListener('pointerup', finishDrag);
    globalThis.addEventListener('pointercancel', finishDrag);
    globalThis.addEventListener('resize', () => applySavedPosition(root, settings));
    return () => {
        const blocked = suppressClick;
        suppressClick = false;
        return blocked;
    };
}

function bindPanelWheelScrolling(root) {
    const panel = root.querySelector('#memory_augment_story_status_panel');
    if (!panel) return;
    panel.addEventListener('wheel', (event) => {
        if (event.ctrlKey || (!event.deltaX && !event.deltaY)) return;
        const activePage = [...root.querySelectorAll('[data-story-page]')].find(page => !page.hidden);
        if (!activePage) return;
        const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
        const delta = vertical ? event.deltaY : event.deltaX;
        const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? activePage.clientHeight : 1;
        let candidate = event.target instanceof Element ? event.target : activePage;
        while (candidate && panel.contains(candidate)) {
            const style = globalThis.getComputedStyle?.(candidate);
            const overflow = vertical ? style?.overflowY : style?.overflowX;
            const scrollSize = vertical ? candidate.scrollHeight : candidate.scrollWidth;
            const clientSize = vertical ? candidate.clientHeight : candidate.clientWidth;
            const position = vertical ? candidate.scrollTop : candidate.scrollLeft;
            const canScroll = /auto|scroll|overlay/.test(overflow ?? '') && scrollSize > clientSize + 1;
            const canMove = delta < 0 ? position > 0 : position + clientSize < scrollSize - 1;
            if (canScroll && canMove) break;
            if (candidate === activePage) {
                candidate = null;
                break;
            }
            candidate = candidate.parentElement;
        }
        candidate ??= activePage;
        const scrollSize = vertical ? candidate.scrollHeight : candidate.scrollWidth;
        const clientSize = vertical ? candidate.clientHeight : candidate.clientWidth;
        if (scrollSize <= clientSize + 1) return;
        if (vertical) candidate.scrollTop += delta * unit;
        else candidate.scrollLeft += delta * unit;
        event.preventDefault();
        event.stopPropagation();
    }, { capture: true, passive: false });
}

export function initializeStoryStatusUi(context, settings) {
    if (typeof document === 'undefined') return;
    if (!document.querySelector('#memory_augment_story_status_root')) {
        const root = document.createElement('div');
        root.id = 'memory_augment_story_status_root';
        root.innerHTML = `
            <button type="button" id="memory_augment_story_status_ball" class="menu_button" title="查看当前剧情状态" aria-label="查看当前剧情状态" aria-expanded="false">
                <i class="fa-solid fa-clipboard-list" aria-hidden="true"></i>
            </button>
            <aside id="memory_augment_story_status_panel" hidden>
                <header><strong>KKToolbox</strong><button type="button" class="menu_button" id="memory_augment_story_status_close" aria-label="关闭悬浮窗">×</button></header>
                <nav class="memory-augment-story-tabs" aria-label="悬浮窗页面">
                    <button type="button" class="menu_button is-active" data-story-view="status">剧情状态</button>
                    <button type="button" class="menu_button" data-story-view="development">人物发展</button>
                    <button type="button" class="menu_button" data-story-view="map">地图册</button>
                </nav>
                <div id="memory_augment_story_status_view" data-story-page="status">
                    <div id="memory_augment_story_status_empty">AI 第一次回复后会在这里生成状态。</div>
                    <div id="memory_augment_story_status_content" hidden></div>
                </div>
                <div id="memory_augment_character_development_view" data-story-page="development" hidden></div>
                <div id="memory_augment_story_map_view" data-story-page="map" hidden></div>
            </aside>`;
        document.body.append(root);
    }
    const root = document.querySelector('#memory_augment_story_status_root');
    root.hidden = false;
    applySavedPosition(root, settings);
    refreshStoryStatusUi(context);
    if (statusUiBound) return;

    const ball = document.querySelector('#memory_augment_story_status_ball');
    const panel = document.querySelector('#memory_augment_story_status_panel');
    const wasDragged = bindStatusDragging(root, settings, context);
    bindPanelWheelScrolling(root);
    const setView = (view) => {
        const selected = ['map', 'development'].includes(view) ? view : 'status';
        root.dataset.storyView = selected;
        root.querySelectorAll('[data-story-page]').forEach(page => page.hidden = page.dataset.storyPage !== selected);
        root.querySelectorAll('[data-story-view]').forEach(button => {
            const active = button.dataset.storyView === selected;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-current', active ? 'page' : 'false');
        });
        if (selected === 'map') document.dispatchEvent(new CustomEvent('memory-augment-map-opened'));
    };
    const setOpen = (open) => {
        panel.hidden = !open;
        ball.setAttribute('aria-expanded', String(open));
    };
    ball?.addEventListener('click', () => {
        if (!wasDragged()) setOpen(panel.hidden);
    });
    document.querySelector('#memory_augment_story_status_close')?.addEventListener('click', () => setOpen(false));
    document.addEventListener('pointerdown', (event) => {
        if (shouldCloseStoryPanelForPointer(root, panel, event.target)) {
            setOpen(false);
        }
    }, true);
    root.querySelectorAll('[data-story-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.storyView)));
    document.addEventListener('memory-augment-open-story-view', (event) => {
        setView(event.detail?.view);
        setOpen(true);
    });
    const chatChanged = context?.eventTypes?.CHAT_CHANGED ?? context?.event_types?.CHAT_CHANGED;
    if (chatChanged) {
        context.eventSource.on(chatChanged, () => setTimeout(() => refreshStoryStatusUi(), 0));
    }
    statusUiBound = true;
}
