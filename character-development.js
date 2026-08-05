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
const CANDIDATE_STORE_VERSION = 2;
const CANDIDATE_STALE_FLOORS = 80;
const CANDIDATE_LIMIT_PER_FIELD = 8;
const SEMANTIC_TRAIT_GROUPS = Object.freeze([
    ['易怒', /暴躁|火爆|易怒|急躁|躁怒|脾气(?:变)?差|容易(?:发火|动怒|生气)/u],
    ['冷漠', /冷漠|冷淡|疏冷|淡漠|不近人情/u],
    ['疏离', /疏离|疏远|保持距离|拒人千里/u],
    ['寡言', /寡言|少言|沉默(?:寡言)?|不爱说话|话变少/u],
    ['外向', /外向|开朗|活泼|健谈|善于交际/u],
    ['内向', /内向|腼腆|不善言辞|不擅交际/u],
    ['阴郁', /阴郁|忧郁|消沉|郁郁寡欢|低落/u],
    ['温和', /温和|温柔|柔和|体贴|和善/u],
    ['多疑', /多疑|猜忌|疑心|难以信任|不再轻信/u],
    ['信任', /信任|信赖|愿意相信/u],
    ['依赖', /依赖|依恋|黏人|离不开/u],
    ['独立', /独立|自主|不再依赖/u],
    ['强势', /强势|霸道|专断|咄咄逼人/u],
    ['顺从', /顺从|顺服|服从|逆来顺受/u],
    ['自信', /自信|笃定|相信自己/u],
    ['自卑', /自卑|自我怀疑|否定自己|妄自菲薄/u],
    ['冲动', /冲动|鲁莽|不计后果/u],
    ['谨慎', /谨慎|小心|深思熟虑|三思而后行/u],
    ['残忍', /残忍|冷酷|狠辣|心狠/u],
    ['善良', /善良|仁慈|心软|富有同情心/u],
    ['固执', /固执|执拗|顽固|不肯让步/u],
    ['圆滑', /圆滑|世故|八面玲珑/u],
    ['乐观', /乐观|积极|充满希望/u],
    ['悲观', /悲观|消极|不抱希望/u],
    ['敏感', /敏感|容易受伤|在意他人看法/u],
    ['麻木', /麻木|迟钝|无动于衷/u],
    ['亲近', /亲近|亲密|靠近|关系升温/u],
    ['敌视', /敌视|敌意|仇视|憎恨/u],
    ['畏惧', /畏惧|害怕|恐惧|忌惮/u],
    ['保护', /保护|守护|护着|维护/u],
]);
const OPPOSITE_TRAITS = new Set([
    '外向|内向', '温和|易怒', '信任|多疑', '依赖|独立', '强势|顺从',
    '自信|自卑', '冲动|谨慎', '残忍|善良', '乐观|悲观', '敏感|麻木',
    '亲近|疏离', '亲近|敌视',
]);
let developmentUiBound = false;

function cleanText(value, maximum = 1200) {
    return String(value ?? '').trim().slice(0, maximum);
}

