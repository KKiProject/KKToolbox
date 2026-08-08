import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { normalizeBaseUrl } from './api-utils.js';
import { bindChatIngestionLifecycle, reconcileBufferedMessageQueue } from './chat-lifecycle.js';
import { initializeChatMemoryUi } from './chat-memory-ui.js';
import { memoryAugmentInterceptor } from './context-manager.js';
import { fetchModels, getStatus, ingestChat, reconcileChatVectors } from './rag-client.js';
import { initializeBarrageUi, refreshBarrageVisibility } from './barrage-ui.js';
import {
    correctLatestStoryTime,
    getMessageTimelineMetadata,
    initializeStoryStatusUi,
    refreshStoryStatusUi,
} from './story-status.js';
import { initializeMapAtlasUi } from './map-atlas.js';
import {
    deleteDevelopmentField,
    discardDevelopmentCandidate,
    initializeCharacterDevelopmentUi,
    promoteDevelopmentCandidate,
    refreshCharacterDevelopmentUi,
    setManualDevelopmentField,
} from './character-development.js';
import { initializeDevelopmentBaselineUi } from './character-baseline.js';
import { clearAllSummaries, getSummaryStatus, initializeSummaryManager, repairMalformedSummaries } from './summary-manager.js';
import { initializeWorldInfoManager, rebuildAllCurrentWorldInfo } from './world-info-manager.js';
import { initializeHtmlRenderer, refreshHtmlRenderer } from './html-renderer.js';
import { initializePhoneShellUi } from './phone-shell.js';
import {
    clearPreparedPhoneContext,
    consumePreparedPhoneContext,
    getPhoneChatId,
} from './phone-store.js';
import { initializeSwipeCleanup } from './swipe-cleanup.js';

const EXTENSION_KEY = 'st-memory-augment';
const EXTENSION_FOLDER = decodeURIComponent(new URL('.', import.meta.url).pathname)
    .split('/')
    .filter(Boolean)
    .at(-1);
const TEMPLATE_PATH = `third-party/${EXTENSION_FOLDER}`;
const API_TYPES = ['embedding', 'reranker', 'barrage'];
const LEGACY_DEFAULT_BARRAGE_PROMPT = '你是一群正在观看小说直播的观众，请以弹幕/评论区风格吐槽点评';
let ingestionQueue = Promise.resolve();
let quickPanelPromise = null;

export async function refreshDisplayedVersion(documentRef = globalThis.document, fetchImpl = globalThis.fetch) {
    const badge = documentRef?.querySelector?.('#memory_augment_settings .memory-augment-version');
    if (!badge || typeof fetchImpl !== 'function') return false;
    try {
        const response = await fetchImpl(new URL('./manifest.json', import.meta.url), { cache: 'no-store' });
        if (!response?.ok) return false;
        const version = String((await response.json())?.version ?? '').trim();
        if (!version) return false;
        badge.textContent = `v${version}`;
        return true;
    } catch (error) {
        console.warn('[Memory Augment] Failed to read the displayed extension version.', error);
        return false;
    }
}

export const defaultSettings = Object.freeze({
    apis: {
        embedding: { url: '', apiKey: '', model: '', availableModels: [], modelsBaseUrl: '' },
        reranker: { url: '', apiKey: '', model: '', availableModels: [], modelsBaseUrl: '' },
        barrage: { url: '', apiKey: '', model: '', availableModels: [], modelsBaseUrl: '' },
    },
    context: {
        recentMessages: 20,
        summaryBatchSize: 15,
    },
    rag: {
        segmentTargetChars: 400,
        topK: 25,
        topN: 7,
        rerankerThreshold: 0.6,
        semanticWorldInfo: false,
        semanticWorldInfoBooks: [],
        semanticWorldInfoEntries: [],
    },
    barrage: {
        enabled: false,
        recentMessages: 5,
        maxTokens: 4064,
        includeRag: true,
        systemPrompt: '',
    },
    status: {
        enabled: false,
        showGoals: true,
        customFields: [],
        position: {},
    },
    development: {
        enabled: true,
        baselineSourcesByOwner: {},
    },
    map: {
        includeInPrompt: true,
        maxTokens: 16000,
        atlases: {},
        sourceEntryKeysByOwner: {},
    },
    htmlRenderer: {
        enabled: true,
    },
    phone: {
        maxTokens: 2048,
        stickers: [],
        stickerGroups: [{ id: 'default', name: '默认' }],
        profile: { nickname: '我', avatar: '' },
    },
});

globalThis.memoryAugmentInterceptor = memoryAugmentInterceptor;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function mergeSettings(defaults, saved) {
    const merged = clone(defaults);

    for (const [key, value] of Object.entries(saved ?? {})) {
        if (value && typeof value === 'object' && !Array.isArray(value)
            && merged[key] && typeof merged[key] === 'object') {
            merged[key] = mergeSettings(merged[key], value);
        } else {
            merged[key] = value;
        }
    }

    return merged;
}

