import { getWorldInfoStatuses, syncWorldInfo } from './rag-client.js';
import { normalizeBaseUrl } from './api-utils.js';

const ENTRY_SEPARATOR = '::';
let currentBooks = [];
let syncQueue = Promise.resolve();

function showNotice(message, type = 'info') {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message, 'Memory Augment');
    else console[type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'info'](`[Memory Augment] ${message}`);
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
        if (!world || !uid || !content || entry?.disable === true) continue;
        const keys = Array.isArray(entry?.key) ? entry.key.filter(Boolean).join(', ') : '';
        const name = String(entry?.comment ?? '').trim() || keys || `Entry ${uid}`;
        const key = getWorldInfoEntryKey(world, uid);
        unique.set(key, {
            key, world, bookId: world, uid, name, content,
            entryKey: keys || name,
            constant: entry?.constant === true,
        });
    }
    return [...unique.values()];
}

function getBindingTypes(world, context, globals, personaBook, characterBooks) {
    const types = [];
    if (globals.has(world)) types.push('全局');
    if (String(context?.chatMetadata?.world_info ?? '') === world) types.push('聊天');
    if (String(personaBook ?? '') === world) types.push('persona');
    if (characterBooks.has(world)) types.push('角色');
    if (types.length === 0) types.push('角色');
    return types;
}