function getStore(metadata, create = false) {
    const existing = metadata?.[CHARACTER_DEVELOPMENT_METADATA_KEY];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        existing.version = Number(existing.version) || 1;
        existing.profiles ??= {};
        existing.candidates ??= {};
        existing.processed ??= {};
        existing.dismissed ??= {};
        return existing;
    }
    if (!create || !metadata || typeof metadata !== 'object') return null;
    metadata[CHARACTER_DEVELOPMENT_METADATA_KEY] = {
        version: CANDIDATE_STORE_VERSION,
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

function normalizeMeaningText(value) {
    return cleanText(value, 600)
        .toLocaleLowerCase()
        .replace(/(?:已经|逐渐|开始|变得|越来越|更加|更为|明显|显得|表现得|似乎|有些|有点|倾向于)/gu, '')
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function getSemanticTraits(value) {
    const text = cleanText(value, 1200).toLocaleLowerCase();
    const traits = SEMANTIC_TRAIT_GROUPS
        .filter(([, pattern]) => pattern.test(text))
        .map(([trait]) => trait);
    const replaceNegatedTrait = (pattern, removed, added = '') => {
        if (!pattern.test(text)) return;
        const index = traits.indexOf(removed);
        if (index >= 0) traits.splice(index, 1);
        if (added && !traits.includes(added)) traits.push(added);
    };
    replaceNegatedTrait(/不再(?:依赖|黏人)/u, '依赖', '独立');
    replaceNegatedTrait(/不再(?:信任|信赖|轻信)/u, '信任', '多疑');
    replaceNegatedTrait(/不再(?:开朗|外向|健谈)/u, '外向', '内向');
    replaceNegatedTrait(/不再(?:亲近|亲密)/u, '亲近', '疏离');
    replaceNegatedTrait(/不再(?:温和|温柔)/u, '温和');
    return [...new Set(traits)];
}

function hasOppositeTraits(leftTraits, rightTraits) {
    return leftTraits.some(left => rightTraits.some(right => (
        OPPOSITE_TRAITS.has(`${left}|${right}`) || OPPOSITE_TRAITS.has(`${right}|${left}`)
    )));
}

function getSemanticFingerprint(change) {
    const trend = cleanText(change?.trend, 80);
    const traits = getSemanticTraits(`${trend} ${change?.after ?? ''}`);
    if (traits.length > 0) return traits.sort().join('+');
    return normalizeMeaningText(trend || change?.after);
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
    const rawMerges = Array.isArray(source.merges ?? source.合并) ? (source.merges ?? source.合并) : [];
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
                candidateId: cleanText(change.candidateId ?? change.candidate_id ?? change.候选编号, 1000),
                trend: cleanText(change.trend ?? change.trait ?? change.趋势, 80),
                before: cleanText(change.before ?? change.原先, 400),
                after,
                reason: cleanText(change.reason ?? change.原因, 500),
                source: ['user_direct', 'observed'].includes(sourceType) ? sourceType : 'observed',
                evidence: normalizeEvidence(change.evidence ?? change.依据),
            };
        }).filter(Boolean).slice(0, 12),
        merges: rawMerges.map((merge) => {
            if (!merge || typeof merge !== 'object') return null;
            const intoId = cleanText(merge.intoId ?? merge.into_id ?? merge.保留编号, 1000);
            const fromSource = merge.fromIds ?? merge.from_ids ?? merge.合并编号;
            const fromIds = (Array.isArray(fromSource) ? fromSource : fromSource ? [fromSource] : [])
                .map(id => cleanText(id, 1000))
                .filter(Boolean)
                .slice(0, 20);
            if (!intoId || fromIds.length === 0) return null;
            return {
                intoId,
                fromIds,
                trend: cleanText(merge.trend ?? merge.趋势, 80),
                after: cleanText(merge.after ?? merge.summary ?? merge.合并描述, 600),
            };
        }).filter(Boolean).slice(0, 20),
    };
}

function getFieldKey(dimension, target = '') {
    return `${dimension}::${cleanText(target, 120).toLocaleLowerCase()}`;
}