function getValueByPath(object, path) {
    return path.split('.').reduce((value, key) => value?.[key], object);
}

function setValueByPath(object, path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((item, key) => item[key] ??= {}, object);
    target[lastKey] = value;
}

function readInputValue(input) {
    if (input.type === 'checkbox') {
        return input.checked;
    }

    if (input.type === 'number' || input.type === 'range') {
        const number = Number(input.value);
        return Number.isFinite(number) ? number : 0;
    }

    return input.value;
}

function updateValueLabel(input) {
    const label = document.querySelector(`[data-value-for="${input.id}"]`);
    if (label) {
        label.textContent = input.value;
    }
}

function bindSettings(settings, context) {
    document.querySelectorAll('#memory_augment_settings [data-setting]').forEach((input) => {
        const value = getValueByPath(settings, input.dataset.setting);

        if (input.type === 'checkbox') {
            input.checked = Boolean(value);
        } else if (value !== undefined && value !== null) {
            input.value = String(value);
        }

        updateValueLabel(input);
        input.addEventListener('input', () => {
            setValueByPath(settings, input.dataset.setting, readInputValue(input));
            updateValueLabel(input);
            context.saveSettingsDebounced();
            if (input.dataset.setting.startsWith('status.')) refreshStoryStatusUi(context);
            if (input.dataset.setting.startsWith('development.')) refreshCharacterDevelopmentUi(context);
            if (input.dataset.setting === 'barrage.enabled') refreshBarrageVisibility(settings, context);
            if (input.dataset.setting === 'htmlRenderer.enabled') refreshHtmlRenderer();
        });
    });
}

function bindStatusCustomFields(settings, context) {
    const container = document.querySelector('#memory_augment_status_custom_fields');
    const addButton = document.querySelector('#memory_augment_add_status_custom_field');
    if (!container || !addButton) return;
    if (!Array.isArray(settings.status.customFields)) settings.status.customFields = [];

    const save = () => {
        context.saveSettingsDebounced();
        refreshStoryStatusUi(context);
    };
    const render = () => {
        container.replaceChildren();
        if (settings.status.customFields.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'memory-augment-status-custom-empty';
            empty.textContent = '尚未添加自定义状态项。';
            container.append(empty);
            return;
        }

        settings.status.customFields.forEach((field, index) => {
            const row = document.createElement('div');
            row.className = 'memory-augment-status-custom-row';
            const enabledLabel = document.createElement('label');
            enabledLabel.className = 'checkbox_label';
            const enabled = document.createElement('input');
            enabled.type = 'checkbox';
            enabled.checked = field?.enabled !== false;
            const enabledText = document.createElement('span');
            enabledText.textContent = '启用';
            enabledLabel.append(enabled, enabledText);
            const name = document.createElement('input');
            name.type = 'text';
            name.className = 'text_pole';
            name.maxLength = 80;
            name.placeholder = '例如：伤势、疲惫、魔力状态';
            name.value = String(field?.label ?? '');
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'menu_button';
            remove.textContent = '删除';

            enabled.addEventListener('input', () => {
                field.enabled = enabled.checked;
                save();
            });
            name.addEventListener('input', () => {
                field.label = name.value.slice(0, 80);
                save();
            });
            remove.addEventListener('click', () => {
                settings.status.customFields.splice(index, 1);
                render();
                save();
            });
            row.append(enabledLabel, name, remove);
            container.append(row);
        });
    };

    addButton.addEventListener('click', () => {
        settings.status.customFields.push({
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            label: '',
            enabled: true,
        });
        render();
        save();
    });
    render();
}

function setModelStatus(apiType, message = '', state = '') {
    const status = document.querySelector(`[data-model-status="${apiType}"]`);
    if (!status) {
        return;
    }

    status.textContent = message;
    status.classList.toggle('is-error', state === 'error');
    status.classList.toggle('is-success', state === 'success');
}

