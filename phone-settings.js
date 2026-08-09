import { cleanPhoneText as text } from './phone-utils.js';
import { uploadPhoneImage } from './phone-store.js';

export const PHONE_ACCOUNT_AREAS = Object.freeze([
    ['messages', '聊天'],
    ['weibo', '微博'],
    ['community', '社区'],
    ['live', '直播'],
]);

const LEGACY_MAIN_BIO_COPY = ['使用酒馆用户设定的', '默认身份。'].join('');

function clone(value) {
    return typeof globalThis.structuredClone === 'function'
        ? globalThis.structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function currentPersona(context = {}, documentRef = globalThis.document) {
    const powerUser = context?.powerUser ?? context?.power_user ?? globalThis.power_user ?? {};
    const selectedAvatar = documentRef?.querySelector?.('#user_avatar_block .avatar.selected img')?.src ?? '';
    return {
        nickname: text(context?.name1, 80),
        avatar: text(context?.userAvatar ?? context?.user_avatar ?? selectedAvatar, 4000),
        persona: text(powerUser?.persona_description, 12_000),
    };
}

function normalizeAltAccount(value = {}) {
    const nickname = text(value.nickname, 80);
    if (!nickname) return null;
    return {
        id: text(value.id, 120) || makeId('phone-alt'),
        kind: 'alt',
        label: text(value.label, 60) || nickname,
        nickname,
        avatar: text(value.avatar, 4000),
        bio: text(value.bio, 240),
        persona: text(value.persona, 12_000),
        createdAt: Math.max(0, Number(value.createdAt) || Date.now()),
    };
}

export function normalizePhoneAccounts(settings = {}, context = {}, documentRef = globalThis.document) {
    settings.phone ??= {};
    const source = settings.phone.accounts && typeof settings.phone.accounts === 'object'
        ? settings.phone.accounts
        : {};
    const oldMain = (Array.isArray(source.items) ? source.items : []).find(account => account?.id === 'main') ?? {};
    const linked = currentPersona(context, documentRef);
    const legacyProfile = settings.phone.profile ?? {};
    const legacyWeiboProfile = settings.phone.weibo?.profile ?? {};
    const legacyNickname = text(legacyProfile.nickname, 80);
    const legacyBio = text(oldMain.bio, 240) || text(legacyWeiboProfile.bio, 240);
    const main = {
        id: 'main',
        kind: 'main',
        label: '大号',
        nickname: text(oldMain.nickname, 80) || (legacyNickname !== '我' ? legacyNickname : '') || linked.nickname || '我',
        avatar: text(oldMain.avatar, 4000) || text(legacyProfile.avatar, 4000) || linked.avatar,
        bio: legacyBio === LEGACY_MAIN_BIO_COPY ? '' : legacyBio,
        persona: linked.persona || text(oldMain.persona, 12_000),
        createdAt: Math.max(0, Number(oldMain.createdAt) || Date.now()),
    };
    const seen = new Set(['main']);
    const alts = (Array.isArray(source.items) ? source.items : []).map(normalizeAltAccount).filter(account => {
        if (!account || seen.has(account.id)) return false;
        seen.add(account.id);
        return true;
    });
    const items = [main, ...alts];
    const ids = new Set(items.map(account => account.id));
    const defaultAccountId = ids.has(String(source.defaultAccountId)) ? String(source.defaultAccountId) : 'main';
    const sourceAssignments = source.assignments && typeof source.assignments === 'object' ? source.assignments : {};
    const assignments = Object.fromEntries(PHONE_ACCOUNT_AREAS.map(([areaId]) => [
        areaId,
        ids.has(String(sourceAssignments[areaId])) ? String(sourceAssignments[areaId]) : defaultAccountId,
    ]));
    const state = { items, defaultAccountId, assignments };
    settings.phone.accounts = state;
    return state;
}

function publicProfile(account) {
    return {
        accountId: account.id,
        isMask: account.kind === 'alt',
        nickname: account.nickname,
        avatar: account.avatar,
        bio: account.bio,
        persona: account.persona,
    };
}

function writeAssignedProfiles(settings, state) {
    const accountById = new Map(state.items.map(account => [account.id, account]));
    const profileFor = areaId => publicProfile(accountById.get(state.assignments[areaId]) ?? accountById.get(state.defaultAccountId) ?? state.items[0]);
    settings.phone.profile = profileFor('messages');
    settings.phone.weibo ??= {};
    settings.phone.weibo.profile = profileFor('weibo');
    settings.phone.community ??= {};
    settings.phone.community.profile = profileFor('community');
    settings.phone.live ??= {};
    settings.phone.live.profile = profileFor('live');
}

export function syncPhoneAccountProfiles(settings = {}, context = {}, documentRef = globalThis.document) {
    const state = normalizePhoneAccounts(settings, context, documentRef);
    writeAssignedProfiles(settings, state);
    return state;
}

export function getPhoneAccountForArea(settings = {}, areaId = 'messages', context = {}, documentRef = globalThis.document) {
    const state = normalizePhoneAccounts(settings, context, documentRef);
    const accountId = state.assignments[areaId] ?? state.defaultAccountId;
    return state.items.find(account => account.id === accountId) ?? state.items[0];
}

export function createPhoneAltAccount(settings, values = {}, context = {}, documentRef = globalThis.document) {
    const state = normalizePhoneAccounts(settings, context, documentRef);
    const account = normalizeAltAccount({ ...values, id: makeId('phone-alt'), createdAt: Date.now() });
    if (!account) throw new Error('小号昵称不能为空。');
    state.items.push(account);
    settings.phone.accounts = state;
    writeAssignedProfiles(settings, state);
    return account;
}

export function updatePhoneAltAccount(settings, accountId, values = {}, context = {}, documentRef = globalThis.document) {
    const state = normalizePhoneAccounts(settings, context, documentRef);
    if (!state.items.some(account => account.id === accountId && account.kind === 'alt')) {
        throw new Error('没有找到这个小号。');
    }
    return updatePhoneAccount(settings, accountId, values, context, documentRef);
}

export function updatePhoneAccount(settings, accountId, values = {}, context = {}, documentRef = globalThis.document) {
    const state = normalizePhoneAccounts(settings, context, documentRef);
    const index = state.items.findIndex(account => account.id === accountId);
    if (index < 0) throw new Error('没有找到这个身份。');
    const previous = state.items[index];
    const account = previous.kind === 'main'
        ? {
            ...previous,
            label: '大号',
            nickname: text(values.nickname ?? previous.nickname, 80),
            avatar: text(values.avatar ?? previous.avatar, 4000),
            bio: text(values.bio ?? previous.bio, 240),
        }
        : normalizeAltAccount({ ...previous, ...values, id: accountId });
    if (!account?.nickname) throw new Error('公开昵称不能为空。');
    state.items[index] = account;
    settings.phone.accounts = state;
    writeAssignedProfiles(settings, state);
    return account;
}

export function removePhoneAltAccount(settings, accountId, context = {}, documentRef = globalThis.document) {
    const state = normalizePhoneAccounts(settings, context, documentRef);
    const account = state.items.find(item => item.id === accountId && item.kind === 'alt');
    if (!account) return false;
    state.items = state.items.filter(item => item.id !== accountId);
    if (state.defaultAccountId === accountId) state.defaultAccountId = 'main';
    for (const [areaId] of PHONE_ACCOUNT_AREAS) {
        if (state.assignments[areaId] === accountId) state.assignments[areaId] = state.defaultAccountId;
    }
    settings.phone.accounts = state;
    writeAssignedProfiles(settings, state);
    return true;
}

export function setDefaultPhoneAccount(settings, accountId, context = {}, documentRef = globalThis.document) {
    const state = normalizePhoneAccounts(settings, context, documentRef);
    if (!state.items.some(account => account.id === accountId)) throw new Error('没有找到这个身份。');
    state.defaultAccountId = accountId;
    settings.phone.accounts = state;
    writeAssignedProfiles(settings, state);
    return state;
}

export function assignPhoneAccount(settings, accountId, areaIds = [], context = {}, documentRef = globalThis.document) {
    const state = normalizePhoneAccounts(settings, context, documentRef);
    if (!state.items.some(account => account.id === accountId)) throw new Error('没有找到这个身份。');
    const allowedAreas = new Set(PHONE_ACCOUNT_AREAS.map(([areaId]) => areaId));
    for (const areaId of areaIds) {
        if (allowedAreas.has(areaId)) state.assignments[areaId] = accountId;
    }
    settings.phone.accounts = state;
    writeAssignedProfiles(settings, state);
    return state;
}

function element(documentRef, tag, className = '', content = '') {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (content !== '') node.textContent = content;
    return node;
}

function button(documentRef, className, content, onClick) {
    const node = element(documentRef, 'button', className, content);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
}

function avatar(documentRef, account) {
    const holder = element(documentRef, 'span', 'memory-augment-phone-account-avatar');
    if (account.avatar) {
        const image = element(documentRef, 'img');
        image.src = account.avatar;
        image.alt = '';
        holder.append(image);
    } else {
        holder.textContent = Array.from(account.nickname)[0] ?? '我';
    }
    return holder;
}

export function createPhoneSettingsController(options = {}) {
    const documentRef = options.document ?? globalThis.document;
    const settings = options.settings ?? {};
    const contextGetter = options.contextGetter ?? (() => ({}));
    const saveSettings = options.saveSettings ?? (() => {});
    let root = null;
    let view = 'list';
    let editingAccountId = '';
    let applyingAccountId = '';
    let pendingDeleteId = '';
    let listScrollTop = 0;

    function state() {
        return syncPhoneAccountProfiles(settings, contextGetter(), documentRef);
    }

    function persist() {
        saveSettings();
    }

    function renderAssignmentSummary(container, current) {
        const section = element(documentRef, 'section', 'memory-augment-phone-account-summary');
        section.append(element(documentRef, 'strong', '', '当前身份'));
        const grid = element(documentRef, 'div');
        for (const [areaId, areaLabel] of PHONE_ACCOUNT_AREAS) {
            const account = current.items.find(item => item.id === current.assignments[areaId]) ?? current.items[0];
            const item = element(documentRef, 'div');
            item.append(element(documentRef, 'small', '', areaLabel), element(documentRef, 'strong', '', account.label));
            grid.append(item);
        }
        section.append(grid);
        container.append(section);
    }

    function applyAccount(accountId, areaIds) {
        assignPhoneAccount(settings, accountId, areaIds, contextGetter(), documentRef);
        applyingAccountId = '';
        pendingDeleteId = '';
        persist();
        render();
    }

    function renderApplyPanel(card, account, current) {
        if (applyingAccountId !== account.id) return;
        const panel = element(documentRef, 'section', 'memory-augment-phone-account-apply');
        panel.append(element(documentRef, 'strong', '', `把“${account.label}”用在哪里？`));
        const choices = element(documentRef, 'div');
        for (const [areaId, areaLabel] of PHONE_ACCOUNT_AREAS) {
            const choice = element(documentRef, 'label');
            const input = element(documentRef, 'input');
            input.type = 'checkbox';
            input.name = 'account-area';
            input.value = areaId;
            input.checked = current.assignments[areaId] === account.id;
            choice.append(input, element(documentRef, 'span', '', areaLabel));
            choices.append(choice);
        }
        panel.append(choices);
        const actions = element(documentRef, 'div');
        actions.append(
            button(documentRef, '', '应用到选中位置', () => {
                const selected = [...choices.querySelectorAll('input:checked')].map(input => input.value);
                if (selected.length === 0) return;
                applyAccount(account.id, selected);
            }),
            button(documentRef, 'is-primary', '一键全部换成它', () => applyAccount(account.id, PHONE_ACCOUNT_AREAS.map(([areaId]) => areaId))),
        );
        panel.append(actions);
        card.append(panel);
    }

    function renderAccountCard(list, account, current) {
        const card = element(documentRef, 'article', 'memory-augment-phone-account-card');
        const top = element(documentRef, 'div', 'memory-augment-phone-account-card-top');
        const copy = element(documentRef, 'div');
        const title = element(documentRef, 'div');
        title.append(
            element(documentRef, 'strong', '', account.label),
            element(documentRef, 'span', account.kind === 'main' ? 'is-main' : '', account.kind === 'main' ? '大号' : '小号'),
        );
        if (current.defaultAccountId === account.id) title.append(element(documentRef, 'span', 'is-default', '默认'));
        copy.append(title, element(documentRef, 'p', '', `${account.nickname}${account.bio ? ` · ${account.bio}` : ''}`));
        top.append(avatar(documentRef, account), copy);
        card.append(top);

        const used = PHONE_ACCOUNT_AREAS.filter(([areaId]) => current.assignments[areaId] === account.id);
        const badges = element(documentRef, 'div', 'memory-augment-phone-account-used');
        if (used.length === 0) badges.append(element(documentRef, 'small', '', '目前没有应用到任何地方'));
        else used.forEach(([, label]) => badges.append(element(documentRef, 'span', '', label)));
        card.append(badges);

        const actions = element(documentRef, 'div', 'memory-augment-phone-account-actions');
        actions.append(button(documentRef, 'is-primary', applyingAccountId === account.id ? '收起范围' : '选择使用范围', () => {
            applyingAccountId = applyingAccountId === account.id ? '' : account.id;
            pendingDeleteId = '';
            render();
        }));
        if (current.defaultAccountId !== account.id) {
            actions.append(button(documentRef, '', '设为默认', () => {
                setDefaultPhoneAccount(settings, account.id, contextGetter(), documentRef);
                persist();
                render();
            }));
        }
        actions.append(button(documentRef, '', '编辑', () => {
            editingAccountId = account.id;
            view = 'edit';
            render();
        }));
        if (account.kind === 'alt') {
            actions.append(button(documentRef, 'is-danger', pendingDeleteId === account.id ? '确认删除' : '删除', () => {
                if (pendingDeleteId !== account.id) {
                    pendingDeleteId = account.id;
                    applyingAccountId = '';
                    render();
                    return;
                }
                removePhoneAltAccount(settings, account.id, contextGetter(), documentRef);
                pendingDeleteId = '';
                persist();
                render();
            }));
        }
        card.append(actions);
        renderApplyPanel(card, account, current);
        list.append(card);
    }

    function renderList(container) {
        const current = state();
        renderAssignmentSummary(container, current);

        const heading = element(documentRef, 'header', 'memory-augment-phone-account-list-heading');
        heading.append(element(documentRef, 'strong', '', '身份列表'), button(documentRef, '', '+ 新建小号', () => {
            editingAccountId = '';
            view = 'edit';
            render();
        }));
        container.append(heading);
        const list = element(documentRef, 'section', 'memory-augment-phone-account-list');
        current.items.forEach(account => renderAccountCard(list, account, current));
        container.append(list);
    }

    function renderEditor(container) {
        const current = state();
        const account = current.items.find(item => item.id === editingAccountId);
        const header = element(documentRef, 'header', 'memory-augment-phone-account-editor-header');
        const back = button(documentRef, '', '', () => { view = 'list'; editingAccountId = ''; render(); });
        back.setAttribute('aria-label', '返回身份列表');
        back.append(element(documentRef, 'i', 'fa-solid fa-chevron-left'));
        header.append(back, element(documentRef, 'strong', '', account?.kind === 'main' ? '编辑大号资料' : account ? '编辑小号' : '新建小号'));
        container.append(header);

        const form = element(documentRef, 'form', 'memory-augment-phone-account-editor');
        if (account?.kind === 'main') {
            const identityNote = element(documentRef, 'section', 'memory-augment-phone-account-binding-note');
            identityNote.append(element(documentRef, 'strong', '', '已绑定当前酒馆身份'));
            form.append(identityNote);
        } else {
            const maskNote = element(documentRef, 'section', 'memory-augment-phone-account-binding-note is-mask');
            maskNote.append(element(documentRef, 'strong', '', account ? '匿名小号／马甲' : '创建匿名小号／马甲'));
            form.append(maskNote);
        }
        const fields = [
            ...(account?.kind === 'main' ? [] : [['label', '马甲备注', account?.label ?? '', '例如：吃瓜号、工作号', 60, 'input']]),
            ['nickname', '公开昵称', account?.nickname ?? '', '昵称', 80, 'input'],
            ['avatar', '头像链接', account?.avatar ?? '', '可不填', 4000, 'input'],
            ['bio', '公开简介', account?.bio ?? '', '简介', 240, 'textarea'],
            ...(account?.kind === 'main' ? [] : [['persona', '马甲对外人设', account?.persona ?? '', '公开身份、语气和背景', 12000, 'textarea']]),
        ];
        for (const [name, label, value, placeholder, maxLength, type] of fields) {
            const wrapper = element(documentRef, 'label');
            wrapper.append(element(documentRef, 'strong', '', label));
            const control = element(documentRef, type);
            control.name = name;
            control.value = value;
            control.placeholder = placeholder;
            control.maxLength = maxLength;
            if (type === 'textarea') control.rows = name === 'persona' ? 5 : 3;
            if (name === 'nickname') control.required = true;
            wrapper.append(control);
            form.append(wrapper);
        }
        const localAvatar = element(documentRef, 'label', 'memory-augment-phone-account-local-avatar');
        localAvatar.append(element(documentRef, 'strong', '', '本地头像'));
        const fileInput = element(documentRef, 'input');
        fileInput.type = 'file';
        fileInput.name = 'avatarFile';
        fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
        const fileName = element(documentRef, 'span', '', '选择手机或电脑里的图片');
        fileInput.addEventListener('change', () => {
            fileName.textContent = fileInput.files?.[0]?.name || '选择手机或电脑里的图片';
        });
        localAvatar.append(fileInput, fileName);
        form.append(localAvatar);
        const feedback = element(documentRef, 'p', 'memory-augment-phone-account-feedback');
        const submit = button(documentRef, 'memory-augment-phone-account-submit', account ? '保存修改' : '创建小号');
        submit.type = 'submit';
        form.append(feedback, submit);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const data = new FormData(form);
            const values = Object.fromEntries(data.entries());
            try {
                submit.disabled = true;
                const avatarFile = values.avatarFile;
                if (avatarFile instanceof Blob && avatarFile.size > 0) {
                    values.avatar = await uploadPhoneImage(avatarFile, account?.kind === 'main' ? 'phone-main' : 'phone-mask');
                }
                delete values.avatarFile;
                if (account) updatePhoneAccount(settings, account.id, values, contextGetter(), documentRef);
                else createPhoneAltAccount(settings, values, contextGetter(), documentRef);
                persist();
                view = 'list';
                editingAccountId = '';
                render();
            } catch (error) {
                feedback.textContent = text(error?.message, 300) || '保存失败。';
                submit.disabled = false;
            }
        });
        container.append(form);
    }

    function render() {
        if (!root) return;
        const previous = root.querySelector('.memory-augment-phone-settings-view');
        if (previous?.dataset.phoneSettingsView === 'list') listScrollTop = previous.scrollTop;
        root.replaceChildren();
        root.classList.remove('is-messages', 'is-weibo', 'is-community', 'is-live');
        root.classList.add('is-phone-settings');
        const container = element(documentRef, 'div', 'memory-augment-phone-settings-view');
        container.dataset.phoneSettingsView = view;
        if (view === 'edit') renderEditor(container);
        else renderList(container);
        root.append(container);
        if (view === 'list') {
            const restore = () => { container.scrollTop = listScrollTop; };
            restore();
            documentRef.defaultView?.requestAnimationFrame?.(restore);
        }
    }

    return {
        async open(container) {
            root = container;
            view = 'list';
            editingAccountId = '';
            applyingAccountId = '';
            pendingDeleteId = '';
            listScrollTop = 0;
            render();
        },
        back() {
            if (view !== 'edit') return false;
            view = 'list';
            editingAccountId = '';
            render();
            return true;
        },
        close() {},
        getState: state,
    };
}