function stableCandidateHash(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function getCandidateKey(change) {
    const identity = `${change.character.toLocaleLowerCase()}::${getFieldKey(change.dimension, change.target)}::${getSemanticFingerprint(change)}`;
    return `development-${stableCandidateHash(identity)}`;
}

function validateEvidence(context, evidence) {
    return evidence.filter((item) => {
        const message = context?.chat?.[item.messageId];
        if (!message) return false;
        const messageText = String(message.mes ?? '');
        if (messageText.includes(item.quote)) return true;
        const normalizeQuote = value => String(value ?? '')
            .toLocaleLowerCase()
            .replace(/[\s\p{P}\p{S}]+/gu, '');
        const quote = normalizeQuote(item.quote);
        return quote.length >= 6 && normalizeQuote(messageText).includes(quote);
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

function isSameCandidateField(left, right) {
    return cleanText(left?.character, 120).toLocaleLowerCase() === cleanText(right?.character, 120).toLocaleLowerCase()
        && getFieldKey(left?.dimension, left?.target) === getFieldKey(right?.dimension, right?.target);
}

function isSameCandidateCharacter(left, right) {
    return cleanText(left?.character, 120).toLocaleLowerCase()
        === cleanText(right?.character, 120).toLocaleLowerCase();
}

function areCandidateMeaningsCompatible(left, right, { allowFieldDrift = false } = {}) {
    if (!isSameCandidateCharacter(left, right)) return false;
    const sameField = isSameCandidateField(left, right);
    if (!sameField && !allowFieldDrift) return false;
    const leftTarget = cleanText(left?.target, 120).toLocaleLowerCase();
    const rightTarget = cleanText(right?.target, 120).toLocaleLowerCase();
    if (!sameField && leftTarget && rightTarget && leftTarget !== rightTarget) return false;
    const leftTraits = getSemanticTraits(`${left?.trend ?? ''} ${left?.after ?? ''}`);
    const rightTraits = getSemanticTraits(`${right?.trend ?? ''} ${right?.after ?? ''}`);
    if (hasOppositeTraits(leftTraits, rightTraits)) return false;
    if (leftTraits.some(trait => rightTraits.includes(trait))) return true;
    if (!sameField) return false;
    const leftFingerprint = getSemanticFingerprint(left);
    const rightFingerprint = getSemanticFingerprint(right);
    if (leftFingerprint && leftFingerprint === rightFingerprint) return true;
    const leftText = normalizeMeaningText(left?.trend || left?.after);
    const rightText = normalizeMeaningText(right?.trend || right?.after);
    return Math.min(leftText.length, rightText.length) >= 4
        && (leftText.includes(rightText) || rightText.includes(leftText));
}

function chooseConciseCandidateText(existing, incoming) {
    const left = cleanText(existing, 600);
    const right = cleanText(incoming, 600);
    if (!left) return right;
    if (!right) return left;
    const leftMeaning = normalizeMeaningText(left);
    const rightMeaning = normalizeMeaningText(right);
    if (leftMeaning.includes(rightMeaning) && right.length < left.length) return right;
    if (rightMeaning.includes(leftMeaning)) return left;
    const leftTraits = getSemanticTraits(left);
    const rightTraits = getSemanticTraits(right);
    if (leftTraits.some(trait => rightTraits.includes(trait))) {
        return right.length < left.length ? right : left;
    }
    return left;
}

function mergeCandidateRecords(target, source, overrides = {}) {
    const targetLastSeen = Number(target?.lastSeenMessageId) || 0;
    const sourceLastSeen = Number(source?.lastSeenMessageId) || 0;
    const latest = sourceLastSeen >= targetLastSeen ? source : target;
    const evidence = [];
    const evidenceKeys = new Set();
    for (const item of [...(target?.evidence ?? []), ...(source?.evidence ?? [])]) {
        const key = `${item?.messageId}:${item?.quote}`;
        if (!item?.quote || evidenceKeys.has(key)) continue;
        evidenceKeys.add(key);
        evidence.push(item);
    }
    const semanticTraits = getSemanticTraits(`${overrides.trend ?? ''} ${overrides.after ?? ''} ${target?.after ?? ''} ${source?.after ?? ''}`);
    const firstSeen = Math.min(
        Number(target?.firstSeenMessageId) || Number.POSITIVE_INFINITY,
        Number(source?.firstSeenMessageId) || Number.POSITIVE_INFINITY,
    );
    return {
        ...target,
        character: target.character || source.character,
        dimension: target.dimension || source.dimension,
        target: target.target || source.target || '',
        before: target.before || source.before || '',
        trend: cleanText(overrides.trend || target.trend || source.trend || semanticTraits[0] || '', 80),
        after: cleanText(overrides.after || chooseConciseCandidateText(target.after, source.after) || latest.after, 600),
        reason: cleanText(latest.reason || target.reason || source.reason, 500),
        evidence: evidence.slice(-24),
        sceneKeys: [...new Set([...(target?.sceneKeys ?? []), ...(source?.sceneKeys ?? [])])].slice(-24),
        firstSeenMessageId: Number.isFinite(firstSeen) ? firstSeen : Math.max(targetLastSeen, sourceLastSeen),
        lastSeenMessageId: Math.max(targetLastSeen, sourceLastSeen),
    };
}

function consolidateStoredCandidates(store, currentMessageId) {
    const candidates = Object.values(store?.candidates ?? {})
        .filter(candidate => candidate && typeof candidate === 'object')
        .sort((left, right) => Number(left.firstSeenMessageId) - Number(right.firstSeenMessageId));
    const consolidated = {};
    for (const rawCandidate of candidates) {
        const inferredTraits = getSemanticTraits(`${rawCandidate.trend ?? ''} ${rawCandidate.after ?? ''}`);
        const candidate = {
            ...rawCandidate,
            character: cleanText(rawCandidate.character, 120),
            dimension: normalizeDimension(rawCandidate.dimension),
            target: cleanText(rawCandidate.target, 120),
            trend: cleanText(rawCandidate.trend || inferredTraits[0] || '', 80),
            after: cleanText(rawCandidate.after, 600),
            evidence: Array.isArray(rawCandidate.evidence) ? rawCandidate.evidence : [],
            sceneKeys: Array.isArray(rawCandidate.sceneKeys) ? rawCandidate.sceneKeys : [],
        };
        if (!candidate.character || !candidate.dimension || !candidate.after) continue;
        const lastSeen = Number(candidate.lastSeenMessageId) || Number(candidate.firstSeenMessageId) || 0;
        if (Number(currentMessageId) - lastSeen > CANDIDATE_STALE_FLOORS) continue;
        const compatible = Object.values(consolidated)
            .find(existing => areCandidateMeaningsCompatible(existing, candidate));
        if (compatible) {
            consolidated[compatible.id] = mergeCandidateRecords(compatible, candidate);
            continue;
        }
        let id = getCandidateKey(candidate);
        if (consolidated[id]) id = `${id}::${Number(candidate.firstSeenMessageId) || Object.keys(consolidated).length}`;
        consolidated[id] = { ...candidate, id };
    }

    const perField = new Map();
    for (const candidate of Object.values(consolidated)) {
        const field = `${candidate.character.toLocaleLowerCase()}::${getFieldKey(candidate.dimension, candidate.target)}`;
        const group = perField.get(field) ?? [];
        group.push(candidate);
        perField.set(field, group);
    }
    store.candidates = {};
    for (const group of perField.values()) {
        group.sort((left, right) => Number(right.lastSeenMessageId) - Number(left.lastSeenMessageId));
        for (const candidate of group.slice(0, CANDIDATE_LIMIT_PER_FIELD)) {
            store.candidates[candidate.id] = candidate;
        }
    }
    store.version = CANDIDATE_STORE_VERSION;
}

function applyCandidateMerges(store, merges) {
    for (const merge of merges) {
        const target = store.candidates?.[merge.intoId];
        if (!target) continue;
        for (const sourceId of merge.fromIds) {
            if (sourceId === merge.intoId) continue;
            const source = store.candidates[sourceId];
            if (!source || (!isSameCandidateField(target, source)
                && !areCandidateMeaningsCompatible(target, source, { allowFieldDrift: true }))) continue;
            store.candidates[merge.intoId] = mergeCandidateRecords(store.candidates[merge.intoId], source, merge);
            delete store.candidates[sourceId];
        }
    }
}

function promoteMatureCandidates(store, ownerMessageId) {
    let promotedCount = 0;
    for (const [candidateId, candidate] of Object.entries({ ...store.candidates })) {
        if (!store.candidates[candidateId]) continue;
        const evidenceIds = (candidate.evidence ?? []).map(item => Number(item.messageId)).filter(Number.isInteger);
        const floorSpan = evidenceIds.length > 0 ? Math.max(...evidenceIds) - Math.min(...evidenceIds) : 0;
        if ((candidate.evidence?.length ?? 0) < 3 || (candidate.sceneKeys?.length ?? 0) < 2 || floorSpan < 10) continue;
        const promoted = upsertConfirmedField(store, candidate, ownerMessageId, 'confirmed');
        delete store.candidates[candidateId];
        if (!promoted.blocked) promotedCount++;
    }
    return promotedCount;
}

function findCandidateForChange(store, change) {
    const explicit = cleanText(change.candidateId, 1000);
    if (explicit && store.candidates?.[explicit]
        && areCandidateMeaningsCompatible(store.candidates[explicit], change, { allowFieldDrift: true })) {
        return store.candidates[explicit];
    }
    return Object.values(store.candidates ?? {})
        .find(candidate => areCandidateMeaningsCompatible(candidate, change)) ?? null;
}

export function applyCharacterDevelopmentUpdate(context, ownerMessageId, value, options = {}) {
    const numericId = Number(ownerMessageId);
    const store = getStore(context?.chatMetadata, true);
    if (!store || !Number.isInteger(numericId)) return { confirmed: 0, observed: 0, rejected: 0 };
    const update = normalizeDevelopmentUpdate(value);
    consolidateStoredCandidates(store, numericId);
    applyCandidateMerges(store, update.merges);
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
    confirmed += promoteMatureCandidates(store, numericId);

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
        if (change.source === 'observed' && options?.baselineKnown === false) {
            rejected++;
            continue;
        }
        if (userCharacters.has(change.character.toLocaleLowerCase())) {
            rejected++;
            continue;
        }

        const matchedCandidate = findCandidateForChange(store, change);
        const key = matchedCandidate?.id ?? getCandidateKey(change);
        if (store.dismissed[key]) {
            rejected++;
            continue;
        }
        const candidate = matchedCandidate ?? {
            id: key,
            character: change.character,
            dimension: change.dimension,
            target: change.target,
            before: change.before,
            trend: change.trend || getSemanticTraits(change.after)[0] || '',
            after: change.after,
            reason: change.reason,
            evidence: [],
            sceneKeys: [],
            firstSeenMessageId: numericId,
        };
        candidate.trend = change.trend || candidate.trend || getSemanticTraits(change.after)[0] || '';
        candidate.after = chooseConciseCandidateText(candidate.after, change.after);
        candidate.reason = candidate.reason || change.reason;
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
        if (candidate.evidence.length >= 3 && candidate.sceneKeys.length >= 2 && floorSpan >= 10) {
            const promoted = upsertConfirmedField(store, candidate, numericId, 'confirmed');
            delete store.candidates[key];
            if (!promoted.blocked) confirmed++;
        }
    }

    consolidateStoredCandidates(store, numericId);

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
    return !sourceHash || Boolean(record.sourceHash && record.sourceHash === sourceHash);
}

export function clearCharacterDevelopmentRecords(context, firstChangedMessageId) {
    const numericId = Number(firstChangedMessageId);
    const store = getStore(context?.chatMetadata);
    if (!store || !Number.isInteger(numericId) || numericId < 0) return false;
    let changed = false;

    for (const messageId of Object.keys(store.processed ?? {})) {
        const storedId = Number(messageId);
        if (Number.isInteger(storedId) && storedId >= numericId) {
            delete store.processed[messageId];
            changed = true;
        }
    }

    // Pending observations are automatic guesses. Once the reply that last
    // supported one is edited, swiped away, or deleted, keeping the merged
    // candidate would let a rejected plot branch affect later confirmations.
    // Discard the affected candidate conservatively; future valid scenes can
    // build it up again.
    for (const [candidateId, candidate] of Object.entries(store.candidates ?? {})) {
        const firstSeen = Number(candidate?.firstSeenMessageId);
        const lastSeen = Number(candidate?.lastSeenMessageId);
        if ((Number.isInteger(firstSeen) && firstSeen >= numericId)
            || (Number.isInteger(lastSeen) && lastSeen >= numericId)) {
            delete store.candidates[candidateId];
            changed = true;
        }
    }

    for (const [profileKey, profile] of Object.entries(store.profiles ?? {})) {
        profile.history = Array.isArray(profile.history) ? profile.history : [];
        for (const [fieldKey, field] of Object.entries(profile.fields ?? {})) {
            if (field?.source === 'manual' || Number(field?.updatedMessageId) < numericId) continue;
            const previousIndex = profile.history
                .map((item, index) => ({ item, index }))
                .filter(({ item }) => item?.key === fieldKey
                    && Number(item?.updatedMessageId) < numericId)
                .sort((left, right) => Number(right.item.updatedMessageId) - Number(left.item.updatedMessageId))[0]?.index;
            if (Number.isInteger(previousIndex)) {
                const previous = profile.history[previousIndex];
                profile.fields[fieldKey] = { ...previous };
            } else {
                delete profile.fields[fieldKey];
            }
            changed = true;
        }
        profile.history = profile.history.filter(item => Number(item?.replacedAtMessageId) < numericId
            && Number(item?.updatedMessageId) < numericId);
        if (Object.keys(profile.fields ?? {}).length === 0) {
            delete store.profiles[profileKey];
        }
    }
    return changed;
}

export function getCharacterDevelopmentSnapshot(context, {
    includeCandidates = false,
    compactCandidates = false,
    limitCandidates = Number.POSITIVE_INFINITY,
    limitProfiles = Number.POSITIVE_INFINITY,
} = {}) {
    const store = getStore(context?.chatMetadata);
    if (!store) return { profiles: [], candidates: [] };
    if (Number(store.version) < CANDIDATE_STORE_VERSION) {
        consolidateStoredCandidates(store, Math.max(0, Number(context?.chat?.length ?? 1) - 1));
        promoteMatureCandidates(store, Math.max(0, Number(context?.chat?.length ?? 1) - 1));
        void Promise.resolve(context?.saveMetadata?.())
            .catch(error => console.warn('[Memory Augment] Character development migration save failed.', error));
    }
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
    const candidateValues = Object.values(store.candidates)
        .sort((left, right) => Number(right.lastSeenMessageId) - Number(left.lastSeenMessageId));
    const limitedCandidates = Number.isFinite(Number(limitCandidates))
        ? candidateValues.slice(0, Math.max(0, Number(limitCandidates)))
        : candidateValues;
    return {
        profiles: limitedProfiles,
        candidates: includeCandidates ? limitedCandidates.map(candidate => compactCandidates ? {
            id: candidate.id,
            character: candidate.character,
            dimension: candidate.dimension,
            target: candidate.target,
            trend: candidate.trend || getSemanticTraits(candidate.after)[0] || '',
            after: cleanText(candidate.after, 180),
            evidenceCount: Array.isArray(candidate.evidence) ? candidate.evidence.length : 0,
            sceneCount: Array.isArray(candidate.sceneKeys) ? candidate.sceneKeys.length : 0,
            firstSeenMessageId: candidate.firstSeenMessageId,
            lastSeenMessageId: candidate.lastSeenMessageId,
        } : { ...candidate }) : [],
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
        text.textContent = candidate.trend || cleanText(candidate.after, 120);
        if (candidate.trend && candidate.after && candidate.trend !== candidate.after) {
            text.title = candidate.after;
        }
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