function renderModelPicker(settings, apiType, options = {}) {
    const apiSettings = settings.apis[apiType];
    const select = document.querySelector(`[data-model-select="${apiType}"]`);
    const selectField = document.querySelector(`[data-model-select-field="${apiType}"]`);
    const manualField = document.querySelector(`[data-model-manual-field="${apiType}"]`);
    if (!apiSettings || !select || !selectField || !manualField) {
        return;
    }

    const currentBaseUrl = normalizeBaseUrl(apiSettings.url);
    const cachedModels = Array.isArray(apiSettings.availableModels)
        ? [...new Set(apiSettings.availableModels.map(value => String(value ?? '').trim()).filter(Boolean))]
        : [];
    const cacheMatches = cachedModels.length > 0
        && normalizeBaseUrl(apiSettings.modelsBaseUrl) === currentBaseUrl;

    if (cacheMatches && !options.forceManual) {
        const currentModel = String(apiSettings.model ?? '').trim();
        const models = currentModel && !cachedModels.includes(currentModel)
            ? [currentModel, ...cachedModels]
            : cachedModels;
        select.replaceChildren();

        if (!currentModel) {
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '请选择模型';
            select.append(placeholder);
        }

        for (const model of models) {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model === currentModel && !cachedModels.includes(model)
                ? `${model}（当前配置，列表中不存在）`
                : model;
            select.append(option);
        }

        select.value = currentModel;
        selectField.hidden = false;
        manualField.hidden = true;
        setModelStatus(
            apiType,
            options.successMessage ?? `已缓存 ${cachedModels.length} 个可用模型。`,
            'success',
        );
        return;
    }

    selectField.hidden = true;
    manualField.hidden = false;
    if (options.errorMessage) {
        setModelStatus(apiType, `${options.errorMessage}；已保留手动输入。`, 'error');
    } else if (!currentBaseUrl || !String(apiSettings.apiKey ?? '').trim()) {
        setModelStatus(apiType, '填写 Base URL 和 API Key 后可拉取模型。');
    } else {
        setModelStatus(apiType, '可拉取模型列表，或继续手动填写模型名。');
    }
}

function updateFetchButton(settings, apiType) {
    const button = document.querySelector(`[data-fetch-models="${apiType}"]`);
    if (!button || button.classList.contains('is-loading')) {
        return;
    }

    const apiSettings = settings.apis[apiType];
    button.disabled = !normalizeBaseUrl(apiSettings?.url) || !String(apiSettings?.apiKey ?? '').trim();
}

function bindModelDiscovery(settings, context) {
    for (const apiType of API_TYPES) {
        const urlInput = document.querySelector(`[data-api-url="${apiType}"]`);
        const keyInput = document.querySelector(`[data-api-key="${apiType}"]`);
        const select = document.querySelector(`[data-model-select="${apiType}"]`);
        const manualInput = document.querySelector(`[data-model-manual="${apiType}"]`);
        const button = document.querySelector(`[data-fetch-models="${apiType}"]`);

        renderModelPicker(settings, apiType);
        updateFetchButton(settings, apiType);

        urlInput?.addEventListener('input', () => {
            updateFetchButton(settings, apiType);
            renderModelPicker(settings, apiType);
        });
        keyInput?.addEventListener('input', () => updateFetchButton(settings, apiType));

        select?.addEventListener('change', () => {
            settings.apis[apiType].model = select.value;
            if (manualInput) {
                manualInput.value = select.value;
            }
            context.saveSettingsDebounced();
        });

        button?.addEventListener('click', async () => {
            const apiSettings = settings.apis[apiType];
            const requestConfig = {
                baseUrl: normalizeBaseUrl(apiSettings.url),
                apiKey: String(apiSettings.apiKey ?? '').trim(),
            };
            button.disabled = true;
            button.classList.add('is-loading');
            button.setAttribute('aria-busy', 'true');
            setModelStatus(apiType, '正在拉取模型列表…');

            try {
                const response = await fetchModels(requestConfig);
                const models = Array.isArray(response?.models) ? response.models : [];
                if (models.length === 0) {
                    throw new Error('接口未返回任何模型');
                }
                if (normalizeBaseUrl(apiSettings.url) !== requestConfig.baseUrl
                    || String(apiSettings.apiKey ?? '').trim() !== requestConfig.apiKey) {
                    throw new Error('API 配置已改变，请重新拉取模型');
                }

                apiSettings.availableModels = models;
                apiSettings.modelsBaseUrl = requestConfig.baseUrl;
                context.saveSettingsDebounced();
                renderModelPicker(settings, apiType, {
                    successMessage: `已拉取并缓存 ${models.length} 个模型。`,
                });
            } catch (error) {
                console.warn(`[Memory Augment] Failed to fetch ${apiType} models.`, error);
                renderModelPicker(settings, apiType, {
                    forceManual: true,
                    errorMessage: error?.message ?? '模型列表拉取失败',
                });
            } finally {
                button.classList.remove('is-loading');
                button.removeAttribute('aria-busy');
                updateFetchButton(settings, apiType);
            }
        });
    }
}

function showNotice(message, type = 'info') {
    if (globalThis.toastr?.[type]) {
        globalThis.toastr[type](message, 'Memory Augment');
    } else if (type === 'error') {
        console.error(`[Memory Augment] ${message}`);
    } else if (type === 'warning') {
        console.warn(`[Memory Augment] ${message}`);
    }
}

