import { getWorldInfoStatuses, syncWorldInfo } from './rag-client.js';
import { normalizeBaseUrl } from './api-utils.js';

const ENTRY_SEPARATOR = '::';
const MANAGED_SUMMARY_KEY_PREFIXES = ['[KKT摘要]', '[KKToolbox摘要]', '[KKT历史概括]'];
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

export function isManagedSummaryWorldInfoBookName(value) {
    return /-自动总结(?:[1-9]\d*)?$/.test(String(value ?? '').trim());
}

export function normalizeWorldInfoEntries(entries) {
    const unique = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const world = String(entry?.world ?? '').trim();
        const uid = String(entry?.uid ?? '').trim();
        const content = String(entry?.content ?? '').trim();
        if (!world || !uid || !content || entry?.disable === true) continue;
        const rawKeys = Array.isArray(entry?.key) ? entry.key.filter(Boolean).map(String) : [];
        const keys = rawKeys.join(', ');
        const name = String(entry?.comment ?? '').trim() || keys || `Entry ${uid}`;
        const key = getWorldInfoEntryKey(world, uid);
        unique.set(key, {
            key, world, bookId: world, uid, name, content,
            entryKey: keys || name,
            constant: entry?.constant === true,
            managedBySummaryRag: rawKeys.some(key => MANAGED_SUMMARY_KEY_PREFIXES.some(prefix => key.startsWith(prefix))),
        });
    }
    return [...unique.values()];
}

export function isManagedSummaryWorldInfoBook(book) {
    return isManagedSummaryWorldInfoBookName(book?.id ?? book?.name)
        || (Array.isArray(book?.entries) && book.entries.some(entry => entry?.managedBySummaryRag === true));
}

function getBindingTypes(world, context, globals, personaBook, characterBooks) {
    const types = [];
    if (globals.has(world)) types.push('全局');
    if (String(context?.chatMetadata?.world_info ?? '') === world) types.push('聊天');
    if (String(personaBook ?? '') === world) types.push('persona');
    if (characterBooks.has(world)) types.push('角色');
    if (types.length === 0) types.push('其他激活');
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
    if (isManagedSummaryWorldInfoBook(book)) return [];
    const books = getSelectedBookIds(settings);
    const entries = getSelectedEntryKeys(settings);
    return books.has(book.id) ? book.entries : book.entries.filter(entry => entries.has(entry.key));
}

function hasConfiguredSelection(settings, bookId) {
    const book = currentBooks.find(item => item.id === String(bookId));
    if (book && isManagedSummaryWorldInfoBook(book)) return false;
    return getSelectedBookIds(settings).has(bookId)
        || [...getSelectedEntryKeys(settings)].some(key => key.startsWith(`${bookId}${ENTRY_SEPARATOR}`));
}

function getEntryBookId(entryKey) {
    const value = String(entryKey ?? '');
    const separatorIndex = value.lastIndexOf(ENTRY_SEPARATOR);
    return separatorIndex > 0 ? value.slice(0, separatorIndex) : '';
}

export function sanitizeManagedSummarySelections(settings, books = currentBooks) {
    const managedBookIds = new Set((Array.isArray(books) ? books : [])
        .filter(isManagedSummaryWorldInfoBook)
        .map(book => String(book.id)));
    const selectedBooks = getSelectedBookIds(settings);
    const selectedEntries = getSelectedEntryKeys(settings);
    const nextBooks = new Set([...selectedBooks].filter(bookId => (
        !managedBookIds.has(bookId) && !isManagedSummaryWorldInfoBookName(bookId)
    )));
    const nextEntries = new Set([...selectedEntries].filter(entryKey => {
        const bookId = getEntryBookId(entryKey);
        return !managedBookIds.has(bookId) && !isManagedSummaryWorldInfoBookName(bookId);
    }));
    const changed = nextBooks.size !== selectedBooks.size || nextEntries.size !== selectedEntries.size;
    if (changed) {
        settings.rag.semanticWorldInfoBooks = [...nextBooks].sort();
        settings.rag.semanticWorldInfoEntries = [...nextEntries].sort();
    }
    return changed;
}

