export const CHARACTER_DEVELOPMENT_METADATA_KEY = 'memory_augment_character_development';

const DEVELOPMENT_MARKER = 'memory_augment_character_development';
const DIMENSION_LABELS = Object.freeze({
    temperament: '性格倾向',
    belief: '观念',
    relationship: '人物关系',
    habit: '行为习惯',
    boundary: '承诺与底线',
    self_view: '自我认知',
});
const DIMENSION_ALIASES = Object.freeze({
    性格: 'temperament',
    性格倾向: 'temperament',
    观念: 'belief',
    信念: 'belief',
    人物关系: 'relationship',
    关系: 'relationship',
    行为习惯: 'habit',
    习惯: 'habit',
    承诺与底线: 'boundary',
    底线: 'boundary',
    自我认知: 'self_view',
});
let developmentUiBound = false;

function cleanText(value, maximum = 1200) {
    return String(value ?? '').trim().slice(0, maximum);
}

function getStore(metadata, create = false) {
    const existing = metadata?.[CHARACTER_DEVELOPMENT_METADATA_KEY];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        existing.version = 1;
        existing.profiles ??= {};
        existing.candidates ??= {};
        existing.processed ??= {};
        existing.dismissed ??= {};
        return existing;
    }
    if (!create || !metadata || typeof metadata !== 'object') return null;
    metadata[CHARACTER_DEVELOPMENT_METADATA_KEY] = {
        version: 1,
        profiles: {},
        candidates: {},
        processed: {},
        dismissed: {},
    };
    return metadata[CHARACTER_DEVELOPMENT_METADATA_KEY];
}

function normalizeDimension(value) {
    const source = cleanText(value, 40).toLowerCase();
    return Object.hasOwn(DIMENSION_LABELS, source) ? source : DIMENSION_ALIASES[source] ?? '';
}

function normalizeEvidence(value) {
    const source = Array.isArray(value) ? value : value ? [value] : [];
    return source.map((item) => {
        if (!item || typeof item !== 'object') return null;
        const messageId = Number(item.messageId ?? item.message_id ?? item.楼层);
        const quote = cleanText(item.quote ?? item.原文 ?? item.evidence, 220);
        return Number.isInteger(messageId) && quote ? { messageId, quote } : null;
    }).filter(Boolean).slice(0, 8);
}

export function normalizeDevelopmentUpdate(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const rawChanges = Array.isArray(source.changes ?? source.变化) ? (source.changes ?? source.变化) : [];
    return {
        changes: rawChanges.map((change) => {
            if (!change || typeof change !== 'object') return null;
            const character = cleanText(change.character ?? change.name ?? change.人物, 120);
            const dimension = normalizeDimension(change.dimension ?? change.type ?? change.维度);
            const after = cleanText(change.after ?? change.value ?? change.现在, 600);
            const sourceType = cleanText(change.source ?? change.sourceType ?? change.来源, 40).toLowerCase();
            if (!character || !dimension || !after) return null;
            return {
                character,
                dimension,
                target: cleanText(change.target ?? change.对象, 120),
                before: cleanText(change.before ?? change.原先, 400),
                after,
                reason: cleanText(change.reason ?? change.原因, 500),
                source: ['user_direct', 'observed'].includes(sourceType) ? sourceType : 'observed',
                evidence: normalizeEvidence(change.evidence ?? change.依据),
            };
        }).filter(Boolean).slice(0, 12),
    };
}

function getFieldKey(dimension, target = '') {
    return `${dimension}::${cleanText(target, 120).toLocaleLowerCase()}`;
}

function getCandidateKey(change) {
    const normalizedAfter = change.after.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    return `${change.character.toLocaleLowerCase()}::${getFieldKey(change.dimension, change.target)}::${normalizedAfter}`;
}

function validateEvidence(context, evidence) {
    return evidence.filter((item) => {
        const message = context?.chat?.[item.messageId];
        return Boolean(message && String(message.mes ?? '').includes(item.quote));
    });
}

function getProfile(store, name, create = false) {
    const key = cleanText(name, 120).toLocaleLowerCase();
    let profile = Object.values(store?.profiles ?? {}).find(item => item?.name?.toLocaleLowerCase() === key);
    if (!profile && create) {
        profile = { name: cleanText(name, 120), fields: {}, history: [] };
        store.profiles[key] = profile;
    }
    if (profile) {
        profile.fields ??= {};
        profile.history = Array.isArray(profile.history) ? profile.history : [];
    }
    return profile ?? null;
}