function renderStatus(status) {
    const state = String(status.status ?? 'unknown');
    const stateElement = document.querySelector('#memory_augment_status_state');
    stateElement.textContent = state === 'ok' ? '正常' : state === 'error' ? '读取失败' : '未知';
    stateElement.dataset.state = state;
    const chunkCount = Number(status.chunkCount) || 0;
    const summaryEntryCount = Number(status.summaryEntryCount) || 0;
    const lastSummaryAt = String(status.lastSummaryAt ?? '').trim();
    const summaryPendingFloors = Math.max(0, Number(status.summaryPendingFloors) || 0);
    const summaryBatchSize = Math.max(1, Number(status.summaryBatchSize) || 15);
    const summaryPhase = String(status.summaryPhase ?? 'idle');
    const summaryError = String(status.summaryError ?? '').trim();
    const chatSize = String(status.chatSize ?? '').trim();
    document.querySelector('#memory_augment_status_chunks').textContent = chunkCount > 0
        ? String(chunkCount)
        : '暂无（发送消息后自动生成）';
    document.querySelector('#memory_augment_status_summary').textContent = lastSummaryAt && lastSummaryAt !== '—'
        ? lastSummaryAt
        : '暂无摘要';
    document.querySelector('#memory_augment_status_summary_entries').textContent = summaryEntryCount > 0
        ? String(summaryEntryCount)
        : '暂无摘要';
    const summaryProgressElement = document.querySelector('#memory_augment_status_summary_progress');
    if (summaryProgressElement) {
        if (summaryPhase === 'error') {
            summaryProgressElement.textContent = summaryError ? `失败：${summaryError}` : '生成失败';
            summaryProgressElement.dataset.state = 'error';
        } else if (summaryPhase === 'summarizing' || summaryPhase === 'repairing') {
            summaryProgressElement.textContent = `生成中（待处理 ${summaryPendingFloors} 楼）`;
            summaryProgressElement.dataset.state = 'working';
        } else if (summaryPendingFloors >= summaryBatchSize) {
            summaryProgressElement.textContent = `待补 ${summaryPendingFloors} 楼（每批 ${summaryBatchSize} 楼）`;
            summaryProgressElement.dataset.state = 'pending';
        } else if (summaryPendingFloors > 0) {
            summaryProgressElement.textContent = `已积累 ${summaryPendingFloors}/${summaryBatchSize} 楼`;
            summaryProgressElement.dataset.state = 'idle';
        } else {
            summaryProgressElement.textContent = '已跟上当前聊天';
            summaryProgressElement.dataset.state = 'ok';
        }
    }
    document.querySelector('#memory_augment_status_size').textContent = !chatSize || /^0(?:\.0+)?\s*(?:B|Bytes?)$/i.test(chatSize)
        ? '空'
        : chatSize;
}

async function openQuickPanel() {
    if (quickPanelPromise) {
        return quickPanelPromise;
    }

    const panel = document.querySelector('#memory_augment_settings');
    if (!panel) {
        return null;
    }

    const originalParent = panel.parentNode;
    const originalNextSibling = panel.nextSibling;
    panel.classList.add('is-quick-panel');

    const popup = new Popup(panel, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        allowVerticalScrolling: true,
        onOpen: () => {
            void refreshStatus();
            document.dispatchEvent(new CustomEvent('memory-augment:panel-open'));
        },
        onClose: () => {
            panel.classList.remove('is-quick-panel');
            if (originalNextSibling?.parentNode === originalParent) {
                originalParent.insertBefore(panel, originalNextSibling);
            } else {
                originalParent?.append(panel);
            }
        },
    });
    popup.dlg.classList.add('memory-augment-popup');
    quickPanelPromise = popup.show().finally(() => {
        quickPanelPromise = null;
    });
    return quickPanelPromise;
}

function addTopNavigationButton() {
    const holder = document.querySelector('#top-settings-holder');
    if (!holder || document.querySelector('#memory_augment_top_button')) {
        return;
    }

    const entry = document.createElement('div');
    entry.className = 'drawer memory-augment-top-entry';
    entry.innerHTML = `
        <div class="drawer-toggle drawer-header">
            <div id="memory_augment_top_button" class="drawer-icon fa-solid fa-toolbox fa-fw closedIcon"
                role="button" tabindex="0" title="打开 KKToolbox 设置与状态" aria-label="打开 KKToolbox 设置与状态"></div>
        </div>`;
    const button = entry.querySelector('#memory_augment_top_button');
    if (!button) {
        return;
    }
    button.addEventListener('click', () => void openQuickPanel());
    button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void openQuickPanel();
        }
    });
    const personaButton = holder.querySelector('#persona-management-button');
    if (personaButton) {
        holder.insertBefore(entry, personaButton);
    } else {
        holder.append(entry);
    }
}

