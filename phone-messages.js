import { generatePhoneCompletion } from './rag-client.js';
import {
    addPhoneSticker,
    appendPhoneMessage,
    buildPhoneAiSnapshot,
    commitQueuedPhoneMessages,
    createPhoneRoundId,
    createPhoneConversation,
    forwardPhoneMessages,
    getQueuedPhoneMessages,
    getRecentRoundMessages,
    loadPhoneStore,
    normalizePhoneIdentity,
    normalizePhoneProfile,
    normalizePhoneStickers,
    recordPhoneMemoryEvents,
    removePhoneConversation,
    removeLatestPhoneReply,
    removePhoneMessage,
    removePhoneSticker,
    removePhoneMemoryEvent,
    savePhoneStore,
    setPhoneRoundSummary,
    splitGroupRedPacket,
    renamePhoneConversation,
    updatePhoneMessage,
    updatePhoneMemoryEvent,
    uploadPhoneImage,
} from './phone-store.js';
import { loadAssociatedWorldInfoBooks } from './world-info-manager.js';
import { preparePhoneStoryContext } from './phone-context.js';

function text(value, maximum = 4000) {
    return String(value ?? '').trim().slice(0, maximum);
}

function avatarElement(documentRef, name, url = '', className = '') {
    const avatar = documentRef.createElement('span');
    avatar.className = `memory-augment-phone-contact-avatar ${className}`.trim();
    if (url) {
        const image = documentRef.createElement('img');
        image.src = url;
        image.alt = '';
        image.loading = 'lazy';
        avatar.append(image);
    } else {
        avatar.textContent = Array.from(text(name, 20))[0] ?? '?';
    }
    return avatar;
}

function lastMessagePreview(message) {
    if (!message) return '还没有消息';
    const labels = {
        voice: '[语音]', image: '[图片]', redpacket: '[红包]', group_redpacket: '[群红包]',
        location: '[位置]', sticker: `[表情包] ${message.stickerName}`,
    };
    return text(labels[message.type] ?? message.content, 80) || '[消息]';
}

function messageReferenceContent(message) {
    if (message.type === 'sticker') return `[表情包] ${message.stickerName || '未知'}`;
    if (message.type === 'voice') return `[语音] ${message.content || '无文字'}`;
    if (message.type === 'image') return `[图片] ${message.content || '无描述'}`;
    if (message.type === 'location') return `[位置] ${message.content || '无描述'}`;
    if (['redpacket', 'group_redpacket'].includes(message.type)) {
        return `[${message.type === 'group_redpacket' ? '群红包' : '红包'}] ${message.amount}元 ${message.content || ''}`.trim();
    }
    return message.content || '[消息]';
}

function parseJsonObject(raw) {
    const source = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try {
        return JSON.parse(source);
    } catch {
        const start = source.indexOf('{');
        const end = source.lastIndexOf('}');
        if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
        throw new Error('手机副 API 没有返回有效 JSON。');
    }
}

export function parsePhoneAiBundle(raw) {
    const parsed = parseJsonObject(raw);
    if (!Array.isArray(parsed?.messages)) throw new Error('手机副 API 没有返回消息列表。');
    const messages = parsed.messages.slice(0, 8).map(item => ({
        sender: text(item?.sender, 80),
        type: ['text', 'voice', 'image', 'redpacket', 'group_redpacket', 'location', 'sticker']
            .includes(item?.type) ? item.type : 'text',
        content: text(item?.content, 4000),
        duration: Math.max(1, Math.min(60, Math.trunc(Number(item?.duration) || 1))),
        amount: Math.max(0, Number(item?.amount) || 0),
        count: Math.max(0, Math.trunc(Number(item?.count) || 0)),
        stickerName: text(item?.stickerName ?? item?.sticker, 120),
    }));
    const memoryEvents = (Array.isArray(parsed?.memory?.events) ? parsed.memory.events : [])
        .slice(0, 12)
        .map(item => ({
            type: text(item?.type, 40),
            summary: text(item?.summary, 600),
            participants: Array.isArray(item?.participants)
                ? item.participants.map(value => text(value, 80)).filter(Boolean)
                : [],
            sourceMessageIds: Array.isArray(item?.sourceMessageIds)
                ? item.sourceMessageIds.map(value => text(value, 120)).filter(Boolean)
                : [],
            evidenceQuotes: Array.isArray(item?.evidenceQuotes)
                ? item.evidenceQuotes.map(value => text(value, 500)).filter(Boolean)
                : [],
            status: text(item?.status, 40),
            resolvesEventIds: Array.isArray(item?.resolvesEventIds)
                ? item.resolvesEventIds.map(value => text(value, 120)).filter(Boolean)
                : [],
        }));
    return {
        messages,
        memoryEvents,
        roundSummary: text(parsed?.roundSummary, 1200),
    };
}

export function parsePhoneAiResponse(raw) {
    return parsePhoneAiBundle(raw).messages;
}

function createField(documentRef, descriptor) {
    const label = documentRef.createElement(descriptor.type === 'file' ? 'div' : 'label');
    label.className = 'memory-augment-phone-form-field';
    const caption = documentRef.createElement('span');
    caption.textContent = descriptor.label;
    const input = descriptor.type === 'textarea'
        ? documentRef.createElement('textarea')
        : descriptor.type === 'select'
            ? documentRef.createElement('select')
            : documentRef.createElement('input');
    if (!['textarea', 'select'].includes(descriptor.type)) input.type = descriptor.type ?? 'text';
    input.name = descriptor.name;
    input.placeholder = descriptor.placeholder ?? '';
    if (descriptor.min !== undefined) input.min = String(descriptor.min);
    if (descriptor.max !== undefined) input.max = String(descriptor.max);
    if (descriptor.accept) input.accept = descriptor.accept;
    if (descriptor.required) input.required = true;
    if (descriptor.type === 'select') {
        for (const optionDescriptor of descriptor.options ?? []) {
            const option = documentRef.createElement('option');
            option.value = optionDescriptor.value;
            option.textContent = optionDescriptor.label;
            input.append(option);
        }
    }
    input.value = descriptor.value ?? '';
    if (descriptor.type === 'file') {
        input.hidden = true;
        const picker = documentRef.createElement('div');
        picker.className = 'memory-augment-phone-file-picker';
        const choose = documentRef.createElement('button');
        choose.type = 'button';
        choose.textContent = '选择本地图片';
        const chosen = documentRef.createElement('span');
        chosen.textContent = '未选择图片';
        choose.addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
            chosen.textContent = input.files?.[0]?.name || '未选择图片';
        });
        picker.append(choose, chosen, input);
        label.append(caption, picker);
    } else {
        label.append(caption, input);
    }
    return { label, input };
}

