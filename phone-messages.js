import { generatePhoneCompletion } from './rag-client.js';
import {
    PHONE_DEFAULT_STICKER_GROUP_ID,
    addPhoneSticker,
    appendPhoneMessage,
    buildPhoneAiSnapshot,
    commitQueuedPhoneMessages,
    createPhoneRoundId,
    createPhoneConversation,
    createPhoneStickerGroup,
    forwardPhoneMessages,
    getQueuedPhoneMessages,
    getRecentRoundMessages,
    loadPhoneStore,
    normalizePhoneIdentity,
    normalizePhoneProfile,
    normalizePhoneStickerGroups,
    normalizePhoneStickers,
    parsePhoneStickerLinkBatch,
    recordPhoneMemoryEvents,
    removePhoneConversation,
    removeLatestPhoneReply,
    removePhoneMessage,
    removePhoneSticker,
    removePhoneStickerGroup,
    removePhoneMemoryEvent,
    renamePhoneStickerGroup,
    savePhoneStore,
    setPhoneRoundSummary,
    splitGroupRedPacket,
    renamePhoneConversation,
    updatePhoneMessage,
    updatePhoneMemoryEvent,
    uploadPhoneImage,
} from './phone-store.js';
import { preparePhoneStoryContext } from './phone-context.js';
import {
    parsePhoneGroupMembers,
    requestPhoneAiBundle,
} from './phone-ai-protocol.js';
import {
    closeActivePhoneOverlay,
    openPhoneConfirm as openConfirm,
    openPhoneForm as openForm,
    registerPhoneOverlayCloser,
    unregisterPhoneOverlayCloser,
} from './phone-dialogs.js';
import { beginPhoneStateTransaction, clonePhoneState, restorePhoneState } from './phone-state.js';
import { cleanPhoneText as text } from './phone-utils.js';
import {
    findPhoneIdentitySourceForName as findIdentitySourceForName,
    getPhoneIdentityFromInput as identityFromInput,
    getPhoneIdentitySelectOptions as identitySelectOptions,
    loadPhoneIdentitySources,
} from './phone-identities.js';

export {
    parsePhoneAiBundle,
    parsePhoneAiResponse,
    parsePhoneGroupMembers,
    requestPhoneAiBundle,
} from './phone-ai-protocol.js';
export { getPhoneFieldValidationMessage } from './phone-dialogs.js';
export { isPhoneIdentityEntry, loadPhoneIdentitySources } from './phone-identities.js';

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
        forward_bundle: `[聊天记录] ${message.forwardBundle?.title || ''}`,
    };
    return text(labels[message.type] ?? message.content, 80) || '[消息]';
}

function messageReferenceContent(message) {
    if (message.type === 'forward_bundle') {
        return `[聊天记录] ${message.forwardBundle?.title || '聊天记录'}，共 ${message.forwardBundle?.messages?.length ?? 0} 条`;
    }
    if (message.type === 'sticker') return `[表情包] ${message.stickerName || '未知'}`;
    if (message.type === 'voice') return `[语音] ${message.content || '无文字'}`;
    if (message.type === 'image') return `[图片] ${message.content || '无描述'}`;
    if (message.type === 'location') return `[位置] ${message.content || '无描述'}`;
    if (['redpacket', 'group_redpacket'].includes(message.type)) {
        return `[${message.type === 'group_redpacket' ? '群红包' : '红包'}] ${message.recipient ? `给${message.recipient} ` : ''}${message.amount}元 ${message.content || ''}`.trim();
    }
    return message.content || '[消息]';
}

function forwardItemPreview(message) {
    if (message.type === 'voice') return `[语音] ${message.content || '无文字'}`;
    if (message.type === 'image') return `[图片] ${message.content || '无描述'}`;
    if (message.type === 'location') return `[位置] ${message.content || '无描述'}`;
    if (message.type === 'sticker') return `[表情包] ${message.stickerName || '未知'}`;
    if (message.type === 'redpacket' || message.type === 'group_redpacket') {
        const label = message.type === 'group_redpacket' ? '群红包' : '红包';
        return `[${label}] ${message.recipient ? `给 ${message.recipient} ` : ''}¥${message.amount}${message.content ? ` ${message.content}` : ''}`;
    }
    if (message.type === 'forward_bundle') return '[聊天记录]';
    return message.content || '[消息]';
}

export function getForwardSourceLabel(reference = {}) {
    const conversationName = text(reference?.conversationName, 120);
    const sender = text(reference?.sender, 80);
    if (conversationName && sender && conversationName !== sender) return `${conversationName} · ${sender}`;
    return conversationName || sender || '其他会话';
}