async function refreshStatus() {
    const button = document.querySelector('#memory_augment_refresh_status');
    button?.classList.add('disabled');

    const context = SillyTavern.getContext();
    const summaryStatus = await getSummaryStatus(context, extension_settings[EXTENSION_KEY]).catch(error => {
        console.warn('[Memory Augment] Failed to read summary lorebook status.', error);
        return { entryCount: 0, lastSummaryAt: null };
    });

    try {
        const status = await getStatus(context.getCurrentChatId?.() ?? context.chatId);
        renderStatus({
            ...status,
            summaryEntryCount: summaryStatus.entryCount,
            summaryPendingFloors: summaryStatus.pendingFloors,
            summaryBatchSize: summaryStatus.batchSize,
            summaryPhase: summaryStatus.phase,
            summaryError: summaryStatus.error,
            lastSummaryAt: summaryStatus.lastSummaryAt
                ? new Date(summaryStatus.lastSummaryAt).toLocaleString()
                : null,
        });
    } catch (error) {
        renderStatus({
            status: 'error',
            summaryEntryCount: summaryStatus.entryCount,
            summaryPendingFloors: summaryStatus.pendingFloors,
            summaryBatchSize: summaryStatus.batchSize,
            summaryPhase: summaryStatus.phase,
            summaryError: summaryStatus.error,
            lastSummaryAt: summaryStatus.lastSummaryAt
                ? new Date(summaryStatus.lastSummaryAt).toLocaleString()
                : null,
        });
        console.warn('[Memory Augment] Local memory status request failed.', error);
    } finally {
        button?.classList.remove('disabled');
    }
}

function getEmbeddingConfig(settings) {
    return {
        baseUrl: normalizeBaseUrl(settings.apis.embedding.url),
        apiKey: String(settings.apis.embedding.apiKey ?? '').trim(),
        model: String(settings.apis.embedding.model ?? '').trim(),
    };
}

function hasCompleteEmbeddingConfig(config) {
    return Boolean(config.baseUrl && config.apiKey && config.model);
}

function normalizeTimestamp(value) {
    const milliseconds = Date.parse(value);
    return Number.isNaN(milliseconds) ? 0 : Math.floor(milliseconds / 1000);
}

function serializeChatMessage(message, id, context) {
    return {
        id,
        name: message?.name ?? '',
        role: message?.is_user ? 'user' : 'assistant',
        text: message?.mes ?? '',
        timestamp: normalizeTimestamp(message?.send_date),
        timeline: getMessageTimelineMetadata(context, id),
    };
}

function createChatSnapshot(settings) {
    const context = SillyTavern.getContext();
    const chatId = context.getCurrentChatId?.() ?? context.chatId;
    const embedding = getEmbeddingConfig(settings);

    if (!chatId || !Array.isArray(context.chat)) {
        return null;
    }

    return {
        chatId,
        messages: context.chat.map((message, id) => serializeChatMessage(message, id, context)),
        embedding: hasCompleteEmbeddingConfig(embedding) ? embedding : null,
        targetChars: settings.rag.segmentTargetChars,
    };
}

function createIngestPayload(settings, messageIds) {
    const snapshot = createChatSnapshot(settings);
    if (!snapshot?.embedding || !Array.isArray(messageIds)) {
        return null;
    }

    const messages = messageIds
        .map(Number)
        .filter(id => Number.isInteger(id) && id >= 0 && id < snapshot.messages.length)
        .map(id => snapshot.messages[id])
        .filter(message => String(message.text).trim());
    if (messages.length === 0) return null;

    return {
        type: 'chat',
        chatId: snapshot.chatId,
        targetChars: snapshot.targetChars,
        embedding: snapshot.embedding,
        messages,
    };
}

function queueIngestion(settings, { messageIds = null } = {}) {
    const payload = createIngestPayload(settings, messageIds);
    if (!payload) {
        return Promise.resolve(null);
    }

    const task = ingestionQueue
        .catch(() => undefined)
        .then(() => ingestChat(payload))
        .then(async (result) => {
            await refreshStatus();
            return result;
        });

    ingestionQueue = task;
    return task;
}

function queueChatReconciliation(settings, messageIds = []) {
    const snapshot = createChatSnapshot(settings);
    if (!snapshot) return Promise.resolve(null);
    const readyIds = [...new Set((Array.isArray(messageIds) ? messageIds : [])
        .map(Number)
        .filter(id => Number.isInteger(id) && id >= 0 && id < snapshot.messages.length))];
    const messages = readyIds
        .map(id => snapshot.messages[id])
        .filter(message => String(message.text).trim());

    const task = ingestionQueue
        .catch(() => undefined)
        .then(async () => {
            const cleanup = await reconcileChatVectors({
                chatId: snapshot.chatId,
                messageIds: messages.map(message => message.id),
                embedding: snapshot.embedding,
            });
            if (!snapshot.embedding || messages.length === 0) {
                return { accepted: 0, chunks: 0, embedded: 0, reused: 0, cleanup, didIngest: false };
            }
            const result = await ingestChat({
                type: 'chat',
                chatId: snapshot.chatId,
                targetChars: snapshot.targetChars,
                embedding: snapshot.embedding,
                messages,
            });
            return { ...result, cleanup, didIngest: true };
        })
        .then(async (result) => {
            await refreshStatus();
            return result;
        });

    ingestionQueue = task;
    return task;
}