function removeManagedSummarySelections(settings, context) {
    const changed = sanitizeManagedSummarySelections(settings, currentBooks);
    if (changed) context.saveSettingsDebounced();
    return changed;
}

function contentHash(text) {
    let value = 2166136261;
    for (const character of String(text)) {
        value ^= character.codePointAt(0);
        value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(16).padStart(8, '0');
}

async function syncBook(settings, book, client = syncWorldInfo, { replace = false, allEntries = false } = {}) {
    const managedBySummaryRag = isManagedSummaryWorldInfoBook(book);
    const selectedEntries = allEntries && !managedBySummaryRag ? book.entries : getSelectedEntriesForBook(settings, book);
    const syncMode = replace || managedBySummaryRag ? 'replace' : 'merge';
    if (selectedEntries.length === 0 && syncMode === 'merge') {
        return { bookId: book.id, entries: 0, chunks: 0, embedded: 0, skipped: true };
    }
    const embedding = getEmbeddingConfig(settings);
    if (selectedEntries.length > 0 && !embedding) {
        throw new Error('请先填写完整的 Embedding Base URL、API Key 和模型名。');
    }
    return client({
        type: 'worldinfo',
        book_id: book.id,
        sync_mode: syncMode,
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
        books: results.filter(result => !result?.skipped).length,
        entries: results.reduce((sum, result) => sum + Number(result.entries ?? 0), 0),
        chunks: results.reduce((sum, result) => sum + Number(result.chunks ?? 0), 0),
        embedded: results.reduce((sum, result) => sum + Number(result.embedded ?? 0), 0),
        results,
    };
}

export async function rebuildAllCurrentWorldInfo(settings, _context, books = currentBooks, client = syncWorldInfo) {
    const results = [];
    for (const book of books) {
        results.push(await syncBook(settings, book, client, { replace: true, allEntries: true }));
    }
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
    const managed = currentBooks.filter(isManagedSummaryWorldInfoBook).length;
    status.textContent = `${currentBooks.length} 本 / ${total} 条，手动选择 ${selected} 条${managed > 0 ? `，${managed} 本由剧情 RAG 自动管理` : ''}`;
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
    const openBookIds = new Set([...container.querySelectorAll('details[open][data-book-id]')]
        .map(details => String(details.dataset.bookId ?? ''))
        .filter(Boolean));
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
        const managedBySummaryRag = isManagedSummaryWorldInfoBook(book);
        const details = document.createElement('details');
        details.className = `memory-augment-worldinfo-book${managedBySummaryRag ? ' is-summary-managed' : ''}`;
        details.dataset.bookId = book.id;
        details.open = openBookIds.has(book.id);
        const summary = document.createElement('summary');
        summary.className = 'memory-augment-worldinfo-book-header';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const selectedCount = getSelectedEntriesForBook(settings, book).length;
        checkbox.checked = !managedBySummaryRag && selectedBooks.has(book.id);
        checkbox.disabled = managedBySummaryRag;
        checkbox.hidden = managedBySummaryRag;
        checkbox.title = managedBySummaryRag
            ? '自动总结由剧情 RAG 独立管理；是否绑定请看右侧来源标签'
            : '勾选这里会选择整本；点击书名可以只选部分条目';
        checkbox.indeterminate = !managedBySummaryRag && !checkbox.checked && selectedCount > 0;
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
        const constantCount = book.entries.filter(entry => entry.constant).length;
        const keywordCount = Math.max(0, book.entries.length - constantCount);
        const recommendation = managedBySummaryRag
            ? makeBadge('自动总结', 'is-summary-managed')
            : constantCount > 0 && constantCount >= keywordCount
                ? makeBadge(`常驻 ${constantCount} · 通常无需向量化`, 'is-constant')
                : makeBadge(`关键词 ${keywordCount} · 适合语义检索`, 'is-keyword');
        const vectorStatus = document.createElement('span');
        vectorStatus.className = 'memory-augment-worldinfo-vector-status';
        vectorStatus.textContent = managedBySummaryRag
            ? '已自动纳入剧情 RAG，无需再次向量化'
            : book.vectorizedEntries > 0
            ? `已向量化 ${book.vectorizedEntries}/${book.entries.length} 条目`
            : '未向量化';
        const expandHint = document.createElement('span');
        expandHint.className = 'memory-augment-worldinfo-expand-hint';
        expandHint.textContent = details.open ? '收起条目' : '展开选择条目';
        details.addEventListener('toggle', () => {
            expandHint.textContent = details.open ? '收起条目' : '展开选择条目';
        });
        const headerActions = document.createElement('span');
        headerActions.className = 'memory-augment-worldinfo-header-actions';
        headerActions.append(vectorStatus, expandHint);
        summary.append(checkbox, title, binding, recommendation, headerActions);
        details.append(summary);

        if (!managedBySummaryRag) {
            const bookActions = document.createElement('div');
            bookActions.className = 'memory-augment-worldinfo-book-actions';

            const selectKeywords = document.createElement('button');
            selectKeywords.type = 'button';
            selectKeywords.className = 'menu_button';
            selectKeywords.textContent = '只选绿灯';
            selectKeywords.title = '只选择本书的关键词条目；其他世界书的选择保持不变';
            selectKeywords.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const books = getSelectedBookIds(settings);
                const entries = getSelectedEntryKeys(settings);
                books.delete(book.id);
                book.entries.forEach(entry => entries.delete(entry.key));
                book.entries.filter(entry => !entry.constant).forEach(entry => entries.add(entry.key));
                saveSelections(settings, context, books, entries);
                renderWorldInfoSelector(settings, context);
            });

            const clearBook = document.createElement('button');
            clearBook.type = 'button';
            clearBook.className = 'menu_button';
            clearBook.textContent = '清空本书选择';
            clearBook.title = '只清空本书，其他世界书的选择保持不变';
            clearBook.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const books = getSelectedBookIds(settings);
                const entries = getSelectedEntryKeys(settings);
                books.delete(book.id);
                book.entries.forEach(entry => entries.delete(entry.key));
                saveSelections(settings, context, books, entries);
                renderWorldInfoSelector(settings, context);
            });

            bookActions.append(selectKeywords, clearBook);
            details.append(bookActions);
        }

        const entryList = document.createElement('div');
        entryList.className = 'memory-augment-worldinfo-entry-list';
        for (const entry of book.entries) {
            const label = document.createElement('label');
            label.className = `checkbox_label memory-augment-worldinfo-entry ${entry.constant ? 'is-constant' : 'is-keyword'}`;
            const entryCheckbox = document.createElement('input');
            entryCheckbox.type = 'checkbox';
            entryCheckbox.checked = managedBySummaryRag || selectedBooks.has(book.id) || selectedEntries.has(entry.key);
            entryCheckbox.disabled = managedBySummaryRag;
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
            label.append(entryCheckbox, name, managedBySummaryRag
                ? makeBadge('剧情 RAG 已接管', 'is-summary-managed')
                : entry.constant
                    ? makeBadge('常驻 · 语义触发意义不大', 'is-constant')
                    : makeBadge('关键词', 'is-keyword'));
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
        removeManagedSummarySelections(settings, context);
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
            showNotice(`已构建/更新：${result.entries} 个勾选条目，${result.chunks} 个片段；其他已有向量保持不变。`, 'success');
        } catch (error) {
            showNotice(`世界书向量化失败：${error.message}`, 'error');
            console.error('[Memory Augment] World info vectorization failed.', error);
        } finally {
            button.disabled = false;
            button.classList.remove('disabled');
        }
    });
    document.querySelector('#memory_augment_rebuild_worldinfo')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.classList.add('disabled');
        try {
            const result = await rebuildAllCurrentWorldInfo(settings, SillyTavern.getContext());
            await refreshSelector(settings, SillyTavern.getContext());
            showNotice(`当前所有世界书已重建：${result.entries} 个条目，${result.chunks} 个片段；聊天向量未改动。`, 'success');
        } catch (error) {
            showNotice(`重建当前所有世界书失败：${error.message}`, 'error');
            console.error('[Memory Augment] World info rebuild failed.', error);
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