export function getLuckyKingClaimIndex(claims = []) {
    if (!Array.isArray(claims) || claims.length < 2) return -1;
    return claims.reduce((bestIndex, claim, index) => (
        Number(claim?.amount) > Number(claims[bestIndex]?.amount) ? index : bestIndex
    ), 0);
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
            `转发自 ${getForwardSourceLabel(message.forwardedFrom)}`,
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

function renderMessageBody(documentRef, message, stickers, onClaims, onForwardBundle) {
    if (message.type === 'forward_bundle') {
        const bundle = message.forwardBundle;
        const card = documentRef.createElement('button');
        card.type = 'button';
        card.className = 'memory-augment-phone-forward-bundle';
        const title = documentRef.createElement('strong');
        title.textContent = bundle?.title || '聊天记录';
        const preview = documentRef.createElement('span');
        preview.className = 'memory-augment-phone-forward-bundle-preview';
        (bundle?.messages ?? []).slice(0, 3).forEach(item => {
            const line = documentRef.createElement('span');
            line.textContent = `${item.sender}：${forwardItemPreview(item)}`;
            preview.append(line);
        });
        const count = documentRef.createElement('small');
        count.textContent = `共 ${bundle?.messages?.length ?? 0} 条`;
        card.append(title, preview, count);
        card.addEventListener('click', () => onForwardBundle(message));
        return card;
    }
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
        card.classList.toggle('is-group', message.type === 'group_redpacket');
        const icon = documentRef.createElement('span');
        icon.className = 'memory-augment-phone-redpacket-icon';
        const seal = documentRef.createElement('span');
        seal.className = 'memory-augment-phone-redpacket-seal';
        seal.textContent = '¥';
        icon.append(seal);
        const copy = documentRef.createElement('span');
        copy.className = 'memory-augment-phone-redpacket-copy';
        const amount = documentRef.createElement('strong');
        amount.textContent = `¥${message.amount}`;
        copy.append(amount);
        if (message.recipient) {
            const recipient = documentRef.createElement('small');
            recipient.className = 'memory-augment-phone-redpacket-recipient';
            recipient.textContent = `给 ${message.recipient}`;
            copy.append(recipient);
        }
        if (message.content) {
            const note = documentRef.createElement('small');
            note.textContent = message.content;
            copy.append(note);
        }
        card.append(icon, copy);
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
    let activeStickerGroupId = PHONE_DEFAULT_STICKER_GROUP_ID;
    let openSequence = 0;

    const getConversation = () => store?.conversations?.find(item => item.id === currentConversationId);
    const stickers = () => normalizePhoneStickers(settings);
    const stickerGroups = () => normalizePhoneStickerGroups(settings);

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

    async function persistTransaction(transaction) {
        await transaction.persist(target => savePhoneStore(target, contextGetter()));
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
        const transaction = beginPhoneStateTransaction(store);
        onSave(result);
        try {
            await persistTransaction(transaction);
            renderConversation();
            return true;
        } catch (error) {
            if (store === transaction.target) {
                renderConversation();
                setStatus(`人物身份暂时没保存成功：${error.message}`, true);
            }
            return false;
        }
    }

    async function openGroupIdentityManager() {
        const conversation = getConversation();
        if (!conversation || conversation.type !== 'group') return;
        closeActivePhoneOverlay(root);
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
        const transaction = beginPhoneStateTransaction(store);
        renamePhoneConversation(store, conversation.id, result.name);
        try {
            await persistTransaction(transaction);
            renderConversation();
        } catch (error) {
            if (store === transaction.target) {
                renderConversation();
                setStatus(`名称暂时没保存成功：${error.message}`, true);
            }
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
        const transaction = beginPhoneStateTransaction(store);
        removePhoneConversation(store, conversation.id);
        currentConversationId = '';
        try {
            await persistTransaction(transaction);
            renderList();
        } catch (error) {
            if (store === transaction.target) showListError(`${label}暂时没删除成功：${error.message}`);
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
        renderConversation({ preserveScroll: true });
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
                renderConversation({ preserveScroll: true });
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
            renderConversation({ preserveScroll: true });
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
        const transaction = beginPhoneStateTransaction(store);
        for (const message of messages) {
            removePhoneMessage(store, conversation.id, message.id);
        }
        leaveMessageSelection();
        try {
            await persistTransaction(transaction);
            renderConversation();
        } catch (error) {
            if (store === transaction.target) {
                renderConversation();
                setStatus(`消息暂时没删除成功：${error.message}`, true);
            }
        }
    }

    async function editSelectedMessage() {
        const conversation = getConversation();
        const [message] = selectedMessages();
        if (!conversation || selectedMessageIds.size !== 1 || !message || message.type === 'forward_bundle' || busy) return;
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
        const transaction = beginPhoneStateTransaction(store);
        const update = updatePhoneMessage(store, conversation.id, message.id, result);
        leaveMessageSelection();
        try {
            await persistTransaction(transaction);
            renderConversation();
            setStatus(`消息已修改${update?.removedMemoryEvents ? `，并清理 ${update.removedMemoryEvents} 条旧线上记忆` : ''}。`);
        } catch (error) {
            if (store === transaction.target) {
                renderConversation();
                setStatus(`消息暂时没修改成功：${error.message}`, true);
            }
        }
    }

    function openForwardTargetPicker(targets, messageCount) {
        return new Promise(resolve => {
            closeActivePhoneOverlay(root);
            const overlay = documentRef.createElement('div');
            overlay.className = 'memory-augment-phone-sheet-overlay';
            const sheet = documentRef.createElement('section');
            sheet.className = 'memory-augment-phone-sheet memory-augment-phone-forward-sheet';
            const title = documentRef.createElement('h3');
            title.textContent = `转发 ${messageCount} 条消息`;
            const toolbar = documentRef.createElement('div');
            toolbar.className = 'memory-augment-phone-forward-toolbar';
            const hint = messageText(documentRef, '', '选择一个或多个接收聊天');
            const selectAll = documentRef.createElement('button');
            selectAll.type = 'button';
            const list = documentRef.createElement('div');
            list.className = 'memory-augment-phone-forward-targets';
            const selectedTargets = new Set();
            const rows = [];
            const actions = documentRef.createElement('div');
            actions.className = 'memory-augment-phone-sheet-actions';
            const cancel = documentRef.createElement('button');
            cancel.type = 'button';
            cancel.textContent = '取消';
            const submit = documentRef.createElement('button');
            submit.type = 'button';
            submit.textContent = '转发';
            let settled = false;
            const close = (value = []) => {
                if (settled) return;
                settled = true;
                unregisterPhoneOverlayCloser(root, close);
                overlay.remove();
                resolve(value);
            };
            registerPhoneOverlayCloser(root, close);
            const renderSelection = () => {
                rows.forEach(({ target, button }) => {
                    const selected = selectedTargets.has(target.id);
                    button.classList.toggle('is-selected', selected);
                    button.setAttribute('aria-pressed', String(selected));
                });
                selectAll.textContent = selectedTargets.size === targets.length ? '取消全选' : '全选';
                submit.disabled = selectedTargets.size === 0;
                submit.textContent = selectedTargets.size > 0 ? `转发到 ${selectedTargets.size} 个聊天` : '转发';
            };
            for (const target of targets) {
                const button = documentRef.createElement('button');
                button.type = 'button';
                button.className = 'memory-augment-phone-forward-target';
                button.append(avatarElement(documentRef, target.name, target.avatar));
                const copy = documentRef.createElement('span');
                const name = documentRef.createElement('strong');
                name.textContent = target.name;
                const type = documentRef.createElement('small');
                type.textContent = target.type === 'group' ? '群聊' : '单聊';
                copy.append(name, type);
                const mark = documentRef.createElement('i');
                mark.className = 'fa-solid fa-check';
                mark.setAttribute('aria-hidden', 'true');
                button.append(copy, mark);
                button.addEventListener('click', () => {
                    if (selectedTargets.has(target.id)) selectedTargets.delete(target.id);
                    else selectedTargets.add(target.id);
                    renderSelection();
                });
                rows.push({ target, button });
                list.append(button);
            }
            selectAll.addEventListener('click', () => {
                if (selectedTargets.size === targets.length) selectedTargets.clear();
                else targets.forEach(target => selectedTargets.add(target.id));
                renderSelection();
            });
            cancel.addEventListener('click', () => close([]));
            submit.addEventListener('click', () => close([...selectedTargets]));
            overlay.addEventListener('click', event => {
                if (event.target === overlay) close([]);
            });
            toolbar.append(hint, selectAll);
            actions.append(cancel, submit);
            sheet.append(title, toolbar, list, actions);
            overlay.append(sheet);
            root.append(overlay);
            renderSelection();
        });
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
        const targetIds = await openForwardTargetPicker(targets, messages.length);
        if (targetIds.length === 0) return;
        const transaction = beginPhoneStateTransaction(store);
        for (const targetId of targetIds) {
            forwardPhoneMessages(
                store,
                conversation.id,
                targetId,
                messages.map(message => message.id),
                store.profile.nickname || '我',
            );
        }
        leaveMessageSelection();
        try {
            await persistTransaction(transaction);
            renderConversation();
            setStatus(`已将 ${messages.length} 条消息转发到 ${targetIds.length} 个聊天。`);
        } catch (error) {
            if (store === transaction.target) {
                renderConversation();
                setStatus(`消息暂时没转发成功：${error.message}`, true);
            }
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
        const luckyKingIndex = getLuckyKingClaimIndex(claims);
        claims.forEach((claim, index) => {
            const row = documentRef.createElement('div');
            const recipient = documentRef.createElement('div');
            recipient.className = 'memory-augment-phone-claim-recipient';
            const name = documentRef.createElement('span');
            name.textContent = claim.name;
            recipient.append(name);
            if (index === luckyKingIndex) {
                const badge = documentRef.createElement('small');
                badge.className = 'memory-augment-phone-lucky-king';
                badge.textContent = '手气王';
                recipient.append(badge);
            }
            const amount = documentRef.createElement('strong');
            amount.textContent = `${claim.amount} 元`;
            row.append(recipient, amount);
            list.append(row);
        });
        sheet.querySelector('.memory-augment-phone-form-error')?.before(list);
    }

    function showForwardBundle(message) {
        const bundle = message.forwardBundle;
        if (!bundle) return;
        closeActivePhoneOverlay(root);
        const overlay = documentRef.createElement('div');
        overlay.className = 'memory-augment-phone-sheet-overlay';
        const sheet = documentRef.createElement('section');
        sheet.className = 'memory-augment-phone-sheet memory-augment-phone-forward-bundle-sheet';
        const title = documentRef.createElement('h3');
        title.textContent = bundle.title || '聊天记录';
        const summary = messageText(
            documentRef,
            'memory-augment-phone-forward-bundle-summary',
            `来自 ${bundle.sourceConversationName || '其他会话'} · 共 ${bundle.messages.length} 条`,
        );
        const list = documentRef.createElement('div');
        list.className = 'memory-augment-phone-forward-bundle-list';
        bundle.messages.forEach(item => {
            const row = documentRef.createElement('div');
            row.className = 'memory-augment-phone-forward-bundle-item';
            const sender = documentRef.createElement('strong');
            sender.textContent = item.sender || '未知';
            const content = documentRef.createElement('span');
            content.textContent = forwardItemPreview(item);
            row.append(sender, content);
            list.append(row);
        });
        const actions = documentRef.createElement('div');
        actions.className = 'memory-augment-phone-sheet-actions';
        const close = documentRef.createElement('button');
        close.type = 'button';
        close.textContent = '关闭';
        const dismiss = () => overlay.remove();
        close.addEventListener('click', dismiss);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) dismiss();
        });
        actions.append(close);
        sheet.append(title, summary, list, actions);
        overlay.append(sheet);
        root.append(overlay);
    }

    function renderConversation({ preserveScroll = false, focusComposer = false, draft = '' } = {}) {
        const conversation = getConversation();
        if (!root || !conversation) return renderList();
        const previousMessageList = root.querySelector('.memory-augment-phone-message-list');
        const previousScrollTop = preserveScroll ? previousMessageList?.scrollTop ?? 0 : 0;
        closeActivePhoneOverlay(root);
        root.replaceChildren();
        const wrapper = documentRef.createElement('div');
        wrapper.className = 'memory-augment-phone-conversation';
        wrapper.classList.toggle('is-selecting', selectedMessageIds.size > 0);
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
                renderConversation({ preserveScroll: true });
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
                renderConversation({ preserveScroll: true });
            });
            header.append(closeSelection, count, selectAll);
        } else {
            const identity = documentRef.createElement('div');
            identity.append(avatarElement(documentRef, conversation.name, conversation.avatar));
            const title = documentRef.createElement('span');
            const strong = documentRef.createElement('strong');
            strong.textContent = conversation.name;
            title.append(strong);
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
            bubble.append(renderMessageBody(documentRef, message, currentStickers, showClaims, showForwardBundle));
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
            ['redpacket', 'fa-yen-sign', '红包'],
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
            const selectedMessage = oneSelected ? selectedMessages()[0] : null;
            const actions = [
                ['编辑', 'fa-pen', editSelectedMessage, !oneSelected || selectedMessage?.type === 'forward_bundle'],
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
            input.autocomplete = 'off';
            input.placeholder = '输入消息';
            input.value = draft;
            const send = documentRef.createElement('button');
            send.type = 'button';
            send.textContent = '↑';
            send.title = '放到聊天屏幕';
            send.setAttribute('aria-label', '放到聊天屏幕');
            const stageTextMessage = () => {
                const content = text(input.value);
                if (!content) return;
                input.value = '';
                void sendPlayerMessage({ type: 'text', content }, { focusComposer: true });
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
        if (focusComposer) {
            const nextInput = composer.querySelector('textarea');
            try {
                nextInput?.focus({ preventScroll: true });
            } catch {
                nextInput?.focus();
            }
        }
        requestAnimationFrame(() => {
            messageList.scrollTop = preserveScroll ? previousScrollTop : messageList.scrollHeight;
        });
    }

    async function sendPlayerMessage(message, { focusComposer = false } = {}) {
        const conversation = getConversation();
        if (!conversation || busy) return;
        const transaction = beginPhoneStateTransaction(store);
        const previousQuote = pendingQuote ? clonePhoneState(pendingQuote) : null;
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
        renderConversation({ focusComposer });
        try {
            await persistTransaction(transaction);
        } catch (error) {
            if (store === transaction.target) {
                pendingQuote = previousQuote;
                renderConversation({ focusComposer, draft: message.type === 'text' ? message.content : '' });
                setStatus(`消息暂时没保存成功：${error.message}`, true);
            }
            return;
        }
        setStatus('');
    }

    async function sendOrReceiveMessages() {
        const conversation = getConversation();
        if (!conversation || busy) return;
        const transaction = beginPhoneStateTransaction(store);
        const committed = commitQueuedPhoneMessages(store, conversation.id);
        if (!committed) {
            await requestAiReplies();
            return;
        }
        renderConversation();
        try {
            await persistTransaction(transaction);
        } catch (error) {
            if (store === transaction.target) {
                renderConversation();
                setStatus(`这一批暂时没发送成功：${error.message}`, true);
            }
            return;
        }
        await requestAiReplies({ roundId: committed.roundId });
    }

    async function regenerateLatestReply() {
        const conversation = getConversation();
        if (!conversation || busy) return;
        const regenerationStore = store;
        const previousStore = clonePhoneState(regenerationStore);
        const removed = removeLatestPhoneReply(store, conversation.id);
        if (!removed) {
            setStatus('还没有可以重新生成的回复。', true);
            return;
        }
        renderConversation();
        const generated = await requestAiReplies({ roundId: removed.roundId, insertBeforeQueued: true });
        if (!generated) {
            restorePhoneState(regenerationStore, previousStore);
            if (store === regenerationStore) {
                renderConversation();
                setStatus('重新生成失败，已保留原回复。', true);
            }
        }
    }

    async function requestAiReplies(options = {}) {
        const conversation = getConversation();
        if (!conversation || busy) return false;
        const requestStore = store;
        const requestChatId = text(requestStore?.chatId, 500);
        const requestConversationId = conversation.id;
        const roundId = text(options?.roundId, 120) || createPhoneRoundId();
        const api = settings?.apis?.barrage;
        if (!text(api?.url) || !text(api?.apiKey) || !text(api?.model)) {
            setStatus('未配置副 API；你的消息已保存，但联系人暂时不会自动回复。', true);
            return false;
        }
        busy = true;
        setStatus(conversation.type === 'group' ? '群聊中有人正在输入…' : '对方正在输入…');
        let responseSnapshot = null;
        try {
            const context = contextGetter();
            const recentStory = collectRecentStory(context);
            const snapshot = buildPhoneAiSnapshot(requestStore, requestConversationId, stickers());
            const storyContext = await prepareStoryContext({
                settings,
                context,
                store: requestStore,
                snapshot,
                recentStory,
            });
            const bundle = await requestPhoneAiBundle(generatePhone, {
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
            const responseConversation = requestStore?.conversations
                ?.find(item => item.id === requestConversationId);
            if (!responseConversation || text(requestStore?.chatId, 500) !== requestChatId) {
                throw new Error('手机会话在等待回复期间已经改变，本次返回已安全丢弃。');
            }
            responseSnapshot = clonePhoneState(requestStore);
            for (const reply of bundle.messages) {
                if (responseConversation.type === 'direct') reply.sender = responseConversation.name;
                else if (!responseConversation.members.includes(reply.sender)) {
                    reply.sender = responseConversation.members[0] || responseConversation.name;
                }
                if (reply.type === 'sticker' && !stickers().some(item => item.name === reply.stickerName)) {
                    reply.type = 'text';
                    reply.content = reply.content || `[想发送表情包：${reply.stickerName || '未知'}]`;
                    reply.stickerName = '';
                }
                if (reply.type === 'group_redpacket' && responseConversation.type !== 'group') reply.type = 'redpacket';
                if (reply.type === 'redpacket' && responseConversation.type === 'group') {
                    const recipients = [requestStore.profile.nickname || '我', ...responseConversation.members]
                        .filter(name => name !== reply.sender);
                    if (!recipients.includes(reply.recipient)) reply.recipient = recipients[0] || '';
                } else if (reply.type === 'redpacket') {
                    reply.recipient = '';
                }
                if (reply.type === 'group_redpacket') {
                    reply.claims = splitGroupRedPacket(
                        reply.amount,
                        [requestStore.profile.nickname || '我', ...responseConversation.members],
                        reply.count,
                        `${responseConversation.id}-${Date.now()}-${reply.sender}`,
                    );
                }
                const appendedReply = appendPhoneMessage(requestStore, responseConversation.id, {
                    ...reply,
                    roundId,
                    fromUser: false,
                });
                if (options?.insertBeforeQueued) {
                    const replyIndex = responseConversation.messages.findIndex(message => message.id === appendedReply.id);
                    const queuedIndex = responseConversation.messages.findIndex(message => message.queued === true);
                    if (replyIndex >= 0 && queuedIndex >= 0 && replyIndex > queuedIndex) {
                        responseConversation.messages.splice(replyIndex, 1);
                        responseConversation.messages.splice(queuedIndex, 0, appendedReply);
                    }
                }
            }
            if (responseConversation) {
                const roundMessages = responseConversation.messages.filter(message => message.roundId === roundId);
                const fallbackSummary = roundMessages
                    .map(message => `${message.sender}：${message.type === 'sticker' ? `[表情包：${message.stickerName}]` : message.content}`)
                    .filter(Boolean)
                    .join('；');
                setPhoneRoundSummary(
                    requestStore,
                    responseConversation.id,
                    roundId,
                    bundle.roundSummary || fallbackSummary,
                );
                recordPhoneMemoryEvents(requestStore, responseConversation.id, bundle.memoryEvents, {
                    messages: getRecentRoundMessages(responseConversation, 30),
                });
            }
            await savePhoneStore(requestStore, { getCurrentChatId: () => requestChatId });
            if (store === requestStore && currentConversationId === requestConversationId) renderConversation();
            return true;
        } catch (error) {
            if (responseSnapshot) restorePhoneState(requestStore, responseSnapshot);
            if (store === requestStore && currentConversationId === requestConversationId) {
                setStatus(`收取消息失败：${error.message}`, true);
            } else {
                console.warn('[KKToolbox] 后台手机回复未能保存到原会话。', error);
            }
            return false;
        } finally {
            busy = false;
        }
    }

    function stickerGroupOptions() {
        return stickerGroups().map(group => ({ value: group.id, label: group.name }));
    }

    async function openLocalStickerForm() {
        const result = await openForm(root, {
            title: '本地添加表情包',
            submitLabel: '保存',
            fields: [
                { name: 'groupId', label: '保存到分组', type: 'select', value: activeStickerGroupId, options: stickerGroupOptions() },
                { name: 'name', label: '名称（AI 将通过名称选择）', required: true, placeholder: '例如：猫猫震惊' },
                { name: 'file', label: '本地图片', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', required: true },
            ],
            onSubmit: async values => addPhoneSticker(settings, {
                name: values.name,
                url: await uploadPhoneImage(values.file, 'sticker'),
                groupId: values.groupId,
            }),
        });
        if (!result) return;
        activeStickerGroupId = result.groupId;
        saveSettings();
        await openStickerPicker({ notice: `“${result.name}”已保存。` });
    }

    async function openStickerBatchPreview(parsed, groupId) {
        closeActivePhoneOverlay(root);
        const overlay = documentRef.createElement('div');
        overlay.className = 'memory-augment-phone-sheet-overlay';
        const form = documentRef.createElement('form');
        form.className = 'memory-augment-phone-sheet memory-augment-phone-sticker-import-sheet';
        form.autocomplete = 'off';
        form.noValidate = true;
        const title = documentRef.createElement('h3');
        title.textContent = '确认批量导入';
        const summary = messageText(
            documentRef,
            'memory-augment-phone-sticker-import-summary',
            `识别到 ${parsed.items.length} 张表情包${parsed.errors.length ? `，另有 ${parsed.errors.length} 行无法识别` : ''}。名称可以在导入前修改。`,
        );
        const list = documentRef.createElement('div');
        list.className = 'memory-augment-phone-sticker-import-list';
        const rows = parsed.items.map(item => {
            const row = documentRef.createElement('label');
            row.className = 'memory-augment-phone-sticker-import-row';
            const input = documentRef.createElement('input');
            input.autocomplete = 'off';
            input.value = item.name;
            input.maxLength = 120;
            input.setAttribute('aria-label', `第 ${item.line} 行表情包名称`);
            const url = documentRef.createElement('small');
            url.textContent = item.url;
            row.append(input, url);
            list.append(row);
            return { item, input };
        });
        if (parsed.errors.length > 0) {
            const errors = documentRef.createElement('div');
            errors.className = 'memory-augment-phone-sticker-import-errors';
            parsed.errors.forEach(item => errors.append(messageText(documentRef, '', `第 ${item.line} 行：${item.message}`)));
            list.append(errors);
        }
        const formError = documentRef.createElement('div');
        formError.className = 'memory-augment-phone-form-error';
        const actions = documentRef.createElement('div');
        actions.className = 'memory-augment-phone-sheet-actions';
        const cancel = documentRef.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '取消';
        const submit = documentRef.createElement('button');
        submit.type = 'submit';
        submit.textContent = '导入';
        const close = () => overlay.remove();
        cancel.addEventListener('click', close);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) close();
        });
        form.addEventListener('submit', event => {
            event.preventDefault();
            const namedRows = rows.map(row => ({ ...row.item, name: text(row.input.value, 120) }));
            const unnamed = namedRows.findIndex(item => !item.name);
            if (unnamed >= 0) {
                formError.textContent = `第 ${namedRows[unnamed].line} 行需要填写名称。`;
                rows[unnamed].input.focus();
                return;
            }
            const existingNames = new Set(stickers().map(sticker => sticker.name));
            let added = 0;
            let updated = 0;
            for (const item of namedRows) {
                if (existingNames.has(item.name)) updated += 1;
                else added += 1;
                addPhoneSticker(settings, { ...item, groupId });
                existingNames.add(item.name);
            }
            saveSettings();
            activeStickerGroupId = groupId;
            close();
            void openStickerPicker({
                notice: `批量导入完成：新增 ${added} 张，更新 ${updated} 张${parsed.errors.length ? `，跳过 ${parsed.errors.length} 行` : ''}。`,
            });
        });
        actions.append(cancel, submit);
        form.append(title, summary, list, formError, actions);
        overlay.append(form);
        root.append(overlay);
    }

    async function openStickerBatchImport() {
        const result = await openForm(root, {
            title: '批量导入链接',
            message: '每行一张。可写“名称 链接”或“名称-链接”；只写链接时会从文件名生成名称。',
            submitLabel: '预览',
            fields: [
                { name: 'groupId', label: '保存到分组', type: 'select', value: activeStickerGroupId, options: stickerGroupOptions() },
                {
                    name: 'links',
                    label: '表情包链接',
                    type: 'textarea',
                    required: true,
                    placeholder: '猫猫震惊 https://example.com/cat.gif\n狗狗开心-https://example.com/dog.webp\nhttps://example.com/smile.png',
                },
            ],
            onSubmit: values => {
                const parsed = parsePhoneStickerLinkBatch(values.links, values.groupId);
                if (parsed.items.length === 0) {
                    throw new Error(parsed.errors[0]?.message ?? '没有识别到可以导入的链接。');
                }
                return { parsed, groupId: values.groupId };
            },
        });
        if (result) await openStickerBatchPreview(result.parsed, result.groupId);
    }

    async function openStickerGroupManager() {
        closeActivePhoneOverlay(root);
        const overlay = documentRef.createElement('div');
        overlay.className = 'memory-augment-phone-sheet-overlay';
        const sheet = documentRef.createElement('section');
        sheet.className = 'memory-augment-phone-sheet memory-augment-phone-sticker-group-sheet';
        const title = documentRef.createElement('h3');
        title.textContent = '管理表情包分组';
        const list = documentRef.createElement('div');
        list.className = 'memory-augment-phone-sticker-group-list';
        const close = () => overlay.remove();
        for (const group of stickerGroups()) {
            const row = documentRef.createElement('div');
            const name = documentRef.createElement('strong');
            name.textContent = group.name;
            const count = documentRef.createElement('span');
            count.textContent = `${stickers().filter(sticker => sticker.groupId === group.id).length} 张`;
            const copy = documentRef.createElement('div');
            copy.append(name, count);
            const rowActions = documentRef.createElement('div');
            rowActions.className = 'memory-augment-phone-sticker-group-actions';
            if (group.id === PHONE_DEFAULT_STICKER_GROUP_ID) {
                rowActions.append(messageText(documentRef, 'memory-augment-phone-sticker-default-label', '固定'));
            } else {
                const rename = documentRef.createElement('button');
                rename.type = 'button';
                rename.textContent = '重命名';
                rename.addEventListener('click', async () => {
                    close();
                    const result = await openForm(root, {
                        title: '重命名分组',
                        submitLabel: '保存',
                        fields: [{ name: 'name', label: '分组名称', value: group.name, required: true }],
                        onSubmit: values => renamePhoneStickerGroup(settings, group.id, values.name),
                    });
                    if (result) {
                        saveSettings();
                        await openStickerGroupManager();
                    }
                });
                const remove = documentRef.createElement('button');
                remove.type = 'button';
                remove.textContent = '删除';
                remove.className = 'is-danger';
                remove.addEventListener('click', async () => {
                    close();
                    const confirmed = await openConfirm(root, {
                        title: `删除“${group.name}”？`,
                        message: '分组里的表情包不会删除，会全部移回默认组。',
                        confirmLabel: '删除分组',
                    });
                    if (confirmed) {
                        removePhoneStickerGroup(settings, group.id);
                        if (activeStickerGroupId === group.id) activeStickerGroupId = PHONE_DEFAULT_STICKER_GROUP_ID;
                        saveSettings();
                    }
                    await openStickerGroupManager();
                });
                rowActions.append(rename, remove);
            }
            row.append(copy, rowActions);
            list.append(row);
        }
        const actions = documentRef.createElement('div');
        actions.className = 'memory-augment-phone-sheet-actions';
        const cancel = documentRef.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '关闭';
        cancel.addEventListener('click', close);
        const add = documentRef.createElement('button');
        add.type = 'button';
        add.textContent = '新建分组';
        add.addEventListener('click', async () => {
            close();
            const result = await openForm(root, {
                title: '新建表情包分组',
                submitLabel: '创建',
                fields: [{ name: 'name', label: '分组名称', required: true, placeholder: '例如：猫猫' }],
                onSubmit: values => createPhoneStickerGroup(settings, values.name),
            });
            if (result) {
                activeStickerGroupId = result.id;
                saveSettings();
                await openStickerGroupManager();
            }
        });
        actions.append(cancel, add);
        sheet.append(title, list, actions);
        overlay.append(sheet);
        root.append(overlay);
    }

    async function openStickerPicker({ notice = '' } = {}) {
        closeActivePhoneOverlay(root);
        const groups = stickerGroups();
        if (!groups.some(group => group.id === activeStickerGroupId)) {
            activeStickerGroupId = PHONE_DEFAULT_STICKER_GROUP_ID;
        }
        const overlay = documentRef.createElement('div');
        overlay.className = 'memory-augment-phone-sheet-overlay';
        const sheet = documentRef.createElement('section');
        sheet.className = 'memory-augment-phone-sheet memory-augment-phone-sticker-sheet';
        const heading = documentRef.createElement('div');
        heading.className = 'memory-augment-phone-sticker-heading';
        const title = documentRef.createElement('h3');
        title.textContent = '表情包';
        heading.append(title);
        const toolbar = documentRef.createElement('div');
        toolbar.className = 'memory-augment-phone-sticker-toolbar';
        const toolbarItems = [
            ['本地添加', () => void openLocalStickerForm()],
            ['批量链接', () => void openStickerBatchImport()],
            ['管理分组', () => void openStickerGroupManager()],
        ];
        toolbarItems.forEach(([label, handler]) => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.addEventListener('click', handler);
            toolbar.append(button);
        });
        const tabs = documentRef.createElement('div');
        tabs.className = 'memory-augment-phone-sticker-groups';
        const grid = documentRef.createElement('div');
        grid.className = 'memory-augment-phone-sticker-grid';
        const close = () => overlay.remove();
        const renderGrid = () => {
            grid.replaceChildren();
            const visible = stickers().filter(sticker => sticker.groupId === activeStickerGroupId);
            if (visible.length === 0) {
                grid.append(messageText(documentRef, 'memory-augment-phone-message-empty', '这个分组还没有表情包。'));
            }
            visible.forEach(sticker => {
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
        const renderTabs = () => {
            tabs.replaceChildren();
            stickerGroups().forEach(group => {
                const button = documentRef.createElement('button');
                button.type = 'button';
                button.textContent = group.name;
                button.classList.toggle('is-active', group.id === activeStickerGroupId);
                button.setAttribute('aria-pressed', String(group.id === activeStickerGroupId));
                button.addEventListener('click', () => {
                    activeStickerGroupId = group.id;
                    renderTabs();
                    renderGrid();
                });
                tabs.append(button);
            });
        };
        const actions = documentRef.createElement('div');
        actions.className = 'memory-augment-phone-sheet-actions';
        const cancel = documentRef.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '关闭';
        cancel.addEventListener('click', close);
        actions.append(cancel);
        sheet.append(heading, toolbar, tabs);
        if (notice) sheet.append(messageText(documentRef, 'memory-augment-phone-sticker-notice', notice));
        sheet.append(grid, actions);
        overlay.append(sheet);
        root.append(overlay);
        renderTabs();
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
                    ...(getConversation()?.type === 'group' ? [{
                        name: 'recipient',
                        label: '发送给群成员',
                        type: 'select',
                        value: getConversation()?.members?.[0] ?? '',
                        options: (getConversation()?.members ?? []).map(member => ({ value: member, label: member })),
                        required: true,
                    }] : []),
                    { name: 'amount', label: '金额', type: 'number', min: 0.01, step: 0.01, value: 8.88, required: true },
                    { name: 'content', label: '红包留言', value: '恭喜发财' },
                ],
                build: values => ({ type, amount: values.amount, recipient: values.recipient, content: values.content }),
            },
            group_redpacket: {
                title: '发送模拟群红包',
                fields: [
                    { name: 'amount', label: '总金额', type: 'number', min: 0.01, step: 0.01, value: 88.88, required: true },
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
                ...(group ? [{ name: 'members', label: '群成员（至少2人，每行或逗号分隔）', type: 'textarea', required: true }] : []),
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
                const members = group ? parsePhoneGroupMembers(input.members) : [];
                if (group && members.length < 2) throw new Error('创建群聊至少需要填写2名不同的群成员。');
                if (group && members.includes(store.profile.nickname)) {
                    throw new Error('群成员不需要重复填写玩家本人。');
                }
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
        const transaction = beginPhoneStateTransaction(store);
        const conversation = createPhoneConversation(transaction.target, values);
        try {
            await persistTransaction(transaction);
            if (store === transaction.target) {
                currentConversationId = conversation.id;
                renderConversation();
            }
        } catch (error) {
            if (store === transaction.target) showListError(`创建失败：${error.message}`);
        }
    }

    function showAddChoices() {
        closeActivePhoneOverlay(root);
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

    async function openOnlineMemory({ notice = '', noticeIsError = false } = {}) {
        closeActivePhoneOverlay(root);
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
        const noticeElement = notice
            ? messageText(documentRef, `memory-augment-phone-message-status${noticeIsError ? ' is-error' : ''}`, notice)
            : null;
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
                const transaction = beginPhoneStateTransaction(store);
                updatePhoneMemoryEvent(store, memory.id, { summary: result.summary });
                try {
                    await persistTransaction(transaction);
                    await openOnlineMemory({ notice: '线上记忆已修改。' });
                } catch (error) {
                    if (store === transaction.target) {
                        await openOnlineMemory({ notice: `线上记忆暂时没保存成功：${error.message}`, noticeIsError: true });
                    }
                }
            });
            actions.append(edit);
            if (memory.status === 'active') {
                const resolve = documentRef.createElement('button');
                resolve.type = 'button';
                resolve.textContent = '标为解决';
                resolve.addEventListener('click', async () => {
                    const transaction = beginPhoneStateTransaction(store);
                    updatePhoneMemoryEvent(store, memory.id, { status: 'resolved' });
                    try {
                        await persistTransaction(transaction);
                        await openOnlineMemory({ notice: '线上记忆已标为解决。' });
                    } catch (error) {
                        if (store === transaction.target) {
                            await openOnlineMemory({ notice: `线上记忆暂时没保存成功：${error.message}`, noticeIsError: true });
                        }
                    }
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
                const transaction = beginPhoneStateTransaction(store);
                removePhoneMemoryEvent(store, memory.id);
                try {
                    await persistTransaction(transaction);
                    await openOnlineMemory({ notice: '线上记忆已删除。' });
                } catch (error) {
                    if (store === transaction.target) {
                        await openOnlineMemory({ notice: `线上记忆暂时没删除成功：${error.message}`, noticeIsError: true });
                    }
                }
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
        sheet.append(heading, note);
        if (noticeElement) sheet.append(noticeElement);
        sheet.append(list, closeActions);
        overlay.append(sheet);
        root.append(overlay);
    }

    function renderList() {
        if (!root || !store) return;
        currentConversationId = '';
        leaveMessageSelection({ keepQuote: false });
        closeActivePhoneOverlay(root);
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
            const sequence = ++openSequence;
            root = contentRoot;
            root.classList.add('is-messages');
            root.innerHTML = '<div class="memory-augment-phone-message-loading"><i class="fa-solid fa-spinner fa-spin"></i> 正在读取消息…</div>';
            try {
                const nextStore = await loadPhoneStore(contextGetter());
                if (sequence !== openSequence || root !== contentRoot) return;
                if (store?.chatId !== nextStore.chatId) {
                    currentConversationId = '';
                    identitySources = null;
                    leaveMessageSelection({ keepQuote: false });
                }
                store = nextStore;
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
            if (closeActivePhoneOverlay(root)) return true;
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
