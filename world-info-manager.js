import { embedWorldInfo } from './rag-client.js';
import { normalizeBaseUrl } from './api-utils.js';

const ENTRY_SEPARATOR = '::';
let currentEntries = [];

function showNotice(message, type = 'info') {
    if (globalThis.toastr?.[type]) {
        globalThis.toastr[type](message, 'Memory Augment');
    } else if (type === 'error') {
        console.error(`[Memory Augment] ${message}`);
    } else if (type === 'warning') {
        console.warn(`[Memory Augment] ${message}`);
    }
}

function getChatId(context) {
    return context?.getCurrentChatId?.() ?? context?.chatId;
}

function getEmbeddingConfig(settings) {
    const config = {
        baseUrl: normalizeBaseUrl(settings?.apis?.embedding?.url),
        apiKey: String(settings?.apis?.embedding?.apiKey ?? '').trim(),
        model: String(settings?.apis?.embedding?.model ?? '').trim(),
    };
    return config.baseUrl && config.apiKey && config.model ? config : null;
}

export function getWorldInfoEntryKey(world, uid) {
    return `${String(world)}${ENTRY_SEPARATOR}${String(uid)}`;
}

export function normalizeWorldInfoEntries(entries) {
    const unique = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const world = String(entry?.world ?? '').trim();
        const uid = String(entry?.uid ?? '').trim();
        const content = String(entry?.content ?? '').trim();
        if (!world || !uid || !content || entry?.disable === true) {
            continue;
        }

        const keys = Array.isArray(entry?.key) ? entry.key.filter(Boolean).join(', ') : '';
        const name = String(entry?.comment ?? '').trim() || keys || `Entry ${uid}`;
        const key = getWorldInfoEntryKey(world, uid);
        unique.set(key, { key, world, uid, name, content });
    }
    return [...unique.values()];
}

export async function loadAssociatedWorldInfoEntries(loader = null) {
    // getSortedEntries uses ST's current context internally and merges the
    // current chat, character, additional, global, and persona lorebooks.
    const load = loader ?? (async () => {
        SillyTavern.getContext();
        const { getSortedEntries } = await import('../../../world-info.js');
        return getSortedEntries();
    });
    return normalizeWorldInfoEntries(await load());
}

function getSelectedKeys(settings) {
    return new Set(Array.isArray(settings?.rag?.semanticWorldInfoEntries)
        ? settings.rag.semanticWorldInfoEntries.map(String)
        : []);
}

function setSelectedKey(settings, key, selected, context) {
    const keys = getSelectedKeys(settings);
    if (selected) {
        keys.add(key);
    } else {
        keys.delete(key);
    }
    settings.rag.semanticWorldInfoEntries = [...keys].sort();
    context.saveSettingsDebounced();
}

function updateSelectorStatus(settings) {
    const status = document.querySelector('#memory_augment_worldinfo_status');
    if (!status) return;
    const selected = getSelectedKeys(settings);
    const visibleSelected = currentEntries.filter(entry => selected.has(entry.key)).length;
    status.textContent = `当前关联 ${currentEntries.length} 条，已选择 ${visibleSelected} 条`;
}

export function renderWorldInfoSelector(settings, context) {
    const container = document.querySelector('#memory_augment_worldinfo_entries');
    if (!container) return;
    container.replaceChildren();
    const selected = getSelectedKeys(settings);

    if (currentEntries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'memory-augment-worldinfo-empty';
        empty.textContent = '当前角色/聊天没有关联的可用世界书条目。';
        container.append(empty);
        updateSelectorStatus(settings);
        return;
    }

    let activeWorld = null;
    for (const entry of currentEntries) {
        if (entry.world !== activeWorld) {
            activeWorld = entry.world;
            const heading = document.createElement('div');
            heading.className = 'memory-augment-worldinfo-book';
            heading.textContent = activeWorld;
            container.append(heading);
        }

        const label = document.createElement('label');
        label.className = 'checkbox_label memory-augment-worldinfo-entry';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selected.has(entry.key);
        checkbox.addEventListener('change', () => {
            setSelectedKey(settings, entry.key, checkbox.checked, context);
            updateSelectorStatus(settings);
        });
        const name = document.createElement('span');
        name.textContent = entry.name;
        name.title = entry.content.slice(0, 500);
        label.append(checkbox, name);
        container.append(label);
    }

    updateSelectorStatus(settings);
}

export async function vectorizeSelectedWorldInfo(settings, context, entries = currentEntries, client = embedWorldInfo) {
    const selectedKeys = getSelectedKeys(settings);
    const selectedEntries = entries.filter(entry => selectedKeys.has(entry.key));
    const embedding = getEmbeddingConfig(settings);
    if (selectedEntries.length > 0 && !embedding) {
        throw new Error('请先填写完整的 Embedding Base URL、API Key 和模型名。');
    }

    const chatId = getChatId(context);
    if (!chatId) {
        throw new Error('请先打开一个聊天。');
    }

    return client({
        chatId,
        embedding: embedding ?? {},
        input: selectedEntries.map(entry => entry.content),
        worldInfoEntries: selectedEntries.map(entry => ({
            id: entry.uid,
            name: entry.name,
            world: entry.world,
            text: entry.content,
        })),
    });
}

async function refreshSelector(settings, context) {
    const container = document.querySelector('#memory_augment_worldinfo_entries');
    if (container) container.textContent = '正在读取当前关联世界书…';
    try {
        currentEntries = await loadAssociatedWorldInfoEntries();
        renderWorldInfoSelector(settings, context);
    } catch (error) {
        if (container) container.textContent = `读取世界书失败：${error.message}`;
        console.error('[Memory Augment] Failed to load world info entries.', error);
    }
}

export async function initializeWorldInfoManager(settings, context) {
    await refreshSelector(settings, context);

    document.querySelector('#memory_augment_refresh_worldinfo')?.addEventListener('click', () => {
        void refreshSelector(settings, SillyTavern.getContext());
    });
    document.querySelector('#memory_augment_vectorize_worldinfo')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.classList.add('disabled');
        try {
            const result = await vectorizeSelectedWorldInfo(settings, SillyTavern.getContext());
            showNotice(`世界书向量已更新：${result.stored ?? 0} 条。`, 'success');
        } catch (error) {
            showNotice(`世界书向量化失败：${error.message}`, 'error');
            console.error('[Memory Augment] World info vectorization failed.', error);
        } finally {
            button.disabled = false;
            button.classList.remove('disabled');
        }
    });

    const worldInfoUpdated = context.eventTypes?.WORLDINFO_UPDATED ?? context.event_types?.WORLDINFO_UPDATED;
    const chatChanged = context.eventTypes?.CHAT_CHANGED ?? context.event_types?.CHAT_CHANGED;
    if (worldInfoUpdated) {
        context.eventSource.on(worldInfoUpdated, (worldName) => {
            const prefix = `${String(worldName)}${ENTRY_SEPARATOR}`;
            if ([...getSelectedKeys(settings)].some(key => key.startsWith(prefix))) {
                showNotice('已选择的世界书发生更新，请重新点击“向量化世界书”。', 'warning');
            }
            void refreshSelector(settings, SillyTavern.getContext());
        });
    }
    if (chatChanged) {
        context.eventSource.on(chatChanged, () => {
            setTimeout(() => void refreshSelector(settings, SillyTavern.getContext()), 0);
        });
    }
}