function upsertConfirmedField(store, change, ownerMessageId, source) {
    const profile = getProfile(store, change.character, true);
    const key = getFieldKey(change.dimension, change.target);
    const previous = profile.fields[key];
    if (source === 'confirmed' && ['manual', 'user_direct'].includes(previous?.source)) {
        return { profile, field: previous, changed: false, blocked: true };
    }
    if (previous && previous.value === change.after && previous.source === source) {
        previous.evidence = change.evidence;
        previous.reason = change.reason || previous.reason;
        previous.updatedMessageId = ownerMessageId;
        return { profile, field: previous, changed: false };
    }
    if (previous) {
        profile.history.push({ ...previous, replacedAtMessageId: ownerMessageId });
        profile.history = profile.history.slice(-40);
    }
    const field = {
        key,
        dimension: change.dimension,
        target: change.target,
        value: change.after,
        before: change.before || previous?.value || '',
        reason: change.reason,
        source,
        evidence: change.evidence,
        updatedMessageId: ownerMessageId,
        updatedAt: Math.floor(Date.now() / 1000),
    };
    profile.fields[key] = field;
    for (const [candidateId, candidate] of Object.entries(store.candidates ?? {})) {
        if (candidate.character.toLocaleLowerCase() === change.character.toLocaleLowerCase()
            && getFieldKey(candidate.dimension, candidate.target) === key) {
            delete store.candidates[candidateId];
        }
    }
    return { profile, field, changed: true };
}

function makeSceneKey(ownerMessageId, status, timeline) {
    const anchor = cleanText(timeline?.sceneAnchorId ?? timeline?.state?.sceneAnchorId, 120);
    const location = cleanText(status?.environment?.location, 200).toLocaleLowerCase();
    const activity = cleanText(status?.event?.activity, 200).toLocaleLowerCase();
    return `${anchor || 'no-anchor'}|${location || 'no-location'}|${activity || `floor-${ownerMessageId}`}`;
}

export function applyCharacterDevelopmentUpdate(context, ownerMessageId, value, options = {}) {
    const numericId = Number(ownerMessageId);
    const store = getStore(context?.chatMetadata, true);
    if (!store || !Number.isInteger(numericId)) return { confirmed: 0, observed: 0, rejected: 0 };
    const update = normalizeDevelopmentUpdate(value);
    const userCharacters = new Set((options?.status?.characters ?? [])
        .filter(character => String(character?.role ?? '').toLowerCase() === 'user')
        .map(character => cleanText(character?.name, 120).toLocaleLowerCase()));
    for (const message of context?.chat ?? []) {
        if (message?.is_user && cleanText(message?.name, 120)) {
            userCharacters.add(cleanText(message.name, 120).toLocaleLowerCase());
        }
    }
    const sceneKey = makeSceneKey(numericId, options?.status, options?.timeline);
    let latestUserMessageId = -1;
    for (let index = Math.min(numericId - 1, (context?.chat?.length ?? 0) - 1); index >= 0; index--) {
        if (context.chat[index]?.is_user) {
            latestUserMessageId = index;
            break;
        }
    }
    let confirmed = 0;
    let observed = 0;
    let rejected = 0;

    for (const rawChange of update.changes) {
        const evidence = validateEvidence(context, rawChange.evidence);
        if (evidence.length === 0) {
            rejected++;
            continue;
        }
        const change = { ...rawChange, evidence };
        const directUserEvidence = evidence.filter(item => item.messageId === latestUserMessageId
            && context.chat[item.messageId]?.is_user === true);
        if (change.source === 'user_direct' && directUserEvidence.length > 0) {
            upsertConfirmedField(store, { ...change, evidence: directUserEvidence }, numericId, 'user_direct');
            delete store.candidates[getCandidateKey(change)];
            confirmed++;
            continue;
        }
        if (userCharacters.has(change.character.toLocaleLowerCase())) {
            rejected++;
            continue;
        }

        const key = getCandidateKey(change);
        if (store.dismissed[key]) {
            rejected++;
            continue;
        }
        const candidate = store.candidates[key] ?? {
            id: key,
            character: change.character,
            dimension: change.dimension,
            target: change.target,
            before: change.before,
            after: change.after,
            reason: change.reason,
            evidence: [],
            sceneKeys: [],
            firstSeenMessageId: numericId,
        };
        candidate.reason = change.reason || candidate.reason;
        candidate.lastSeenMessageId = numericId;
        candidate.sceneKeys = [...new Set([...candidate.sceneKeys, sceneKey])].slice(-12);
        const evidenceKeys = new Set(candidate.evidence.map(item => `${item.messageId}:${item.quote}`));
        for (const item of evidence) {
            const evidenceKey = `${item.messageId}:${item.quote}`;
            if (!evidenceKeys.has(evidenceKey)) candidate.evidence.push(item);
        }
        candidate.evidence = candidate.evidence.slice(-12);
        store.candidates[key] = candidate;
        observed++;

        const evidenceIds = candidate.evidence.map(item => item.messageId);
        const floorSpan = evidenceIds.length > 0 ? Math.max(...evidenceIds) - Math.min(...evidenceIds) : 0;
        if (candidate.sceneKeys.length >= 3 && floorSpan >= 10) {
            const promoted = upsertConfirmedField(store, candidate, numericId, 'confirmed');
            delete store.candidates[key];
            if (!promoted.blocked) confirmed++;
        }
    }

    const candidateEntries = Object.entries(store.candidates)
        .sort(([, left], [, right]) => Number(right.lastSeenMessageId) - Number(left.lastSeenMessageId));
    store.candidates = Object.fromEntries(candidateEntries.slice(0, 100));
    store.dismissed = Object.fromEntries(Object.entries(store.dismissed)
        .sort(([, left], [, right]) => Number(right) - Number(left))
        .slice(0, 100));
    store.processed[String(numericId)] = {
        sourceHash: cleanText(options?.sourceHash, 32),
        timestamp: Math.floor(Date.now() / 1000),
    };
    return { confirmed, observed, rejected };
}

