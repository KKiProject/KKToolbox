import { Popup } from '../../../popup.js';
import { normalizeBaseUrl } from './api-utils.js';
import { getChatMemory, updateChatMemory } from './rag-client.js';

const PAGE_SIZE = 50;
let memoryItemSequence = 0;

function showNotice(message, type = 'info') {
    if (globalThis.toastr?.[type]) {
        globalThis.toastr[type](message, 'Memory Augment');
    } else if (type === 'error') {
        console.error(`[Memory Augment] ${message}`);
    } else {
        console.info(`[Memory Augment] ${message}`);
    }
}

function getEmbeddingConfig(settings) {
    return {
        baseUrl: normalizeBaseUrl(settings.apis.embedding.url),
        apiKey: String(settings.apis.embedding.apiKey ?? '').trim(),
        model: String(settings.apis.embedding.model ?? '').trim(),
    };
}

function getCurrentChatId() {
    const context = SillyTavern.getContext();
    return context.getCurrentChatId?.() ?? context.chatId;
}

function createBadge(text, state = '') {
    const badge = document.createElement('span');
    badge.className = 'memory-augment-memory-badge';
    if (state) badge.dataset.state = state;
    badge.textContent = text;
    return badge;
}

function setCardBusy(card, busy) {
    card.classList.toggle('is-loading', busy);
    card.querySelectorAll('button, textarea').forEach((element) => {
        element.disabled = busy;
    });
}

function describeRole(role) {
    return role === 'user' ? '玩家' : 'AI';
}