function queueChatRebuild(settings, { notify = false } = {}) {
    const snapshot = createChatSnapshot(settings);
    if (!snapshot) return Promise.resolve(null);
    const context = SillyTavern.getContext();
    const { ready } = reconcileBufferedMessageQueue(context.chatMetadata, context.chat);
    const messages = ready
        .map(id => snapshot.messages[id])
        .filter(message => String(message?.text ?? '').trim());
    if (messages.length > 0 && !snapshot.embedding) {
        if (notify) showNotice('请先填写完整的 Embedding Base URL、API Key 和模型名。', 'warning');
        return Promise.resolve(null);
    }

    const task = ingestionQueue
        .catch(() => undefined)
        .then(async () => {
            if (messages.length === 0) {
                const cleanup = await reconcileChatVectors({
                    chatId: snapshot.chatId,
                    messageIds: [],
                    embedding: snapshot.embedding,
                });
                return {
                    accepted: 0,
                    chunks: 0,
                    embedded: 0,
                    reused: 0,
                    preservedManual: cleanup.preservedManualChunks ?? 0,
                    cleanup,
                };
            }
            const result = await ingestChat({
                type: 'chat',
                chatId: snapshot.chatId,
                targetChars: snapshot.targetChars,
                embedding: snapshot.embedding,
                force: true,
                reconcile: true,
                messages,
            });
            return result;
        })
        .then(async (result) => {
            await refreshStatus();
            if (notify) {
                showNotice(`向量已重建：${result.chunks} 个片段，重新生成 ${result.embedded} 个向量。`, 'success');
            }
            return result;
        });

    ingestionQueue = task;
    return task;
}

function bindMessageIngestion(settings, context) {
    const bound = bindChatIngestionLifecycle(context, {
        getContext: () => SillyTavern.getContext(),
        ingestMessages: (messageIds) => {
            return queueIngestion(settings, { messageIds }).catch((error) => {
                console.error('[Memory Augment] Automatic message ingestion failed.', error);
                throw error;
            });
        },
        reconcileChat: (messageIds) => {
            return queueChatReconciliation(settings, messageIds).catch((error) => {
                console.error('[Memory Augment] Chat vector reconciliation failed.', error);
                throw error;
            });
        },
    });
    if (!bound) {
        console.error('[Memory Augment] Chat lifecycle events are unavailable; automatic chat ingestion is disabled.');
    }
}

function bindPhoneMemoryLifecycle(context) {
    const eventTypes = {
        ...(context.event_types ?? {}),
        ...(context.eventTypes ?? {}),
    };
    const messageRendered = eventTypes.CHARACTER_MESSAGE_RENDERED;
    if (!messageRendered) {
        console.warn('[Memory Augment] CHARACTER_MESSAGE_RENDERED is unavailable; pending phone facts will remain pending.');
    } else {
        context.eventSource.on(messageRendered, async (messageId) => {
            const current = SillyTavern.getContext();
            const message = current.chat?.[Number(messageId)];
            if (!message || message.is_user || message.is_system) return;
            const chatId = getPhoneChatId(current);
            try {
                await consumePreparedPhoneContext({ getCurrentChatId: () => chatId });
            } catch (error) {
                console.warn('[Memory Augment] Phone-to-story memory consumption failed.', error);
            }
        });
    }

    const clearCurrentPreparedContext = () => {
        clearPreparedPhoneContext(getPhoneChatId(SillyTavern.getContext()));
    };
    if (eventTypes.GENERATION_STOPPED) {
        context.eventSource.on(eventTypes.GENERATION_STOPPED, clearCurrentPreparedContext);
    }
    if (eventTypes.GENERATION_ENDED) {
        context.eventSource.on(eventTypes.GENERATION_ENDED, clearCurrentPreparedContext);
    }

    let previousChatId = getPhoneChatId(context);
    if (eventTypes.CHAT_CHANGED) {
        context.eventSource.on(eventTypes.CHAT_CHANGED, (nextChatId) => {
            clearPreparedPhoneContext(previousChatId);
            previousChatId = String(nextChatId ?? getPhoneChatId(SillyTavern.getContext()) ?? '').trim();
        });
    }
}