export function isCharacterDevelopmentProcessed(context, messageId, sourceHash = '') {
    const record = getStore(context?.chatMetadata)?.processed?.[String(Number(messageId))];
    if (!record) return false;
    return !record.sourceHash || !sourceHash || record.sourceHash === sourceHash;
}

export function getCharacterDevelopmentSnapshot(context, { includeCandidates = false, limitProfiles = Number.POSITIVE_INFINITY } = {}) {
    const store = getStore(context?.chatMetadata);
    if (!store) return { profiles: [], candidates: [] };
    const profiles = Object.values(store.profiles)
        .map(profile => ({
            name: cleanText(profile?.name, 120),
            fields: Object.values(profile?.fields ?? {}).map(field => ({ ...field })),
        }))
        .filter(profile => profile.name && profile.fields.length > 0)
        .sort((left, right) => Math.max(...right.fields.map(field => Number(field.updatedMessageId) || 0))
            - Math.max(...left.fields.map(field => Number(field.updatedMessageId) || 0))
            || left.name.localeCompare(right.name, 'zh-CN'));
    const limitedProfiles = Number.isFinite(Number(limitProfiles))
        ? profiles.slice(0, Math.max(0, Number(limitProfiles)))
        : profiles;
    return {
        profiles: limitedProfiles,
        candidates: includeCandidates ? Object.values(store.candidates).map(candidate => ({ ...candidate })) : [],
    };
}

function developmentLines(snapshot) {
    const lines = [
        '【人物发展档案（故事开始后的已确认变化）】',
        '角色卡是故事开始前的基础设定；本档案是后来剧情形成或玩家直接规定的当前人物状态。二者冲突时，以这里及最新用户明确设定为准。',
    ];
    for (const profile of snapshot.profiles) {
        lines.push(`人物｜${profile.name}`);
        for (const field of profile.fields) {
            const label = DIMENSION_LABELS[field.dimension] ?? field.dimension;
            const target = field.target ? `（对${field.target}）` : '';
            lines.push(`- ${label}${target}：${field.value}${field.before ? `（相较过去：${field.before}）` : ''}`);
        }
    }
    lines.push('这些变化已经成立，不得为了贴回初始角色卡而复原；但仍应保持变化过程与人物底色的连续性。最新用户若明确重新设定人物，则以最新用户为最高优先级。');
    return lines;
}