function openForm(root, config) {
    return new Promise((resolve) => {
        root.querySelector('.memory-augment-phone-sheet-overlay')?.remove();
        const documentRef = root.ownerDocument;
        const overlay = documentRef.createElement('div');
        overlay.className = 'memory-augment-phone-sheet-overlay';
        const form = documentRef.createElement('form');
        form.className = 'memory-augment-phone-sheet';
        const heading = documentRef.createElement('h3');
        heading.textContent = config.title;
        const fields = new Map();
        form.append(heading);
        if (config.message) {
            const message = documentRef.createElement('p');
            message.className = 'memory-augment-phone-confirm-message';
            message.textContent = config.message;
            form.append(message);
        }
        for (const descriptor of config.fields ?? []) {
            const field = createField(documentRef, descriptor);
            fields.set(descriptor.name, field.input);
            form.append(field.label);
        }
        const error = documentRef.createElement('div');
        error.className = 'memory-augment-phone-form-error';
        const actions = documentRef.createElement('div');
        actions.className = 'memory-augment-phone-sheet-actions';
        const cancel = documentRef.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '取消';
        const submit = documentRef.createElement('button');
        submit.type = 'submit';
        submit.textContent = config.submitLabel ?? '确定';
        if (config.danger) submit.classList.add('is-danger');
        actions.append(cancel, submit);
        form.append(error, actions);
        overlay.append(form);
        root.append(overlay);
        const close = (value) => {
            overlay.remove();
            resolve(value);
        };
        cancel.addEventListener('click', () => close(null));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) close(null);
        });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            submit.disabled = true;
            error.textContent = '';
            const values = {};
            fields.forEach((input, name) => {
                values[name] = input.type === 'file' ? input.files?.[0] ?? null : input.value;
            });
            try {
                const result = config.onSubmit ? await config.onSubmit(values) : values;
                close(result ?? values);
            } catch (formError) {
                error.textContent = formError.message;
                submit.disabled = false;
            }
        });
        fields.values().next().value?.focus?.();
    });
}

async function openConfirm(root, config) {
    return Boolean(await openForm(root, {
        title: config.title ?? '请确认',
        message: config.message,
        submitLabel: config.confirmLabel ?? '确定',
        danger: config.danger !== false,
        fields: [],
        onSubmit: () => true,
    }));
}