function bindActions(settings) {
    document.querySelector('#memory_augment_refresh_status')?.addEventListener('click', refreshStatus);
    document.querySelector('#memory_augment_rebuild_chat')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.classList.add('disabled');
        try {
            await queueChatRebuild(settings, { notify: true });
        } catch (error) {
            showNotice(`聊天向量重建失败：${error.message}`, 'error');
            console.error('[Memory Augment] Chat vector rebuild failed.', error);
        } finally {
            button.classList.remove('disabled');
        }
    });
    document.querySelector('#memory_augment_rebuild_all_vectors')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.classList.add('disabled');
        try {
            const chatResult = await queueChatRebuild(settings);
            const worldResult = await rebuildAllCurrentWorldInfo(settings, SillyTavern.getContext());
            document.querySelector('#memory_augment_refresh_worldinfo')?.click();
            showNotice(`全部向量已重建：聊天 ${chatResult?.chunks ?? 0} 个片段，世界书 ${worldResult.chunks} 个片段。`, 'success');
        } catch (error) {
            showNotice(`重建所有向量失败：${error.message}`, 'error');
            console.error('[Memory Augment] Full vector rebuild failed.', error);
        } finally {
            button.classList.remove('disabled');
        }
    });
    document.querySelector('#memory_augment_clear_summaries')?.addEventListener('click', async (event) => {
        const confirmed = await Popup.show.confirm(
            '清除所有 KKToolbox 摘要？',
            '只会删除当前聊天关联世界书中带 [KKT摘要] 前缀的条目，聊天记录不会受影响。',
        );
        if (!confirmed) {
            return;
        }
        const button = event.currentTarget;
        button.classList.add('disabled');
        try {
            const removed = await clearAllSummaries(SillyTavern.getContext());
            showNotice(`已清除 ${removed} 个摘要条目。`, 'success');
            await refreshStatus();
        } catch (error) {
            showNotice(`清除摘要失败：${error.message}`, 'error');
            console.error('[Memory Augment] Failed to clear summary lorebook entries.', error);
        } finally {
            button.classList.remove('disabled');
        }
    });
    document.querySelector('#memory_augment_repair_summaries')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.classList.add('disabled');
        button.disabled = true;
        try {
            const context = SillyTavern.getContext();
            const repaired = await repairMalformedSummaries(settings, context, {
                getCurrentContext: () => SillyTavern.getContext(),
                onSaved: refreshStatus,
            });
            showNotice(repaired > 0 ? `已修复 ${repaired} 条异常摘要。` : '没有发现需要修复的摘要。', repaired > 0 ? 'success' : 'info');
        } catch (error) {
            showNotice(`修复摘要失败：${error.message}`, 'error');
            console.error('[Memory Augment] Failed to repair malformed summaries.', error);
        } finally {
            button.classList.remove('disabled');
            button.disabled = false;
        }
    });
}