export function formatCharacterDevelopmentMessage(context) {
    const snapshot = getCharacterDevelopmentSnapshot(context);
    if (snapshot.profiles.length === 0) return null;
    const content = developmentLines(snapshot).join('\n');
    return {
        role: 'system',
        content,
        name: 'KKToolbox Character Development',
        is_user: false,
        is_system: false,
        mes: content,
        extra: { type: 'narrator', [DEVELOPMENT_MARKER]: true },
    };
}

export function injectCharacterDevelopment(chat, context) {
    if (!Array.isArray(chat) || chat.some(message => message?.extra?.[DEVELOPMENT_MARKER])) return false;
    const enabled = context?.extensionSettings?.['st-memory-augment']?.development?.enabled !== false;
    if (!enabled) return false;
    const message = formatCharacterDevelopmentMessage(context);
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

export function setManualDevelopmentField(context, values) {
    const character = cleanText(values?.character, 120);
    const dimension = normalizeDimension(values?.dimension);
    const value = cleanText(values?.value, 600);
    if (!character || !dimension || !value) return false;
    const store = getStore(context?.chatMetadata, true);
    upsertConfirmedField(store, {
        character,
        dimension,
        target: cleanText(values?.target, 120),
        before: cleanText(values?.before, 400),
        after: value,
        reason: '玩家手动设置',
        evidence: [],
    }, Number(values?.messageId) || Math.max(0, (context?.chat?.length ?? 1) - 1), 'manual');
    return true;
}

export function deleteDevelopmentField(context, character, key) {
    const store = getStore(context?.chatMetadata);
    const profile = getProfile(store, character);
    if (!profile?.fields?.[key]) return false;
    delete profile.fields[key];
    if (Object.keys(profile.fields).length === 0) {
        const profileKey = Object.keys(store.profiles).find(item => store.profiles[item] === profile);
        if (profileKey) delete store.profiles[profileKey];
    }
    return true;
}

export function promoteDevelopmentCandidate(context, candidateId) {
    const store = getStore(context?.chatMetadata);
    const candidate = store?.candidates?.[candidateId];
    if (!candidate) return false;
    upsertConfirmedField(store, candidate, Number(candidate.lastSeenMessageId) || 0, 'manual');
    delete store.candidates[candidateId];
    return true;
}

export function discardDevelopmentCandidate(context, candidateId) {
    const store = getStore(context?.chatMetadata);
    if (!store?.candidates?.[candidateId]) return false;
    delete store.candidates[candidateId];
    store.dismissed[candidateId] = Math.floor(Date.now() / 1000);
    return true;
}

function makeButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

export function refreshCharacterDevelopmentUi(context = globalThis.SillyTavern?.getContext?.()) {
    if (typeof document === 'undefined') return;
    const root = document.querySelector('#memory_augment_character_development_view');
    if (!root) return;
    const enabled = context?.extensionSettings?.['st-memory-augment']?.development?.enabled !== false;
    const snapshot = getCharacterDevelopmentSnapshot(context, { includeCandidates: true });
    root.querySelector('.memory-augment-development-disabled')?.toggleAttribute('hidden', enabled);
    const profiles = root.querySelector('.memory-augment-development-profiles');
    const candidates = root.querySelector('.memory-augment-development-candidates');
    if (!profiles || !candidates) return;
    profiles.replaceChildren();
    candidates.replaceChildren();

    if (snapshot.profiles.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'memory-augment-development-empty';
        empty.textContent = '还没有已经确认的人物变化。';
        profiles.append(empty);
    }
    for (const profile of snapshot.profiles) {
        const card = document.createElement('details');
        card.className = 'memory-augment-development-card';
        const summary = document.createElement('summary');
        summary.textContent = `${profile.name} · ${profile.fields.length} 项变化`;
        card.append(summary);
        for (const field of profile.fields) {
            const row = document.createElement('article');
            const heading = document.createElement('strong');
            heading.textContent = `${DIMENSION_LABELS[field.dimension] ?? field.dimension}${field.target ? ` · ${field.target}` : ''}`;
            const text = document.createElement('p');
            text.textContent = field.value;
            const source = document.createElement('small');
            source.textContent = field.source === 'user_direct' ? '玩家直接设定' : field.source === 'manual' ? '玩家手动设置' : '剧情长期确认';
            const actions = document.createElement('div');
            actions.className = 'memory-augment-development-actions';
            actions.append(
                makeButton('修改', () => document.dispatchEvent(new CustomEvent('memory-augment-development-edit', { detail: { character: profile.name, field } }))),
                makeButton('删除', () => document.dispatchEvent(new CustomEvent('memory-augment-development-delete', { detail: { character: profile.name, field } }))),
            );
            row.append(heading, text, source, actions);
            card.append(row);
        }
        profiles.append(card);
    }

    const candidateHeading = document.createElement('details');
    candidateHeading.className = 'memory-augment-development-observations';
    const candidateSummary = document.createElement('summary');
    candidateSummary.textContent = `观察中的变化 · ${snapshot.candidates.length} 项（不会发送给正文 AI）`;
    candidateHeading.append(candidateSummary);
    if (snapshot.candidates.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = '暂无候选变化。';
        candidateHeading.append(empty);
    }
    for (const candidate of snapshot.candidates) {
        const row = document.createElement('article');
        const heading = document.createElement('strong');
        heading.textContent = `${candidate.character} · ${DIMENSION_LABELS[candidate.dimension] ?? candidate.dimension}`;
        const text = document.createElement('p');
        text.textContent = candidate.after;
        const progress = document.createElement('small');
        progress.textContent = `已在 ${candidate.sceneKeys?.length ?? 0} 个不同情境中观察到；尚未正式采用。`;
        const actions = document.createElement('div');
        actions.className = 'memory-augment-development-actions';
        actions.append(
            makeButton('立即采用', () => document.dispatchEvent(new CustomEvent('memory-augment-development-promote', { detail: { candidateId: candidate.id } }))),
            makeButton('忽略', () => document.dispatchEvent(new CustomEvent('memory-augment-development-discard', { detail: { candidateId: candidate.id } }))),
        );
        row.append(heading, text, progress, actions);
        candidateHeading.append(row);
    }
    candidates.append(candidateHeading);
}

export function initializeCharacterDevelopmentUi(context) {
    if (typeof document === 'undefined') return;
    const root = document.querySelector('#memory_augment_character_development_view');
    if (!root) return;
    if (!root.querySelector('.memory-augment-development-profiles')) {
        root.innerHTML = `
            <p class="memory-augment-development-disabled" hidden>人物发展档案已在设置中关闭。</p>
            <p class="memory-augment-development-intro">这里只显示已经成立的人物变化。观察中的候选不会发送给正文 AI；玩家明确设定和手动修改优先级最高。</p>
            <div class="memory-augment-development-manual">
                <strong>手动添加人物变化</strong>
                <div class="memory-augment-development-manual-grid">
                    <input class="text_pole" data-development-input="character" type="text" maxlength="120" placeholder="人物名">
                    <select class="text_pole" data-development-input="dimension">
                        ${Object.entries(DIMENSION_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
                    </select>
                    <input class="text_pole" data-development-input="target" type="text" maxlength="120" placeholder="关系对象（仅人物关系需要）">
                </div>
                <textarea class="text_pole" data-development-input="value" rows="3" maxlength="600" placeholder="现在已经形成的变化"></textarea>
                <button type="button" class="menu_button" data-development-action="add">添加并立即采用</button>
            </div>
            <div class="memory-augment-development-profiles"></div>
            <div class="memory-augment-development-candidates"></div>`;
    }
    refreshCharacterDevelopmentUi(context);
    if (developmentUiBound) return;
    root.querySelector('[data-development-action="add"]')?.addEventListener('click', async () => {
        const current = globalThis.SillyTavern?.getContext?.() ?? context;
        const read = name => root.querySelector(`[data-development-input="${name}"]`)?.value ?? '';
        if (!setManualDevelopmentField(current, {
            character: read('character'),
            dimension: read('dimension'),
            target: read('target'),
            value: read('value'),
        })) return;
        await current.saveMetadata?.();
        for (const name of ['character', 'target', 'value']) {
            const input = root.querySelector(`[data-development-input="${name}"]`);
            if (input) input.value = '';
        }
        refreshCharacterDevelopmentUi(current);
    });
    const chatChanged = context?.eventTypes?.CHAT_CHANGED ?? context?.event_types?.CHAT_CHANGED;
    if (chatChanged) {
        context.eventSource?.on?.(chatChanged, () => setTimeout(() => refreshCharacterDevelopmentUi(), 0));
    }
    developmentUiBound = true;
}

export { DIMENSION_LABELS };