async function resolveImage(values, prefix) {
    if (values.file) return uploadPhoneImage(values.file, prefix);
    const url = text(values.url, 4000);
    if (!url) return '';
    let parsed;
    try {
        parsed = new URL(url, globalThis.location?.origin ?? 'http://localhost');
    } catch {
        throw new Error('图片链接格式不正确。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) && !url.startsWith('/user/files/')) {
        throw new Error('图片链接必须使用 http 或 https。');
    }
    return url;
}

function collectRecentStory(context) {
    return (Array.isArray(context?.chat) ? context.chat : [])
        .filter(message => !message?.is_system && text(message?.mes))
        .slice(-8)
        .map((message, index) => {
            const role = message.is_user ? '玩家' : text(message.name, 80) || '角色';
            return `[${role}] ${text(message.mes, 3000)}`;
        });
}

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

function identitySelectOptions(sources) {
    return [
        { value: 'unbound', label: '暂不绑定（不套用角色卡人物）' },
        ...sources.map(source => ({ value: source.key, label: source.label })),
        { value: 'custom', label: '玩家自定义人物' },
    ];
}

function identityFromInput(sourceKey, details, sources) {
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

function findIdentitySourceForName(name, sources) {
    const normalized = text(name, 120).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    if (!normalized) return null;
    return sources.find(source => (source.matchNames ?? []).some(candidate => {
        const value = text(candidate, 120).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
        return value && value === normalized;
    })) ?? null;
}

function messageText(documentRef, className, value) {
    const element = documentRef.createElement('div');
    element.className = className;
    element.textContent = value;
    return element;
}

function renderMessageReferences(documentRef, message) {
    const fragment = documentRef.createDocumentFragment();
    if (message.forwardedFrom) {
        fragment.append(messageText(
            documentRef,
            'memory-augment-phone-message-reference is-forwarded',
            `转发自 ${message.forwardedFrom.conversationName || '其他会话'} · ${message.forwardedFrom.sender || '未知'}`,
        ));
    }
    if (message.quote) {
        fragment.append(messageText(
            documentRef,
            'memory-augment-phone-message-reference is-quote',
            `${message.quote.sender || '未知'}：${message.quote.content || '消息'}`,
        ));
    }
    return fragment;
}

function renderMessageBody(documentRef, message, stickers, onClaims) {
    if (message.type === 'sticker') {
        const sticker = stickers.find(item => item.name === message.stickerName);
        const wrapper = documentRef.createElement('div');
        wrapper.className = 'memory-augment-phone-sticker-message';
        if (sticker?.url) {
            const image = documentRef.createElement('img');
            image.src = sticker.url;
            image.alt = message.stickerName;
            image.title = message.stickerName;
            image.loading = 'lazy';
            wrapper.append(image);
        } else {
            wrapper.textContent = `[表情包：${message.stickerName || '未知'}]`;
        }
        return wrapper;
    }
    if (message.type === 'voice') {
        const wrapper = documentRef.createElement('div');
        wrapper.className = 'memory-augment-phone-voice-message';
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.innerHTML = '<i class="fa-solid fa-volume-high"></i><span class="memory-augment-phone-wave">···</span>';
        const duration = documentRef.createElement('span');
        duration.textContent = `${message.duration}″`;
        button.append(duration);
        const transcript = messageText(documentRef, 'memory-augment-phone-voice-transcript', message.content || '（无语音文字）');
        transcript.hidden = true;
        button.addEventListener('click', () => transcript.hidden = !transcript.hidden);
        wrapper.append(button, transcript);
        return wrapper;
    }
    if (message.type === 'image') {
        const card = documentRef.createElement('div');
        card.className = 'memory-augment-phone-sim-card is-image';
        card.innerHTML = '<i class="fa-solid fa-image" aria-hidden="true"></i>';
        card.append(messageText(documentRef, '', message.content || '（图片）'));
        return card;
    }
    if (message.type === 'location') {
        const card = documentRef.createElement('div');
        card.className = 'memory-augment-phone-sim-card is-location';
        card.innerHTML = '<i class="fa-solid fa-location-dot" aria-hidden="true"></i>';
        card.append(messageText(documentRef, '', message.content || '（位置）'));
        return card;
    }
    if (message.type === 'redpacket' || message.type === 'group_redpacket') {
        const card = documentRef.createElement('button');
        card.type = 'button';
        card.className = 'memory-augment-phone-redpacket';
        card.innerHTML = '<i class="fa-solid fa-envelope"></i>';
        const copy = documentRef.createElement('span');
        const title = documentRef.createElement('strong');
        title.textContent = message.type === 'group_redpacket' ? '群红包' : '红包';
        const note = documentRef.createElement('small');
        note.textContent = `${message.amount}元${message.content ? ` · ${message.content}` : ''}`;
        copy.append(title, note);
        card.append(copy);
        if (message.type === 'group_redpacket') card.addEventListener('click', () => onClaims(message));
        else card.disabled = true;
        return card;
    }
    return messageText(documentRef, 'memory-augment-phone-message-text', message.content);
}

export function createPhoneMessagesController(options = {}) {
    const documentRef = options.document ?? globalThis.document;
    const settings = options.settings ?? {};
    const contextGetter = options.contextGetter ?? (() => globalThis.SillyTavern?.getContext?.());
    const saveSettings = options.saveSettings ?? (() => contextGetter()?.saveSettingsDebounced?.());
    const generatePhone = options.generatePhone ?? generatePhoneCompletion;
    const prepareStoryContext = options.prepareStoryContext ?? preparePhoneStoryContext;
    let root = null;
    let store = null;
    let currentConversationId = '';
    let busy = false;
    let identitySources = null;
    let selectedMessageIds = new Set();
    let pendingQuote = null;

    const getConversation = () => store?.conversations?.find(item => item.id === currentConversationId);
    const stickers = () => normalizePhoneStickers(settings);

    function setStatus(value, error = false) {
        const status = root?.querySelector('[data-phone-message-status]');
        if (!status) return;
        status.textContent = value;
        status.classList.toggle('is-error', error);
    }

    function showListError(value) {
        renderList();
        const list = root?.querySelector('.memory-augment-phone-conversation-list');
        if (list) list.prepend(messageText(documentRef, 'memory-augment-phone-message-status is-error', value));
    }

    async function persist() {
        await savePhoneStore(store, contextGetter());
    }

    async function getIdentitySources() {
        if (identitySources) return identitySources;
        identitySources = await loadPhoneIdentitySources(contextGetter());
        return identitySources;
    }

    async function editParticipantIdentity(participant, currentIdentity, onSave) {
        const sources = await getIdentitySources();
        const current = normalizePhoneIdentity(currentIdentity);
        const currentValue = current.mode === 'custom'
            ? 'custom'
            : sources.some(source => source.key === current.sourceKey)
                ? current.sourceKey
                : 'unbound';
        const details = current.mode === 'custom' ? current.persona : current.note;
        const result = await openForm(root, {
            title: `设置人物身份 · ${participant}`,
            submitLabel: '保存身份',
            fields: [
                {
                    name: 'source',
                    label: '真实身份来源',
                    type: 'select',
                    value: currentValue,
                    options: identitySelectOptions(sources),
                },
                {
                    name: 'details',
                    label: '自定义人物设定／绑定后的补充说明',
                    type: 'textarea',
                    value: details,
                    placeholder: '例如：这是手机备注名；本人是经纪人沈越。只写需要补充或覆盖的部分。',
                },
            ],
            onSubmit: values => identityFromInput(values.source, values.details, sources),
        });
        if (!result) return false;
        onSave(result);
        try {
            await persist();
            renderConversation();
            return true;
        } catch (error) {
            renderConversation();
            setStatus(`人物身份暂时没保存成功：${error.message}`, true);
            return false;
        }
    }

    async function openGroupIdentityManager() {
        const conversation = getConversation();
        if (!conversation || conversation.type !== 'group') return;
        root.querySelector('.memory-augment-phone-sheet-overlay')?.remove();
        const overlay = documentRef.createElement('div');
        overlay.className = 'memory-augment-phone-sheet-overlay';
        const sheet = documentRef.createElement('section');
        sheet.className = 'memory-augment-phone-sheet';
        const heading = documentRef.createElement('h3');
        heading.textContent = '群成员真实身份';
        const note = messageText(documentRef, 'memory-augment-phone-identity-note', '手机群昵称只是显示名；点成员可绑定角色卡、世界书人物或填写自定义设定。');
        const list = documentRef.createElement('div');
        list.className = 'memory-augment-phone-identity-list';
        for (const member of conversation.members) {
            const identity = normalizePhoneIdentity(conversation.memberIdentities?.[member]);
            const button = documentRef.createElement('button');
            button.type = 'button';
            const memberName = documentRef.createElement('strong');
            memberName.textContent = member;
            const source = documentRef.createElement('span');
            source.textContent = identity.label;
            button.append(memberName, source);
            button.addEventListener('click', () => {
                overlay.remove();
                void editParticipantIdentity(member, identity, value => {
                    conversation.memberIdentities ??= {};
                    conversation.memberIdentities[member] = value;
                });
            });
            list.append(button);
        }
        const actions = documentRef.createElement('div');
        actions.className = 'memory-augment-phone-sheet-actions';
        const close = documentRef.createElement('button');
        close.type = 'button';
        close.textContent = '关闭';
        close.addEventListener('click', () => overlay.remove());
        actions.append(close);
        sheet.append(heading, note, list, actions);
        overlay.append(sheet);
        root.append(overlay);
    }

    async function editConversationIdentities() {
        const conversation = getConversation();
        if (!conversation) return;
        if (conversation.type === 'group') return openGroupIdentityManager();
        return editParticipantIdentity(conversation.name, conversation.identity, value => {
            conversation.identity = value;
        });
    }

    async function editConversationName() {
        const conversation = getConversation();
        if (!conversation || busy) return;
        const direct = conversation.type === 'direct';
        const result = await openForm(root, {
            title: direct ? '修改昵称备注' : '修改群聊名称',
            submitLabel: '保存',
            fields: [{
                name: 'name',
                label: direct ? '昵称备注（只影响手机显示，不是人物本名）' : '群聊名称',
                value: conversation.name,
                required: true,
            }],
        });
        if (!result) return;
        renamePhoneConversation(store, conversation.id, result.name);
        try {
            await persist();
            renderConversation();
        } catch (error) {
            renderConversation();
            setStatus(`名称暂时没保存成功：${error.message}`, true);
        }
    }

    async function deleteCurrentConversation() {
        const conversation = getConversation();
        if (!conversation || busy) return;
        const label = conversation.type === 'group' ? '群聊' : '单聊';
        if (!await openConfirm(root, {
            title: `删除${label}？`,
            message: `“${conversation.name}”的聊天记录和它产生的线上记忆都会删除；已经生成的正文不会改变。`,
            confirmLabel: '确认删除',
        })) return;
        removePhoneConversation(store, conversation.id);
        currentConversationId = '';
        try {
            await persist();
            renderList();
        } catch (error) {
            showListError(`${label}暂时没删除成功：${error.message}`);
        }
    }

    const selectedMessages = () => {
        const conversation = getConversation();
        return conversation?.messages?.filter(message => selectedMessageIds.has(message.id)) ?? [];
    };

    function leaveMessageSelection({ keepQuote = true } = {}) {
        selectedMessageIds = new Set();
        if (!keepQuote) pendingQuote = null;
    }

    function toggleMessageSelection(messageId) {
        const next = new Set(selectedMessageIds);
        if (next.has(messageId)) next.delete(messageId); else next.add(messageId);
        selectedMessageIds = next;
        renderConversation();
    }

    function bindMessageLongPress(row, message) {
        let timer = null;
        let startX = 0;
        let startY = 0;
        let consumed = false;
        const cancel = () => {
            if (timer) clearTimeout(timer);
            timer = null;
        };
        row.addEventListener('pointerdown', event => {
            if (event.button !== undefined && event.button !== 0) return;
            startX = event.clientX;
            startY = event.clientY;
            consumed = false;
            cancel();
            timer = setTimeout(() => {
                timer = null;
                consumed = true;
                selectedMessageIds = new Set([message.id]);
                renderConversation();
            }, 480);
        });
        row.addEventListener('pointermove', event => {
            if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
        });
        row.addEventListener('pointerup', cancel);
        row.addEventListener('pointercancel', cancel);
        row.addEventListener('pointerleave', cancel);
        row.addEventListener('contextmenu', event => {
            event.preventDefault();
            selectedMessageIds = new Set([message.id]);
            renderConversation();
        });
        row.addEventListener('click', event => {
            if (!consumed && selectedMessageIds.size === 0) return;
            event.preventDefault();
            event.stopPropagation();
            if (consumed) {
                consumed = false;
                return;
            }
            toggleMessageSelection(message.id);
        }, true);
    }

    async function deleteSelectedMessages() {
        const conversation = getConversation();
        const messages = selectedMessages();
        if (!conversation || busy || messages.length === 0) return;
        if (!await openConfirm(root, {
            title: `删除选中的 ${messages.length} 条消息？`,
            message: '相应的轮次概括和关联线上记忆也会清理；已经生成的正文不会改变。',
            confirmLabel: '确认删除',
        })) return;
        for (const message of messages) {
            removePhoneMessage(store, conversation.id, message.id);
        }
        leaveMessageSelection();
        try {
            await persist();
            renderConversation();
        } catch (error) {
            renderConversation();
            setStatus(`消息暂时没删除成功：${error.message}`, true);
        }
    }

    async function editSelectedMessage() {
        const conversation = getConversation();
        const [message] = selectedMessages();
        if (!conversation || selectedMessageIds.size !== 1 || !message || busy) return;
        const sticker = message.type === 'sticker';
        const currentStickers = stickers();
        if (sticker && currentStickers.length === 0) {
            leaveMessageSelection();
            renderConversation();
            setStatus('没有可用表情包，无法修改这条表情消息。', true);
            return;
        }
        const result = await openForm(root, {
            title: '编辑消息',
            submitLabel: '保存修改',
            fields: sticker ? [{
                name: 'stickerName',
                label: '表情包',
                type: 'select',
                value: message.stickerName,
                options: currentStickers.map(item => ({ value: item.name, label: item.name })),
            }] : [{
                name: 'content',
                label: message.type === 'voice' ? '语音文字'
                    : message.type === 'image' ? '图片描述'
                        : message.type === 'location' ? '位置与备注'
                            : ['redpacket', 'group_redpacket'].includes(message.type) ? '红包留言' : '消息内容',
                type: 'textarea',
                value: message.content,
                required: true,
            }],
        });
        if (!result) return;
        const update = updatePhoneMessage(store, conversation.id, message.id, result);
        leaveMessageSelection();
        try {
            await persist();
            renderConversation();
            setStatus(`消息已修改${update?.removedMemoryEvents ? `，并清理 ${update.removedMemoryEvents} 条旧线上记忆` : ''}。`);
        } catch (error) {
            renderConversation();
            setStatus(`消息暂时没修改成功：${error.message}`, true);
        }
    }

    async function forwardSelectedMessages() {
        const conversation = getConversation();
        const messages = selectedMessages();
        const targets = store?.conversations?.filter(item => item.id !== conversation?.id) ?? [];
        if (!conversation || messages.length === 0 || busy) return;
        if (targets.length === 0) {
            leaveMessageSelection();
            renderConversation();
            setStatus('还没有其他单聊或群聊可以接收转发。', true);
            return;
        }
        const result = await openForm(root, {
            title: `转发 ${messages.length} 条消息`,
            submitLabel: '转发',
            fields: [{
                name: 'target',
                label: '选择接收聊天',
                type: 'select',
                value: targets[0].id,
                options: targets.map(item => ({
                    value: item.id,
                    label: `${item.type === 'group' ? '群聊' : '单聊'} · ${item.name}`,
                })),
            }],
        });
        if (!result) return;
        const forwarded = forwardPhoneMessages(
            store,
            conversation.id,
            result.target,
            messages.map(message => message.id),
            store.profile.nickname || '我',
        );
        leaveMessageSelection();
        try {
            await persist();
            renderConversation();
            setStatus(`已转发 ${forwarded.length} 条消息。`);
        } catch (error) {
            renderConversation();
            setStatus(`消息暂时没转发成功：${error.message}`, true);
        }
    }

    function quoteSelectedMessage() {
        const [message] = selectedMessages();
        if (selectedMessageIds.size !== 1 || !message) return;
        pendingQuote = {
            messageId: message.id,
            sender: message.sender,
            content: messageReferenceContent(message),
        };
        leaveMessageSelection();
        renderConversation();
        root?.querySelector('.memory-augment-phone-composer textarea')?.focus?.();
    }

    function showClaims(message) {
        const claims = message.claims ?? [];
        void openForm(root, {
            title: `${message.content || '群红包'} · ${message.amount}元`,
            fields: [],
            submitLabel: '看完了',
            onSubmit: () => true,
        }).then(() => undefined);
        const sheet = root.querySelector('.memory-augment-phone-sheet');
        if (!sheet) return;
        const list = documentRef.createElement('div');
        list.className = 'memory-augment-phone-claim-list';
        if (claims.length === 0) list.textContent = '还没有拆分结果。';
        claims.forEach(claim => {
            const row = documentRef.createElement('div');
            const name = documentRef.createElement('span');
            name.textContent = claim.name;
            const amount = documentRef.createElement('strong');
            amount.textContent = `${claim.amount} 元`;
            row.append(name, amount);
            list.append(row);
        });
        sheet.querySelector('.memory-augment-phone-form-error')?.before(list);
    }

    function renderConversation() {
        const conversation = getConversation();
        if (!root || !conversation) return renderList();
        root.replaceChildren();
        const wrapper = documentRef.createElement('div');
        wrapper.className = 'memory-augment-phone-conversation';
        const header = documentRef.createElement('header');
        header.className = 'memory-augment-phone-conversation-header';
        if (selectedMessageIds.size > 0) {
            header.classList.add('is-selecting');
            const closeSelection = documentRef.createElement('button');
            closeSelection.type = 'button';
            closeSelection.className = 'memory-augment-phone-selection-close';
            closeSelection.setAttribute('aria-label', '退出多选');
            closeSelection.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            closeSelection.addEventListener('click', () => {
                leaveMessageSelection();
                renderConversation();
            });
            const count = documentRef.createElement('strong');
            count.textContent = `已选 ${selectedMessageIds.size} 条`;
            const selectAll = documentRef.createElement('button');
            selectAll.type = 'button';
            const everySelected = conversation.messages.length > 0
                && conversation.messages.every(message => selectedMessageIds.has(message.id));
            selectAll.textContent = everySelected ? '取消全选' : '全选';
            selectAll.addEventListener('click', () => {
                selectedMessageIds = everySelected
                    ? new Set()
                    : new Set(conversation.messages.map(message => message.id));
                renderConversation();
            });
            header.append(closeSelection, count, selectAll);
        } else {
            const identity = documentRef.createElement('div');
            identity.append(avatarElement(documentRef, conversation.name, conversation.avatar));
            const title = documentRef.createElement('span');
            const strong = documentRef.createElement('strong');
            strong.textContent = conversation.name;
            const small = documentRef.createElement('small');
            small.textContent = conversation.type === 'group'
                ? `${conversation.members.length + 1} 人 · 长按消息可多选`
                : `昵称备注 · ${normalizePhoneIdentity(conversation.identity).label} · 长按消息可多选`;
            title.append(strong, small);
            identity.append(title);
            const regenerate = documentRef.createElement('button');
            regenerate.type = 'button';
            regenerate.title = '重新生成最近一次回复';
            regenerate.setAttribute('aria-label', '重新生成最近一次回复');
            regenerate.innerHTML = '<i class="fa-solid fa-rotate"></i>';
            regenerate.addEventListener('click', () => void regenerateLatestReply());
            const identitySettings = documentRef.createElement('button');
            identitySettings.type = 'button';
            identitySettings.title = conversation.type === 'group' ? '设置群成员真实身份' : '设置联系人真实身份';
            identitySettings.setAttribute('aria-label', identitySettings.title);
            identitySettings.innerHTML = '<i class="fa-solid fa-address-card"></i>';
            identitySettings.addEventListener('click', () => void editConversationIdentities());
            const rename = documentRef.createElement('button');
            rename.type = 'button';
            rename.title = conversation.type === 'group' ? '修改群聊名称' : '修改昵称备注';
            rename.setAttribute('aria-label', rename.title);
            rename.innerHTML = '<i class="fa-solid fa-pen"></i>';
            rename.addEventListener('click', () => void editConversationName());
            const removeConversation = documentRef.createElement('button');
            removeConversation.type = 'button';
            removeConversation.title = conversation.type === 'group' ? '删除群聊' : '删除单聊';
            removeConversation.setAttribute('aria-label', removeConversation.title);
            removeConversation.innerHTML = '<i class="fa-solid fa-trash"></i>';
            removeConversation.addEventListener('click', () => void deleteCurrentConversation());
            const headerActions = documentRef.createElement('div');
            headerActions.className = 'memory-augment-phone-conversation-actions';
            headerActions.append(identitySettings, rename, removeConversation, regenerate);
            header.append(identity, headerActions);
        }

        const messageList = documentRef.createElement('div');
        messageList.className = 'memory-augment-phone-message-list';
        const currentStickers = stickers();
        if (conversation.messages.length === 0) {
            const empty = messageText(documentRef, 'memory-augment-phone-message-empty', '还没有消息，先说点什么吧。');
            messageList.append(empty);
        }
        conversation.messages.forEach(message => {
            const row = documentRef.createElement('article');
            row.className = `memory-augment-phone-message-row ${message.fromUser ? 'is-user' : 'is-contact'}`;
            row.classList.toggle('is-selected', selectedMessageIds.has(message.id));
            if (!message.fromUser) row.append(avatarElement(documentRef, message.sender, '', 'is-small'));
            const bubbleWrap = documentRef.createElement('div');
            bubbleWrap.className = 'memory-augment-phone-message-bubble-wrap';
            if (conversation.type === 'group' && !message.fromUser) {
                bubbleWrap.append(messageText(documentRef, 'memory-augment-phone-message-sender', message.sender));
            }
            const bubble = documentRef.createElement('div');
            bubble.className = `memory-augment-phone-message-bubble is-${message.type}`;
            bubble.append(renderMessageReferences(documentRef, message));
            bubble.append(renderMessageBody(documentRef, message, currentStickers, showClaims));
            if (message.editedAt) bubble.append(messageText(documentRef, 'memory-augment-phone-message-edited', '已编辑'));
            bubbleWrap.append(bubble);
            row.append(bubbleWrap);
            bindMessageLongPress(row, message);
            messageList.append(row);
        });

        const status = documentRef.createElement('div');
        status.className = 'memory-augment-phone-message-status';
        status.dataset.phoneMessageStatus = '';
        const tools = documentRef.createElement('div');
        tools.className = 'memory-augment-phone-message-tools';
        tools.hidden = true;
        const toolItems = [
            ['voice', 'fa-microphone', '语音'],
            ['image', 'fa-image', '图片'],
            ['redpacket', 'fa-envelope', '红包'],
            ['location', 'fa-location-dot', '位置'],
            ['sticker', 'fa-face-smile', '表情包'],
            ...(conversation.type === 'group' ? [['group_redpacket', 'fa-users', '群红包']] : []),
        ];
        toolItems.forEach(([type, icon, label]) => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.innerHTML = `<i class="fa-solid ${icon}"></i><span>${label}</span>`;
            button.addEventListener('click', () => void openTool(type));
            tools.append(button);
        });
        const composer = documentRef.createElement('div');
        if (selectedMessageIds.size > 0) {
            composer.className = 'memory-augment-phone-selection-actions';
            const oneSelected = selectedMessageIds.size === 1;
            const actions = [
                ['编辑', 'fa-pen', editSelectedMessage, !oneSelected],
                ['转发', 'fa-share', forwardSelectedMessages, false],
                ['引用', 'fa-reply', quoteSelectedMessage, !oneSelected],
                ['删除', 'fa-trash', deleteSelectedMessages, false],
            ];
            for (const [label, icon, action, disabled] of actions) {
                const button = documentRef.createElement('button');
                button.type = 'button';
                button.disabled = disabled;
                button.innerHTML = `<i class="fa-solid ${icon}"></i><span>${label}</span>`;
                button.addEventListener('click', () => void action());
                composer.append(button);
            }
        } else {
            composer.className = 'memory-augment-phone-composer';
            if (pendingQuote) {
                const quotePreview = documentRef.createElement('div');
                quotePreview.className = 'memory-augment-phone-quote-preview';
                const copy = documentRef.createElement('span');
                copy.textContent = `引用 ${pendingQuote.sender || '未知'}：${pendingQuote.content || '消息'}`;
                const cancelQuote = documentRef.createElement('button');
                cancelQuote.type = 'button';
                cancelQuote.setAttribute('aria-label', '取消引用');
                cancelQuote.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                cancelQuote.addEventListener('click', () => {
                    pendingQuote = null;
                    renderConversation();
                });
                quotePreview.append(copy, cancelQuote);
                composer.append(quotePreview);
            }
            const more = documentRef.createElement('button');
            more.type = 'button';
            more.setAttribute('aria-label', '更多消息类型');
            more.innerHTML = '<i class="fa-solid fa-plus"></i>';
            more.addEventListener('click', () => tools.hidden = !tools.hidden);
            const input = documentRef.createElement('textarea');
            input.rows = 1;
            input.placeholder = '输入消息';
            const send = documentRef.createElement('button');
            send.type = 'button';
            send.textContent = '↑';
            send.title = '放到聊天屏幕';
            send.setAttribute('aria-label', '放到聊天屏幕');
            const stageTextMessage = () => {
                const content = text(input.value);
                if (!content) return;
                input.value = '';
                void sendPlayerMessage({ type: 'text', content });
            };
            send.addEventListener('click', stageTextMessage);
            input.addEventListener('keydown', event => {
                if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                stageTextMessage();
            });
            const finalSend = documentRef.createElement('button');
            finalSend.type = 'button';
            finalSend.className = 'memory-augment-phone-final-send';
            finalSend.textContent = '发送';
            finalSend.addEventListener('click', () => void sendOrReceiveMessages());
            composer.append(more, input, send, finalSend);
        }
        wrapper.append(header, messageList, status, tools, composer);
        root.append(wrapper);
        requestAnimationFrame(() => messageList.scrollTop = messageList.scrollHeight);
    }

    async function sendPlayerMessage(message) {
        const conversation = getConversation();
        if (!conversation || busy) return;
        const roundId = getQueuedPhoneMessages(store, conversation.id)[0]?.roundId || createPhoneRoundId();
        const normalized = {
            ...message,
            roundId,
            sender: store.profile.nickname || '我',
            fromUser: true,
            quote: pendingQuote,
            queued: true,
            storyPending: false,
        };
        if (message.type === 'group_redpacket') {
            normalized.claims = splitGroupRedPacket(
                message.amount,
                [store.profile.nickname || '我', ...conversation.members],
                message.count,
                `${conversation.id}-${Date.now()}`,
            );
        }
        appendPhoneMessage(store, conversation.id, normalized);
        pendingQuote = null;
        renderConversation();
        try {
            await persist();
        } catch (error) {
            setStatus(`消息暂时没保存成功：${error.message}`, true);
            return;
        }
        setStatus('');
    }

    async function sendOrReceiveMessages() {
        const conversation = getConversation();
        if (!conversation || busy) return;
        const committed = commitQueuedPhoneMessages(store, conversation.id);
        if (!committed) {
            await requestAiReplies();
            return;
        }
        renderConversation();
        try {
            await persist();
        } catch (error) {
            for (const message of committed.messages) {
                message.queued = true;
                message.storyPending = false;
            }
            renderConversation();
            setStatus(`这一批暂时没发送成功：${error.message}`, true);
            return;
        }
        await requestAiReplies({ roundId: committed.roundId });
    }

    async function regenerateLatestReply() {
        const conversation = getConversation();
        if (!conversation || busy) return;
        const removed = removeLatestPhoneReply(store, conversation.id);
        if (!removed) {
            setStatus('还没有可以重新生成的回复。', true);
            return;
        }
        renderConversation();
        try {
            await persist();
        } catch (error) {
            setStatus(`暂时无法重新生成：${error.message}`, true);
            return;
        }
        await requestAiReplies({ roundId: removed.roundId, insertBeforeQueued: true });
    }

    async function requestAiReplies(options = {}) {
        const conversation = getConversation();
        if (!conversation || busy) return;
        const roundId = text(options?.roundId, 120) || createPhoneRoundId();
        const api = settings?.apis?.barrage;
        if (!text(api?.url) || !text(api?.apiKey) || !text(api?.model)) {
            setStatus('未配置副 API；你的消息已保存，但联系人暂时不会自动回复。', true);
            return;
        }
        busy = true;
        setStatus(conversation.type === 'group' ? '群聊中有人正在输入…' : '对方正在输入…');
        try {
            const context = contextGetter();
            const recentStory = collectRecentStory(context);
            const snapshot = buildPhoneAiSnapshot(store, conversation.id, stickers());
            const storyContext = await prepareStoryContext({
                settings,
                context,
                store,
                snapshot,
                recentStory,
            });
            const response = await generatePhone({
                barrage: {
                    baseUrl: api.url,
                    apiKey: api.apiKey,
                    model: api.model,
                },
                maxTokens: settings?.phone?.maxTokens ?? 2048,
                recentStory,
                snapshot,
                storyContext,
            });
            const bundle = parsePhoneAiBundle(response?.content);
            for (const reply of bundle.messages) {
                const activeConversation = getConversation();
                if (!activeConversation) break;
                if (activeConversation.type === 'direct') reply.sender = activeConversation.name;
                else if (!activeConversation.members.includes(reply.sender)) {
                    reply.sender = activeConversation.members[0] || activeConversation.name;
                }
                if (reply.type === 'sticker' && !stickers().some(item => item.name === reply.stickerName)) {
                    reply.type = 'text';
                    reply.content = reply.content || `[想发送表情包：${reply.stickerName || '未知'}]`;
                    reply.stickerName = '';
                }
                if (reply.type === 'group_redpacket' && activeConversation.type !== 'group') reply.type = 'redpacket';
                if (reply.type === 'group_redpacket') {
                    reply.claims = splitGroupRedPacket(
                        reply.amount,
                        [store.profile.nickname || '我', ...activeConversation.members],
                        reply.count,
                        `${activeConversation.id}-${Date.now()}-${reply.sender}`,
                    );
                }
                const appendedReply = appendPhoneMessage(store, activeConversation.id, {
                    ...reply,
                    roundId,
                    fromUser: false,
                });
                if (options?.insertBeforeQueued) {
                    const replyIndex = activeConversation.messages.findIndex(message => message.id === appendedReply.id);
                    const queuedIndex = activeConversation.messages.findIndex(message => message.queued === true);
                    if (replyIndex >= 0 && queuedIndex >= 0 && replyIndex > queuedIndex) {
                        activeConversation.messages.splice(replyIndex, 1);
                        activeConversation.messages.splice(queuedIndex, 0, appendedReply);
                    }
                }
            }
            const activeConversation = getConversation();
            if (activeConversation) {
                const roundMessages = activeConversation.messages.filter(message => message.roundId === roundId);
                const fallbackSummary = roundMessages
                    .map(message => `${message.sender}：${message.type === 'sticker' ? `[表情包：${message.stickerName}]` : message.content}`)
                    .filter(Boolean)
                    .join('；');
                setPhoneRoundSummary(
                    store,
                    activeConversation.id,
                    roundId,
                    bundle.roundSummary || fallbackSummary,
                );
                recordPhoneMemoryEvents(store, activeConversation.id, bundle.memoryEvents, {
                    messages: getRecentRoundMessages(activeConversation, 30),
                });
            }
            await persist();
            renderConversation();
        } catch (error) {
            setStatus(`收取消息失败：${error.message}`, true);
        } finally {
            busy = false;
        }
    }

    async function openStickerPicker() {
        root.querySelector('.memory-augment-phone-sheet-overlay')?.remove();
        const overlay = documentRef.createElement('div');
        overlay.className = 'memory-augment-phone-sheet-overlay';
        const sheet = documentRef.createElement('section');
        sheet.className = 'memory-augment-phone-sheet memory-augment-phone-sticker-sheet';
        const heading = documentRef.createElement('div');
        heading.className = 'memory-augment-phone-sticker-heading';
        const title = documentRef.createElement('h3');
        title.textContent = '表情包';
        const add = documentRef.createElement('button');
        add.type = 'button';
        add.textContent = '添加';
        heading.append(title, add);
        const grid = documentRef.createElement('div');
        grid.className = 'memory-augment-phone-sticker-grid';
        const close = () => overlay.remove();
        const renderGrid = () => {
            grid.replaceChildren();
            if (stickers().length === 0) grid.append(messageText(documentRef, 'memory-augment-phone-message-empty', '还没有表情包。'));
            stickers().forEach(sticker => {
                const item = documentRef.createElement('div');
                item.className = 'memory-augment-phone-sticker-item';
                const send = documentRef.createElement('button');
                send.type = 'button';
                const image = documentRef.createElement('img');
                image.src = sticker.url;
                image.alt = sticker.name;
                image.loading = 'lazy';
                const name = documentRef.createElement('span');
                name.textContent = sticker.name;
                send.append(image, name);
                send.addEventListener('click', () => {
                    close();
                    void sendPlayerMessage({ type: 'sticker', stickerName: sticker.name });
                });
                const remove = documentRef.createElement('button');
                remove.type = 'button';
                remove.className = 'memory-augment-phone-sticker-remove';
                remove.setAttribute('aria-label', `删除表情包 ${sticker.name}`);
                remove.textContent = '×';
                remove.addEventListener('click', () => {
                    removePhoneSticker(settings, sticker.id);
                    saveSettings();
                    renderGrid();
                });
                item.append(send, remove);
                grid.append(item);
            });
        };
        const actions = documentRef.createElement('div');
        actions.className = 'memory-augment-phone-sheet-actions';
        const cancel = documentRef.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '关闭';
        cancel.addEventListener('click', close);
        actions.append(cancel);
        sheet.append(heading, grid, actions);
        overlay.append(sheet);
        root.append(overlay);
        add.addEventListener('click', async () => {
            close();
            const result = await openForm(root, {
                title: '添加表情包',
                submitLabel: '保存',
                fields: [
                    { name: 'name', label: '名称（AI 将通过名称选择）', required: true, placeholder: '例如：猫猫震惊' },
                    { name: 'url', label: '图片链接（与本地图片二选一）', type: 'url', placeholder: 'https://…' },
                    { name: 'file', label: '本地相册', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' },
                ],
                onSubmit: async values => {
                    const url = await resolveImage(values, 'sticker');
                    if (!url) throw new Error('请选择本地图片或填写图片链接。');
                    return addPhoneSticker(settings, { name: values.name, url });
                },
            });
            if (result) {
                saveSettings();
                await openStickerPicker();
            }
        });
        renderGrid();
    }

    async function openTool(type) {
        if (type === 'sticker') return openStickerPicker();
        const definitions = {
            voice: {
                title: '发送模拟语音',
                fields: [
                    { name: 'content', label: '语音文字', type: 'textarea', required: true },
                    { name: 'duration', label: '时长（秒）', type: 'number', min: 1, max: 60, value: 3 },
                ],
                build: values => ({ type, content: values.content, duration: values.duration }),
            },
            image: {
                title: '发送模拟图片',
                fields: [{ name: 'content', label: '图片内容描述', type: 'textarea', required: true }],
                build: values => ({ type, content: values.content }),
            },
            redpacket: {
                title: '发送模拟红包',
                fields: [
                    { name: 'amount', label: '金额', type: 'number', min: 0.01, value: 8.88, required: true },
                    { name: 'content', label: '红包留言', value: '恭喜发财' },
                ],
                build: values => ({ type, amount: values.amount, content: values.content }),
            },
            group_redpacket: {
                title: '发送模拟群红包',
                fields: [
                    { name: 'amount', label: '总金额', type: 'number', min: 0.01, value: 88.88, required: true },
                    { name: 'count', label: '红包份数', type: 'number', min: 1, value: getConversation()?.members.length + 1 || 1 },
                    { name: 'content', label: '红包留言', value: '大家一起抢' },
                ],
                build: values => ({ type, amount: values.amount, count: values.count, content: values.content }),
            },
            location: {
                title: '发送模拟位置',
                fields: [{ name: 'content', label: '地点与备注', type: 'textarea', required: true, placeholder: '例如：星光影视城 · A3摄影棚' }],
                build: values => ({ type, content: values.content }),
            },
        };
        const definition = definitions[type];
        if (!definition) return;
        const values = await openForm(root, { ...definition, submitLabel: '↑' });
        if (values) await sendPlayerMessage(definition.build(values));
    }

    async function editProfile() {
        const values = await openForm(root, {
            title: '编辑手机账号',
            submitLabel: '保存',
            fields: [
                { name: 'nickname', label: '昵称', value: store.profile.nickname, required: true },
                { name: 'url', label: '头像链接（与本地图片二选一）', type: 'url', value: store.profile.avatar },
                { name: 'file', label: '本地头像', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' },
            ],
            onSubmit: async input => ({
                nickname: text(input.nickname, 80) || '我',
                avatar: input.file || text(input.url) !== store.profile.avatar
                    ? await resolveImage(input, 'avatar')
                    : store.profile.avatar,
            }),
        });
        if (!values) return;
        store.profile = normalizePhoneProfile(values);
        settings.phone ??= {};
        settings.phone.profile = { ...store.profile };
        saveSettings();
        if (store.chatId) {
            try {
                await persist();
            } catch (error) {
                console.warn('[KKToolbox] 手机账号已保存到设置，但当前聊天副本未同步。', error);
            }
        }
        renderList();
    }

    async function addConversation(type) {
        const group = type === 'group';
        const sources = await getIdentitySources();
        const values = await openForm(root, {
            title: group ? '创建群聊' : '添加好友',
            submitLabel: group ? '创建' : '添加',
            fields: [
                { name: 'name', label: group ? '群聊名称' : '好友昵称备注（不是人物本名）', required: true },
                ...(group ? [{ name: 'members', label: '群成员（每行或逗号分隔）', type: 'textarea', required: true }] : []),
                ...(!group ? [
                    {
                        name: 'identitySource',
                        label: '真实身份（好友名称只是手机备注）',
                        type: 'select',
                        value: 'unbound',
                        options: identitySelectOptions(sources),
                    },
                    {
                        name: 'identityDetails',
                        label: '自定义人物设定／绑定后的补充说明',
                        type: 'textarea',
                        placeholder: '选择自定义人物时必须填写；绑定已有角色时可留空。',
                    },
                ] : []),
                { name: 'url', label: '头像链接（可选）', type: 'url' },
                { name: 'file', label: '本地头像（可选）', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' },
            ],
            onSubmit: async input => {
                const members = group
                    ? String(input.members ?? '').split(/[，,\n]/).map(item => text(item, 80)).filter(Boolean)
                    : [];
                const memberIdentities = Object.fromEntries(members.map(member => {
                    const source = findIdentitySourceForName(member, sources);
                    return [member, source
                        ? identityFromInput(source.key, '', sources)
                        : normalizePhoneIdentity()];
                }));
                return {
                    type,
                    name: text(input.name, 120),
                    members,
                    identity: group
                        ? normalizePhoneIdentity()
                        : identityFromInput(input.identitySource, input.identityDetails, sources),
                    memberIdentities,
                    avatar: await resolveImage(input, group ? 'group' : 'contact'),
                };
            },
        });
        if (!values) return;
        const conversation = createPhoneConversation(store, values);
        try {
            await persist();
            currentConversationId = conversation.id;
            renderConversation();
        } catch (error) {
            store.conversations = store.conversations.filter(item => item.id !== conversation.id);
            showListError(`创建失败：${error.message}`);
        }
    }

    function showAddChoices() {
        root.querySelector('.memory-augment-phone-sheet-overlay')?.remove();
        const overlay = documentRef.createElement('div');
        overlay.className = 'memory-augment-phone-sheet-overlay';
        const sheet = documentRef.createElement('section');
        sheet.className = 'memory-augment-phone-sheet';
        const heading = documentRef.createElement('h3');
        heading.textContent = '新建通讯';
        const choices = documentRef.createElement('div');
        choices.className = 'memory-augment-phone-create-choices';
        [['direct', 'fa-user-plus', '添加好友'], ['group', 'fa-users', '创建群聊']].forEach(([type, icon, label]) => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.innerHTML = `<i class="fa-solid ${icon}"></i><span>${label}</span>`;
            button.addEventListener('click', () => {
                overlay.remove();
                void addConversation(type);
            });
            choices.append(button);
        });
        const actions = documentRef.createElement('div');
        actions.className = 'memory-augment-phone-sheet-actions';
        const cancel = documentRef.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => overlay.remove());
        actions.append(cancel);
        sheet.append(heading, choices, actions);
        overlay.append(sheet);
        root.append(overlay);
    }

    async function openOnlineMemory() {
        root.querySelector('.memory-augment-phone-sheet-overlay')?.remove();
        const overlay = documentRef.createElement('div');
        overlay.className = 'memory-augment-phone-sheet-overlay';
        const sheet = documentRef.createElement('section');
        sheet.className = 'memory-augment-phone-sheet memory-augment-phone-memory-sheet';
        const heading = documentRef.createElement('h3');
        heading.textContent = '线上记忆';
        const note = messageText(
            documentRef,
            'memory-augment-phone-identity-note',
            '这里只保留有原话依据的线上事实。发送或收到不等于看过，更不等于角色产生了某种反应。人工修改优先。',
        );
        const list = documentRef.createElement('div');
        list.className = 'memory-augment-phone-memory-list';
        const labels = {
            platform_fact: '平台内容', explicit_action: '明确操作', commitment: '约定承诺',
            conflict: '线上冲突', confirmed_reaction: '明确反应', unknown_state: '状态未知',
        };
        const events = [...(store.onlineMemory?.events ?? [])]
            .sort((left, right) => right.updatedAt - left.updatedAt);
        if (events.length === 0) {
            list.append(messageText(documentRef, 'memory-augment-phone-message-empty', '还没有值得长期保存的线上事件。原始聊天记录仍然完整保留。'));
        }
        for (const memory of events) {
            const item = documentRef.createElement('article');
            item.className = 'memory-augment-phone-memory-item';
            const meta = documentRef.createElement('div');
            meta.className = 'memory-augment-phone-memory-meta';
            const badge = documentRef.createElement('span');
            badge.textContent = labels[memory.type] ?? '线上事实';
            const status = documentRef.createElement('small');
            status.textContent = memory.manualOverride
                ? '人工修改'
                : memory.status === 'active' ? '仍有效' : memory.status === 'resolved' ? '已解决' : '已记录';
            meta.append(badge, status);
            const summary = messageText(documentRef, 'memory-augment-phone-memory-summary', memory.summary);
            const evidence = messageText(
                documentRef,
                'memory-augment-phone-memory-evidence',
                memory.evidenceQuotes?.length ? `依据：${memory.evidenceQuotes.join('／')}` : '人工记录',
            );
            const actions = documentRef.createElement('div');
            actions.className = 'memory-augment-phone-memory-actions';
            const edit = documentRef.createElement('button');
            edit.type = 'button';
            edit.textContent = '修改';
            edit.addEventListener('click', async () => {
                overlay.remove();
                const result = await openForm(root, {
                    title: '修改线上记忆',
                    submitLabel: '保存',
                    fields: [{ name: 'summary', label: '事实内容', type: 'textarea', value: memory.summary, required: true }],
                });
                if (!result) return openOnlineMemory();
                updatePhoneMemoryEvent(store, memory.id, { summary: result.summary });
                await persist();
                await openOnlineMemory();
            });
            actions.append(edit);
            if (memory.status === 'active') {
                const resolve = documentRef.createElement('button');
                resolve.type = 'button';
                resolve.textContent = '标为解决';
                resolve.addEventListener('click', async () => {
                    updatePhoneMemoryEvent(store, memory.id, { status: 'resolved' });
                    await persist();
                    await openOnlineMemory();
                });
                actions.append(resolve);
            }
            const remove = documentRef.createElement('button');
            remove.type = 'button';
            remove.textContent = '删除';
            remove.addEventListener('click', async () => {
                overlay.remove();
                if (!await openConfirm(root, {
                    title: '删除这条线上记忆？',
                    message: '这只会删除提炼出的线上记忆，原始聊天记录不会删除。',
                    confirmLabel: '确认删除',
                })) return openOnlineMemory();
                removePhoneMemoryEvent(store, memory.id);
                await persist();
                await openOnlineMemory();
            });
            actions.append(remove);
            item.append(meta, summary, evidence, actions);
            list.append(item);
        }
        const closeActions = documentRef.createElement('div');
        closeActions.className = 'memory-augment-phone-sheet-actions';
        const close = documentRef.createElement('button');
        close.type = 'button';
        close.textContent = '关闭';
        close.addEventListener('click', () => overlay.remove());
        closeActions.append(close);
        sheet.append(heading, note, list, closeActions);
        overlay.append(sheet);
        root.append(overlay);
    }

    function renderList() {
        if (!root || !store) return;
        currentConversationId = '';
        leaveMessageSelection({ keepQuote: false });
        root.replaceChildren();
        const wrapper = documentRef.createElement('div');
        wrapper.className = 'memory-augment-phone-message-home';
        const profile = documentRef.createElement('button');
        profile.type = 'button';
        profile.className = 'memory-augment-phone-profile-card';
        profile.append(avatarElement(documentRef, store.profile.nickname, store.profile.avatar, 'is-profile'));
        const info = documentRef.createElement('span');
        const name = documentRef.createElement('strong');
        name.textContent = store.profile.nickname;
        const hint = documentRef.createElement('small');
        hint.textContent = '点击设置昵称和头像';
        info.append(name, hint);
        profile.append(info, messageText(documentRef, 'memory-augment-phone-profile-edit', '编辑'));
        profile.addEventListener('click', () => void editProfile());
        const toolbar = documentRef.createElement('div');
        toolbar.className = 'memory-augment-phone-list-toolbar';
        const heading = documentRef.createElement('strong');
        heading.textContent = '消息';
        const toolbarActions = documentRef.createElement('span');
        toolbarActions.className = 'memory-augment-phone-list-actions';
        const memory = documentRef.createElement('button');
        memory.type = 'button';
        memory.setAttribute('aria-label', '查看线上记忆');
        memory.title = '线上记忆';
        memory.innerHTML = '<i class="fa-solid fa-bookmark"></i>';
        memory.disabled = !store.chatId;
        if (store.chatId) memory.addEventListener('click', () => void openOnlineMemory());
        const add = documentRef.createElement('button');
        add.type = 'button';
        add.setAttribute('aria-label', '添加好友或群聊');
        add.innerHTML = '<i class="fa-solid fa-plus"></i>';
        add.disabled = !store.chatId;
        add.title = store.chatId
            ? '添加好友或群聊'
            : '请先在酒馆中打开一个角色卡聊天';
        if (store.chatId) add.addEventListener('click', showAddChoices);
        toolbarActions.append(memory, add);
        toolbar.append(heading, toolbarActions);
        const list = documentRef.createElement('div');
        list.className = 'memory-augment-phone-conversation-list';
        const ordered = [...store.conversations].sort((left, right) => {
            const leftTime = left.messages.at(-1)?.timestamp ?? left.createdAt;
            const rightTime = right.messages.at(-1)?.timestamp ?? right.createdAt;
            return rightTime - leftTime;
        });
        if (ordered.length === 0) {
            const emptyText = store.chatId
                ? '还没有好友或群聊，点右上角 ＋ 创建一个。'
                : '请先在酒馆中打开一个角色卡聊天，再创建这段剧情专属的好友和群聊。昵称与头像仍可在上方设置。';
            list.append(messageText(documentRef, 'memory-augment-phone-message-empty', emptyText));
        }
        ordered.forEach(conversation => {
            const row = documentRef.createElement('button');
            row.type = 'button';
            row.className = 'memory-augment-phone-conversation-row';
            row.append(avatarElement(documentRef, conversation.name, conversation.avatar));
            const copy = documentRef.createElement('span');
            const top = documentRef.createElement('span');
            const title = documentRef.createElement('strong');
            title.textContent = conversation.name;
            const badge = documentRef.createElement('small');
            badge.textContent = conversation.type === 'group' ? '群聊' : '单聊';
            top.append(title, badge);
            const preview = documentRef.createElement('span');
            preview.textContent = lastMessagePreview(conversation.messages.at(-1));
            copy.append(top, preview);
            row.append(copy);
            row.addEventListener('click', () => {
                currentConversationId = conversation.id;
                leaveMessageSelection({ keepQuote: false });
                renderConversation();
            });
            list.append(row);
        });
        wrapper.append(profile, toolbar, list);
        root.append(wrapper);
    }

    return {
        async open(contentRoot) {
            root = contentRoot;
            root.classList.add('is-messages');
            root.innerHTML = '<div class="memory-augment-phone-message-loading"><i class="fa-solid fa-spinner fa-spin"></i> 正在读取消息…</div>';
            try {
                store = await loadPhoneStore(contextGetter());
                settings.phone ??= {};
                const hasSavedProfile = settings.phone.profile
                    && (text(settings.phone.profile.nickname) || text(settings.phone.profile.avatar));
                if (hasSavedProfile) {
                    store.profile = normalizePhoneProfile(settings.phone.profile);
                } else {
                    settings.phone.profile = normalizePhoneProfile(store.profile);
                    saveSettings();
                }
                renderList();
            } catch (error) {
                root.textContent = `读取手机失败：${error.message}`;
            }
        },
        back() {
            const overlay = root?.querySelector('.memory-augment-phone-sheet-overlay');
            if (overlay) {
                overlay.remove();
                return true;
            }
            if (selectedMessageIds.size > 0) {
                leaveMessageSelection();
                renderConversation();
                return true;
            }
            if (currentConversationId) {
                renderList();
                return true;
            }
            return false;
        },
    };
}