async function initialize() {
    const context = SillyTavern.getContext();
    const savedSettings = extension_settings[EXTENSION_KEY] ?? {};
    const hadLegacySummaryMaxTokens = Object.hasOwn(
        extension_settings[EXTENSION_KEY]?.context ?? {},
        'summaryMaxTokens',
    );
    const hadLegacyChunkSize = Object.hasOwn(
        extension_settings[EXTENSION_KEY]?.rag ?? {},
        'chunkSize',
    );
    const hadLegacySummaryInterval = Object.hasOwn(
        extension_settings[EXTENSION_KEY]?.context ?? {},
        'summaryInterval',
    );
    const hadStatusEnabled = Object.hasOwn(savedSettings?.status ?? {}, 'enabled');
    const hadLegacyAiCustomFields = Object.hasOwn(savedSettings?.status ?? {}, 'allowCustomFields');
    const hadLegacyDefaultBarragePrompt = String(savedSettings?.barrage?.systemPrompt ?? '').trim()
        === LEGACY_DEFAULT_BARRAGE_PROMPT;
    const settings = mergeSettings(defaultSettings, extension_settings[EXTENSION_KEY]);
    delete settings.context.summaryMaxTokens;
    delete settings.context.summaryInterval;
    delete settings.rag.chunkSize;
    delete settings.status.allowCustomFields;
    if (hadLegacyDefaultBarragePrompt) settings.barrage.systemPrompt = '';
    if (!hadStatusEnabled) settings.status.enabled = Boolean(savedSettings?.barrage?.enabled);
    extension_settings[EXTENSION_KEY] = settings;
    if (hadLegacySummaryMaxTokens || hadLegacySummaryInterval || hadLegacyChunkSize
        || hadLegacyAiCustomFields || hadLegacyDefaultBarragePrompt || !hadStatusEnabled) {
        context.saveSettingsDebounced();
    }

    if (!document.querySelector('#memory_augment_settings')) {
        const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
        document.querySelector('#extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    }
    await refreshDisplayedVersion();

    bindSettings(settings, context);
    initializeHtmlRenderer(settings);
    bindStatusCustomFields(settings, context);
    bindModelDiscovery(settings, context);
    bindActions(settings);
    addTopNavigationButton();
    bindMessageIngestion(settings, context);
    bindPhoneMemoryLifecycle(context);
    initializeChatMemoryUi(settings, context);
    initializeSummaryManager(settings, context, { onSaved: refreshStatus, onStatus: refreshStatus });
    // Create the always-available status/map launcher before optional async managers run.
    initializeStoryStatusUi(context, settings);
    initializePhoneShellUi(settings, context);
    initializeCharacterDevelopmentUi(context);
    initializeDevelopmentBaselineUi(settings, context, {
        chooseSource: async (info) => {
            const recommendation = info.recommended === 'worldbook' ? '世界／群像卡' : '单人角色卡';
            const worldbookText = info.linkedBookCount > 0
                ? `已找到 ${info.linkedBookCount} 本角色关联世界书：${info.linkedBookNames.join('、')}。`
                : '当前没有找到角色关联世界书；世界书中的人物基准会保持“未知”，不会靠身份猜性格。';
            const content = document.createElement('div');
            content.className = 'memory-augment-development-source-prompt';
            const title = document.createElement('h3');
            title.textContent = '先确认当前角色卡类型';
            const explanation = document.createElement('p');
            explanation.textContent = '单人卡的主角色以酒馆角色设定为准，人物关系与重要 NPC 由关联世界书补充；世界／群像卡的所有重要人物都查关联世界书。这个选择只影响人物发展档案。';
            const books = document.createElement('p');
            books.textContent = worldbookText;
            const suggestion = document.createElement('p');
            const strong = document.createElement('strong');
            strong.textContent = `建议：${recommendation}`;
            suggestion.append(strong, '。选择会按当前角色卡保存，以后可在悬浮窗的人物发展页修改。');
            content.append(title, explanation, books, suggestion);
            const sourcePopup = new Popup(content, POPUP_TYPE.TEXT, '', {
                okButton: '单人角色卡',
                cancelButton: '暂不选择',
                customButtons: [{
                    text: '世界／群像卡',
                    result: POPUP_RESULT.CUSTOM1,
                    classes: info.recommended === 'worldbook' ? ['menu_button_default'] : [],
                }],
                defaultResult: info.recommended === 'worldbook' ? POPUP_RESULT.CUSTOM1 : POPUP_RESULT.AFFIRMATIVE,
            });
            sourcePopup.dlg.classList.add('memory-augment-popup', 'memory-augment-development-source-popup');
            const result = await sourcePopup.show();
            if (result === POPUP_RESULT.AFFIRMATIVE) return 'character';
            if (result === POPUP_RESULT.CUSTOM1) return 'worldbook';
            return '';
        },
    });
    await initializeWorldInfoManager(settings, context);
    await initializeBarrageUi(settings, { templatePath: TEMPLATE_PATH });
    initializeSwipeCleanup(context);
    initializeMapAtlasUi(settings, context, {
        confirm: (title, message) => Popup.show.confirm(title, message),
    });
    document.addEventListener('memory-augment-edit-story-time', async (event) => {
        const current = SillyTavern.getContext();
        const oldValue = String(event.detail?.value ?? '').trim();
        const nextValue = await Popup.show.input(
            '修正剧情时间',
            '这里修改的是当前聊天的时间锚点，人工修正优先于自动判断。',
            oldValue,
        );
        if (typeof nextValue !== 'string' || !nextValue.trim()) return;
        if (!correctLatestStoryTime(current, nextValue)) {
            showNotice('当前聊天还没有可修正的剧情时间。', 'warning');
            return;
        }
        await current.saveMetadata?.();
        refreshStoryStatusUi(current);
        showNotice('当前剧情时间已修正。', 'success');
    });
    document.addEventListener('memory-augment-development-edit', async (event) => {
        const current = SillyTavern.getContext();
        const { character, field } = event.detail ?? {};
        const value = await Popup.show.input(
            `修改 ${character ?? ''} 的人物发展`,
            '人工修改优先于自动观察；玩家之后明确给出的新设定仍可覆盖它。',
            String(field?.value ?? ''),
        );
        if (typeof value !== 'string' || !value.trim()) return;
        setManualDevelopmentField(current, {
            character,
            dimension: field?.dimension,
            target: field?.target,
            before: field?.value,
            value,
        });
        await current.saveMetadata?.();
        refreshCharacterDevelopmentUi(current);
    });
    document.addEventListener('memory-augment-development-delete', async (event) => {
        const current = SillyTavern.getContext();
        const { character, field } = event.detail ?? {};
        if (!await Popup.show.confirm('删除人物变化', `确定删除“${character} · ${field?.value ?? ''}”吗？`)) return;
        deleteDevelopmentField(current, character, field?.key);
        await current.saveMetadata?.();
        refreshCharacterDevelopmentUi(current);
    });
    document.addEventListener('memory-augment-development-promote', async (event) => {
        const current = SillyTavern.getContext();
        if (!promoteDevelopmentCandidate(current, event.detail?.candidateId)) return;
        await current.saveMetadata?.();
        refreshCharacterDevelopmentUi(current);
        showNotice('这项人物变化已由你确认并立即采用。', 'success');
    });
    document.addEventListener('memory-augment-development-discard', async (event) => {
        const current = SillyTavern.getContext();
        if (!await Popup.show.confirm('忽略候选变化', '确定删除这项尚未采用的观察吗？')) return;
        if (!discardDevelopmentCandidate(current, event.detail?.candidateId)) return;
        await current.saveMetadata?.();
        refreshCharacterDevelopmentUi(current);
    });
    await refreshStatus();
}

jQuery(initialize);