export function initializeChatMemoryUi(settings, context = SillyTavern.getContext()) {
    const details = document.querySelector('#memory_augment_chat_memory_details');
    const list = document.querySelector('#memory_augment_chat_memory_list');
    const status = document.querySelector('#memory_augment_chat_memory_status');
    const search = document.querySelector('#memory_augment_chat_memory_search');
    const searchButton = document.querySelector('#memory_augment_chat_memory_search_button');
    const refreshButton = document.querySelector('#memory_augment_chat_memory_refresh');
    const loadMoreButton = document.querySelector('#memory_augment_chat_memory_more');
    if (!details || !list || !status || !search || !searchButton || !refreshButton || !loadMoreButton
        || details.dataset.bound === 'true') {
        return;
    }
    details.dataset.bound = 'true';

    const state = {
        chatId: '',
        items: [],
        offset: 0,
        query: '',
        total: 0,
        hasMore: false,
        manualCount: 0,
        disabledCount: 0,
        loading: false,
        error: '',
    };

    const replaceItem = (item) => {
        const index = state.items.findIndex(candidate => candidate.id === item.id);
        if (index >= 0) {
            const previous = state.items[index];
            state.manualCount += Number(item.manual_override === true) - Number(previous.manual_override === true);
            state.disabledCount += Number(item.disabled === true) - Number(previous.disabled === true);
            state.items[index] = item;
        }
        render();
    };

    const updateItem = async (item, changes, card) => {
        setCardBusy(card, true);
        try {
            const result = await updateChatMemory({
                chatId: state.chatId,
                chunkId: item.id,
                embedding: getEmbeddingConfig(settings),
                ...changes,
            });
            replaceItem(result.item);
            showNotice(changes.restore
                ? '已恢复为酒馆原文记忆。'
                : changes.disabled === true
                    ? '该记忆片段已禁用。'
                    : changes.disabled === false
                        ? '该记忆片段已重新启用。'
                        : '人工记忆已保存并重新生成向量。',
            'success');
        } catch (error) {
            setCardBusy(card, false);
            showNotice(`更新记忆失败：${error.message}`, 'error');
            console.error('[Memory Augment] Failed to update chat memory.', error);
        }
    };

    const createItem = (item) => {
        const card = document.createElement('article');
        card.className = 'memory-augment-memory-item';
        card.dataset.chunkId = item.id;
        card.classList.toggle('is-disabled', item.disabled === true);
        card.classList.toggle('is-manual', item.manual_override === true);

        const toggleId = `memory_augment_memory_item_${++memoryItemSequence}`;
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.id = toggleId;
        toggle.className = 'memory-augment-memory-item-toggle';
        toggle.setAttribute('aria-label', `展开第 ${item.message_id} 楼第 ${Number(item.segment_index ?? 0) + 1} 段`);

        const heading = document.createElement('label');
        heading.htmlFor = toggleId;
        heading.className = 'memory-augment-memory-item-heading';
        const title = document.createElement('strong');
        title.textContent = `第 ${item.message_id} 楼 · 第 ${Number(item.segment_index ?? 0) + 1} 段`;
        const badges = document.createElement('div');
        badges.className = 'memory-augment-memory-badges';
        badges.append(createBadge(describeRole(item.role)));
        if (item.manual_override) badges.append(createBadge('人工修改', 'manual'));
        if (item.disabled) badges.append(createBadge('已禁用', 'disabled'));
        heading.append(title, badges);

        const textarea = document.createElement('textarea');
        textarea.className = 'text_pole memory-augment-memory-text';
        textarea.rows = 5;
        textarea.value = String(item.text ?? '');
        textarea.setAttribute('aria-label', `第 ${item.message_id} 楼第 ${Number(item.segment_index ?? 0) + 1} 段记忆文本`);

        const meta = document.createElement('div');
        meta.className = 'memory-augment-memory-meta';
        meta.textContent = `${item.char_count ?? textarea.value.length} 字 · 向量 ${item.vector_dimension ?? 0} 维 · ${item.id}`;

        const actions = document.createElement('div');
        actions.className = 'memory-augment-actions memory-augment-memory-actions';
        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'menu_button';
        saveButton.textContent = '保存人工修改';
        saveButton.addEventListener('click', () => {
            const text = textarea.value.trim();
            if (!text) {
                showNotice('记忆文本不能为空。', 'warning');
                return;
            }
            if (text === item.text && item.manual_override) {
                showNotice('内容没有变化。');
                return;
            }
            void updateItem(item, { text }, card);
        });

        const toggleButton = document.createElement('button');
        toggleButton.type = 'button';
        toggleButton.className = 'menu_button';
        toggleButton.textContent = item.disabled ? '重新启用' : '禁止召回';
        toggleButton.addEventListener('click', () => {
            void updateItem(item, { disabled: !item.disabled }, card);
        });
        actions.append(saveButton, toggleButton);

        if (item.manual_override) {
            const restoreButton = document.createElement('button');
            restoreButton.type = 'button';
            restoreButton.className = 'menu_button';
            restoreButton.textContent = '恢复酒馆原文';
            restoreButton.addEventListener('click', async () => {
                const confirmed = await Popup.show.confirm(
                    '恢复酒馆原文？',
                    '这会撤销这一片段的人工修改，并重新生成向量。禁用状态也会一并解除。',
                );
                if (confirmed) void updateItem(item, { restore: true }, card);
            });
            actions.append(restoreButton);
        }

        const body = document.createElement('div');
        body.className = 'memory-augment-memory-item-body';
        body.append(textarea, meta, actions);
        card.append(toggle, heading, body);
        return card;
    };

    function render() {
        list.replaceChildren();
        if (!state.chatId) {
            status.textContent = '当前没有打开聊天。';
            loadMoreButton.hidden = true;
            return;
        }
        if (state.items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'memory-augment-worldinfo-empty';
            empty.textContent = state.query ? '没有找到匹配的记忆片段。' : '当前聊天还没有向量记忆。';
            list.append(empty);
        } else {
            list.append(...state.items.map(createItem));
        }
        status.textContent = state.error
            || `共 ${state.total} 个片段 · 人工修改 ${state.manualCount} 个 · 禁用 ${state.disabledCount} 个`;
        loadMoreButton.hidden = !state.hasMore;
        loadMoreButton.disabled = state.loading;
    }

    async function load({ reset = false } = {}) {
        if (state.loading) return;
        const chatId = getCurrentChatId();
        if (reset || chatId !== state.chatId) {
            state.chatId = String(chatId ?? '');
            state.items = [];
            state.offset = 0;
            state.total = 0;
            state.hasMore = false;
        }
        state.error = '';
        if (!state.chatId) {
            render();
            return;
        }

        state.loading = true;
        status.textContent = '正在读取当前聊天的向量记忆……';
        refreshButton.disabled = true;
        loadMoreButton.disabled = true;
        try {
            const result = await getChatMemory(state.chatId, {
                offset: state.offset,
                limit: PAGE_SIZE,
                query: state.query,
            });
            state.items.push(...(Array.isArray(result.items) ? result.items : []));
            state.offset = state.items.length;
            state.total = Number(result.total) || 0;
            state.hasMore = result.hasMore === true;
            state.manualCount = Number(result.manualCount) || 0;
            state.disabledCount = Number(result.disabledCount) || 0;
        } catch (error) {
            state.error = `读取失败：${error.message}`;
            showNotice(`读取向量记忆失败：${error.message}`, 'error');
            console.error('[Memory Augment] Failed to load chat memory.', error);
        } finally {
            state.loading = false;
            refreshButton.disabled = false;
            render();
        }
    }

    const applySearch = () => {
        state.query = search.value.trim();
        void load({ reset: true });
    };
    details.addEventListener('toggle', () => {
        if (details.open) void load({ reset: true });
    });
    searchButton.addEventListener('click', applySearch);
    search.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') applySearch();
    });
    refreshButton.addEventListener('click', () => void load({ reset: true }));
    loadMoreButton.addEventListener('click', () => void load());
    document.addEventListener('memory-augment:panel-open', () => {
        if (details.open) void load({ reset: true });
    });

    const chatChanged = context.eventTypes?.CHAT_CHANGED ?? context.event_types?.CHAT_CHANGED;
    if (chatChanged) {
        context.eventSource.on(chatChanged, () => {
            if (details.open) void load({ reset: true });
        });
    }
}
