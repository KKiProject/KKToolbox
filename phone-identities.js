import { normalizePhoneIdentity } from './phone-store.js';
import { loadAssociatedWorldInfoBooks } from './world-info-manager.js';
import { cleanPhoneText as text } from './phone-utils.js';

function characterCardPrompt(context) {
    const character = context?.characters?.[context?.characterId];
    if (!character) return null;
    const data = character.data ?? {};
    const name = text(character.name ?? data.name, 120) || '当前角色';
    const fields = [
        ['角色名', name],
        ['角色描述', character.description ?? data.description],
        ['性格', character.personality ?? data.personality],
        ['场景设定', character.scenario ?? data.scenario],
    ].map(([label, value]) => [label, text(value, 8000)])
        .filter(([, value]) => value);
    return {
        key: 'character_card',
        mode: 'character_card',
        label: `角色卡主角 · ${name}`,
        matchNames: [name],
        persona: fields.map(([label, value]) => `【${label}】\n${value}`).join('\n\n').slice(0, 16000),
    };
}

export async function loadPhoneIdentitySources(
    context,
    bookLoader = loadAssociatedWorldInfoBooks,
) {
    const sources = [];
    const card = characterCardPrompt(context);
    if (card?.persona) sources.push(card);
    let books = [];
    try {
        books = (await bookLoader(null, context)).filter(book => book.linkedToCharacter === true);
    } catch {
        books = [];
    }
    for (const book of books) {
        for (const entry of book.entries ?? []) {
            if (!isPhoneIdentityEntry(entry)) continue;
            const persona = text(entry?.content, 16000);
            if (!persona) continue;
            const entryName = text(entry?.name, 160) || text(entry?.entryKey, 160) || '未命名条目';
            const aliases = String(entry?.entryKey ?? '').split(/[,，|、]/u).map(item => text(item, 120)).filter(Boolean);
            sources.push({
                key: `worldbook:${entry.key}`,
                mode: 'worldbook',
                label: `世界书 · ${entryName}`,
                matchNames: [entryName, ...aliases],
                persona,
            });
        }
    }
    return sources;
}

export function isPhoneIdentityEntry(entry) {
    const name = text(entry?.name, 160);
    const content = text(entry?.content, 6000);
    if (!name || !content || /^\[KKT(?:摘要|历史概括)\]/u.test(name)) return false;
    const personFields = /(?:姓名|本名|年龄|性别|身份|职业|性格|个性|人格|外貌|人物关系|角色定位|喜好|厌恶|欲望|信念|口癖|说话方式|personality|appearance|identity|relationship)/iu;
    if (personFields.test(content)) return true;
    const genericTitle = /(?:地图|总览|历史|纪元|体系|格局|生态|剧情|清单|大全|道具|玩具|体位|规则|系统|总结|摘要|势力|魔法|种族|设定集)/u;
    if (genericTitle.test(name)) return false;
    const normalizedName = name.replace(/[\s\p{P}\p{S}]+/gu, '');
    const normalizedContent = content.replace(/[\s\p{P}\p{S}]+/gu, '');
    const aliases = String(entry?.entryKey ?? '').split(/[,，|、]/u)
        .map(value => text(value, 120).replace(/[\s\p{P}\p{S}]+/gu, ''))
        .filter(value => value.length >= 2);
    return normalizedName.length >= 2
        && (normalizedContent.includes(normalizedName)
            || aliases.some(alias => normalizedContent.includes(alias))
            || /(?:^|[。！？\n])(?:他|她|祂)[，、是有会曾将]/u.test(content));
}

export function getPhoneIdentitySelectOptions(sources) {
    return [
        { value: 'unbound', label: '暂不绑定（不套用角色卡人物）' },
        ...sources.map(source => ({ value: source.key, label: source.label })),
        { value: 'custom', label: '玩家自定义人物' },
    ];
}

export function getPhoneIdentityFromInput(sourceKey, details, sources) {
    const note = text(details, 4000);
    if (sourceKey === 'custom') {
        if (!note) throw new Error('选择自定义人物时，需要填写人物设定。');
        return normalizePhoneIdentity({ mode: 'custom', label: '玩家自定义人物', persona: note });
    }
    const source = sources.find(item => item.key === sourceKey);
    if (source) {
        return normalizePhoneIdentity({
            mode: source.mode,
            sourceKey: source.key,
            label: source.label,
            persona: source.persona,
            note,
        });
    }
    return normalizePhoneIdentity({ mode: 'unbound', label: '尚未绑定', note });
}

export function findPhoneIdentitySourceForName(name, sources) {
    const normalized = text(name, 120).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    if (!normalized) return null;
    return sources.find(source => (source.matchNames ?? []).some(candidate => {
        const value = text(candidate, 120).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
        return value && value === normalized;
    })) ?? null;
}