export async function loadAssociatedWorldInfoBooks(
    loader = null,
    context = globalThis.SillyTavern?.getContext?.() ?? {},
) {
    let rawEntries;
    let globals = new Set();
    let personaBook = '';
    const characterBooks = new Set();
    const character = context?.characters?.[context?.characterId];
    if (character?.data?.extensions?.world) characterBooks.add(String(character.data.extensions.world));
    if (loader) {
        rawEntries = await loader();
    } else {
        const [worldModule, powerModule] = await Promise.all([
            import('../../../world-info.js'),
            import('../../../power-user.js'),
        ]);
        rawEntries = await worldModule.getSortedEntries();
        globals = new Set((worldModule.selected_world_info ?? []).map(String));
        personaBook = powerModule.power_user?.persona_description_lorebook ?? '';
        const avatar = String(character?.avatar ?? '');
        const fileName = avatar.replace(/\.[^/.]+$/, '');
        const extra = worldModule.world_info?.charLore?.find(item => item.name === fileName || item.name === avatar);
        for (const book of extra?.extraBooks ?? []) characterBooks.add(String(book));
    }
    const grouped = new Map();
    for (const entry of normalizeWorldInfoEntries(rawEntries)) {
        if (!grouped.has(entry.bookId)) {
            grouped.set(entry.bookId, {
                id: entry.bookId,
                name: entry.bookId,
                bindingTypes: getBindingTypes(entry.bookId, context, globals, personaBook, characterBooks),
                linkedToCharacter: characterBooks.has(entry.bookId),
                entries: [],
                vectorizedEntries: 0,
            });
        }
        grouped.get(entry.bookId).entries.push(entry);
    }
    return [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
}

export async function loadAssociatedWorldInfoEntries(loader = null) {
    return (await loadAssociatedWorldInfoBooks(loader, globalThis.SillyTavern?.getContext?.() ?? {}))
        .flatMap(book => book.entries);
}

export function getActiveWorldInfoBookIds() {
    return currentBooks.map(book => book.id);
}

function getSelectedEntryKeys(settings) {
    return new Set(Array.isArray(settings?.rag?.semanticWorldInfoEntries)
        ? settings.rag.semanticWorldInfoEntries.map(String) : []);
}

function getSelectedBookIds(settings) {
    return new Set(Array.isArray(settings?.rag?.semanticWorldInfoBooks)
        ? settings.rag.semanticWorldInfoBooks.map(String) : []);
}

function saveSelections(settings, context, books, entries) {
    settings.rag.semanticWorldInfoBooks = [...books].sort();
    settings.rag.semanticWorldInfoEntries = [...entries].sort();
    context.saveSettingsDebounced();
}

function getSelectedEntriesForBook(settings, book) {
    const books = getSelectedBookIds(settings);
    const entries = getSelectedEntryKeys(settings);
    return books.has(book.id) ? book.entries : book.entries.filter(entry => entries.has(entry.key));
}

function hasConfiguredSelection(settings, bookId) {
    return getSelectedBookIds(settings).has(bookId)
        || [...getSelectedEntryKeys(settings)].some(key => key.startsWith(`${bookId}${ENTRY_SEPARATOR}`));
}

function contentHash(text) {
    let value = 2166136261;
    for (const character of String(text)) {
        value ^= character.codePointAt(0);
        value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(16).padStart(8, '0');
}

async function syncBook(settings, book, client = syncWorldInfo) {
    const selectedEntries = getSelectedEntriesForBook(settings, book);
    const embedding = getEmbeddingConfig(settings);
    if (selectedEntries.length > 0 && !embedding) {
        throw new Error('请先填写完整的 Embedding Base URL、API Key 和模型名。');
    }
    return client({
        type: 'worldinfo',
        book_id: book.id,
        targetChars: settings?.rag?.segmentTargetChars ?? 400,
        embedding: embedding ?? {},
        entries: selectedEntries.map(entry => ({
            entry_uid: entry.uid,
            entry_key: entry.entryKey,
            text: entry.content,
            content_hash: contentHash(entry.content),
        })),
    });
}

export async function vectorizeSelectedWorldInfo(settings, _context, books = currentBooks, client = syncWorldInfo) {
    const results = [];
    for (const book of books) results.push(await syncBook(settings, book, client));
    return {
        books: results.length,
        entries: results.reduce((sum, result) => sum + Number(result.entries ?? 0), 0),
        chunks: results.reduce((sum, result) => sum + Number(result.chunks ?? 0), 0),
        embedded: results.reduce((sum, result) => sum + Number(result.embedded ?? 0), 0),
        results,
    };
}

async function loadVectorStatuses() {
    if (currentBooks.length === 0) return;
    try {
        const response = await getWorldInfoStatuses(currentBooks.map(book => book.id));
        applyWorldInfoVectorStatuses(currentBooks, response);
    } catch (error) {
        console.warn('[Memory Augment] Failed to load world info vector status.', error);
    }
}

export function applyWorldInfoVectorStatuses(books, response) {
    const statuses = response?.statuses && typeof response.statuses === 'object'
        ? response.statuses
        : response;
    for (const book of Array.isArray(books) ? books : []) {
        book.vectorizedEntries = Number(statuses?.[book.id]?.entryCount ?? 0);
    }
    return books;
}

function updateSelectorStatus(settings) {
    const status = document.querySelector('#memory_augment_worldinfo_status');
    if (!status) return;
    const selected = currentBooks.reduce((sum, book) => sum + getSelectedEntriesForBook(settings, book).length, 0);
    const total = currentBooks.reduce((sum, book) => sum + book.entries.length, 0);
    status.textContent = `${currentBooks.length} 本 / ${total} 条，已选择 ${selected} 条`;
}

function makeBadge(text, className) {
    const badge = document.createElement('span');
    badge.className = `memory-augment-worldinfo-badge ${className}`;
    badge.textContent = text;
    return badge;
}

export function renderWorldInfoSelector(settings, context) {
    const container = document.querySelector('#memory_augment_worldinfo_entries');
    if (!container) return;
    container.replaceChildren();
    const selectedBooks = getSelectedBookIds(settings);
    const selectedEntries = getSelectedEntryKeys(settings);
    if (currentBooks.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'memory-augment-worldinfo-empty';
        empty.textContent = '当前角色、聊天、全局和 persona 没有激活的可用世界书。';
        container.append(empty);
        updateSelectorStatus(settings);
        return;
    }

    for (const book of currentBooks) {
        const details = document.createElement('details');
        details.className = 'memory-augment-worldinfo-book';
        const summary = document.createElement('summary');
        summary.className = 'memory-augment-worldinfo-book-header';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const selectedCount = getSelectedEntriesForBook(settings, book).length;
        checkbox.checked = selectedBooks.has(book.id);
        checkbox.indeterminate = !checkbox.checked && selectedCount > 0;
        checkbox.addEventListener('click', event => event.stopPropagation());
        checkbox.addEventListener('change', () => {
            const books = getSelectedBookIds(settings);
            const entries = getSelectedEntryKeys(settings);
            if (checkbox.checked) {
                books.add(book.id);
                book.entries.forEach(entry => entries.delete(entry.key));
            } else {
                books.delete(book.id);
                book.entries.forEach(entry => entries.delete(entry.key));
            }
            saveSelections(settings, context, books, entries);
            renderWorldInfoSelector(settings, context);
        });
        const title = document.createElement('strong');
        title.textContent = book.name;
        const binding = makeBadge(book.bindingTypes.join('/'), 'is-binding');
        const vectorStatus = document.createElement('span');
        vectorStatus.className = 'memory-augment-worldinfo-vector-status';
        vectorStatus.textContent = book.vectorizedEntries > 0
            ? `已向量化 ${book.vectorizedEntries}/${book.entries.length} 条目`
            : '未向量化';
        summary.append(checkbox, title, binding, vectorStatus);
        details.append(summary);

        const entryList = document.createElement('div');
        entryList.className = 'memory-augment-worldinfo-entry-list';
        for (const entry of book.entries) {
            const label = document.createElement('label');
            label.className = `checkbox_label memory-augment-worldinfo-entry ${entry.constant ? 'is-constant' : 'is-keyword'}`;
            const entryCheckbox = document.createElement('input');
            entryCheckbox.type = 'checkbox';
            entryCheckbox.checked = selectedBooks.has(book.id) || selectedEntries.has(entry.key);
            entryCheckbox.addEventListener('change', () => {
                const books = getSelectedBookIds(settings);
                const entries = getSelectedEntryKeys(settings);
                if (books.delete(book.id)) {
                    book.entries.filter(item => item.key !== entry.key).forEach(item => entries.add(item.key));
                }
                if (entryCheckbox.checked) entries.add(entry.key); else entries.delete(entry.key);
                saveSelections(settings, context, books, entries);
                renderWorldInfoSelector(settings, context);
            });
            const name = document.createElement('span');
            name.textContent = entry.name;
            name.title = entry.content.slice(0, 500);
            label.append(entryCheckbox, name,
                entry.constant ? makeBadge('常驻 · 语义触发意义不大', 'is-constant') : makeBadge('关键词', 'is-keyword'));
            entryList.append(label);
        }
        details.append(entryList);
        container.append(details);
    }
    updateSelectorStatus(settings);
}

async function refreshSelector(settings, context) {
    const container = document.querySelector('#memory_augment_worldinfo_entries');
    if (container) container.textContent = '正在读取当前所有激活世界书…';
    try {
        currentBooks = await loadAssociatedWorldInfoBooks(null, context);
        Object.defineProperty(settings.rag, 'activeWorldInfoBookIds', {
            value: currentBooks.map(book => book.id),
            writable: true,
            configurable: true,
            enumerable: false,
        });
        await loadVectorStatuses();
        renderWorldInfoSelector(settings, context);
    } catch (error) {
        if (container) container.textContent = `读取世界书失败：${error.message}`;
        console.error('[Memory Augment] Failed to load world info books.', error);
    }
}

function queueSilentBookSync(settings, bookName) {
    syncQueue = syncQueue.catch(() => undefined).then(async () => {
        const context = SillyTavern.getContext();
        await refreshSelector(settings, context);
        const book = currentBooks.find(item => item.id === String(bookName));
        if (!book || !hasConfiguredSelection(settings, book.id) || !getEmbeddingConfig(settings)) return;
        await syncBook(settings, book);
        await loadVectorStatuses();
        renderWorldInfoSelector(settings, context);
    }).catch(error => console.error('[Memory Augment] Silent world info synchronization failed.', error));
}

export async function initializeWorldInfoManager(settings, context) {
    settings.rag.semanticWorldInfoBooks ??= [];
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
            await refreshSelector(settings, SillyTavern.getContext());
            showNotice(`世界书向量已更新：${result.entries} 个条目，${result.chunks} 个片段。`, 'success');
        } catch (error) {
            showNotice(`世界书向量化失败：${error.message}`, 'error');
            console.error('[Memory Augment] World info vectorization failed.', error);
        } finally {
            button.disabled = false;
            button.classList.remove('disabled');
        }
    });

    const worldInfoUpdated = context.eventTypes?.WORLDINFO_UPDATED ?? context.event_types?.WORLDINFO_UPDATED;
    const worldInfoSettingsUpdated = context.eventTypes?.WORLDINFO_SETTINGS_UPDATED
        ?? context.event_types?.WORLDINFO_SETTINGS_UPDATED;
    const chatChanged = context.eventTypes?.CHAT_CHANGED ?? context.event_types?.CHAT_CHANGED;
    if (worldInfoUpdated) context.eventSource.on(worldInfoUpdated, worldName => queueSilentBookSync(settings, worldName));
    if (worldInfoSettingsUpdated) context.eventSource.on(worldInfoSettingsUpdated,
        () => void refreshSelector(settings, SillyTavern.getContext()));
    if (chatChanged) context.eventSource.on(chatChanged, () => setTimeout(() => void refreshSelector(settings, SillyTavern.getContext()), 0));
}
