import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';
import { normalizeBaseUrl } from './api-utils.js';
import { memoryAugmentInterceptor } from './context-manager.js';
import { fetchModels, getStatus, ingestChat } from './rag-client.js';
import { initializeBarrageUi } from './barrage-ui.js';
import { clearAllSummaries, getSummaryStatus, initializeSummaryManager } from './summary-manager.js';
import { initializeWorldInfoManager } from './world-info-manager.js';

const EXTENSION_KEY = 'st-memory-augment';
const EXTENSION_FOLDER = decodeURIComponent(new URL('.', import.meta.url).pathname)
    .split('/')
    .filter(Boolean)
    .at(-1);
const TEMPLATE_PATH = `third-party/${EXTENSION_FOLDER}`;
const API_TYPES = ['embedding', 'reranker', 'barrage'];
let ingestionQueue = Promise.resolve();
let quickPanelPromise = null;

export const defaultSettings = Object.freeze({
    apis: {
        embedding: { url: '', apiKey: '', model: '', availableModels: [], modelsBaseUrl: '' },
        reranker: { url: '', apiKey: '', model: '', availableModels: [], modelsBaseUrl: '' },
        barrage: { url: '', apiKey: '', model: '', availableModels: [], modelsBaseUrl: '' },
    },
    context: {
        recentMessages: 5,
        summaryInterval: 5,
        summaryMaxTokens: 500,
    },
    rag: {
        chunkSize: 3,
        topK: 20,
        topN: 5,
        rerankerThreshold: 0.3,
        semanticWorldInfo: false,
        semanticWorldInfoEntries: [],
    },
    barrage: {
        enabled: false,
        recentMessages: 5,
        includeRag: true,
        systemPrompt: '你是一群正在观看小说直播的观众，请以弹幕/评论区风格吐槽点评',
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
        });
    });
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
    stateElement.textContent = state;
    stateElement.dataset.state = state;
    document.querySelector('#memory_augment_status_chunks').textContent = status.chunkCount ?? 0;
    document.querySelector('#memory_augment_status_summary').textContent = status.lastSummaryAt ?? '—';
    document.querySelector('#memory_augment_status_summary_entries').textContent = status.summaryEntryCount ?? 0;
    document.querySelector('#memory_augment_status_size').textContent = status.totalSize ?? '0 B';
    document.querySelector('#memory_augment_status_phase').textContent = status.phase ? `Phase ${status.phase}` : '—';
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
        large: true,
        allowVerticalScrolling: true,
        onOpen: () => void refreshStatus(),
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
            <div id="memory_augment_top_button" class="drawer-icon fa-solid fa-brain fa-fw closedIcon"
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
    holder.append(entry);
}

async function refreshStatus() {
    const button = document.querySelector('#memory_augment_refresh_status');
    button?.classList.add('disabled');

    const context = SillyTavern.getContext();
    const summaryStatus = await getSummaryStatus(context).catch(error => {
        console.warn('[Memory Augment] Failed to read summary lorebook status.', error);
        return { entryCount: 0, lastSummaryAt: null };
    });

    try {
        const status = await getStatus(context.getCurrentChatId?.() ?? context.chatId);
        renderStatus({
            ...status,
            summaryEntryCount: summaryStatus.entryCount,
            lastSummaryAt: summaryStatus.lastSummaryAt
                ? new Date(summaryStatus.lastSummaryAt).toLocaleString()
                : null,
        });
    } catch (error) {
        renderStatus({
            status: 'offline',
            summaryEntryCount: summaryStatus.entryCount,
            lastSummaryAt: summaryStatus.lastSummaryAt
                ? new Date(summaryStatus.lastSummaryAt).toLocaleString()
                : null,
        });
        console.warn('[Memory Augment] Server plugin status request failed.', error);
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

function createIngestPayload(settings, force = false) {
    const context = SillyTavern.getContext();
    const chatId = context.getCurrentChatId?.() ?? context.chatId;
    const embedding = getEmbeddingConfig(settings);

    if (!chatId || !hasCompleteEmbeddingConfig(embedding) || !Array.isArray(context.chat)) {
        return null;
    }

    return {
        chatId,
        chunkSize: settings.rag.chunkSize,
        embedding,
        force,
        messages: context.chat.map((message, id) => ({
            id,
            name: message.name ?? '',
            role: message.is_user ? 'user' : 'assistant',
            text: message.mes ?? '',
            timestamp: normalizeTimestamp(message.send_date),
        })),
    };
}

function queueIngestion(settings, { force = false, notify = false } = {}) {
    const payload = createIngestPayload(settings, force);
    if (!payload) {
        if (notify) {
            showNotice('请先填写完整的 Embedding Base URL、API Key 和模型名。', 'warning');
        }
        return Promise.resolve(null);
    }

    const task = ingestionQueue
        .catch(() => undefined)
        .then(() => ingestChat(payload))
        .then(async (result) => {
            await refreshStatus();
            if (notify) {
                showNotice(`向量已重建：${result.chunks} 个分块，重新生成 ${result.embedded} 个向量。`, 'success');
            }
            return result;
        });

    ingestionQueue = task;
    return task;
}

function bindMessageIngestion(settings, context) {
    const messageReceived = context.eventTypes?.MESSAGE_RECEIVED ?? context.event_types?.MESSAGE_RECEIVED;
    if (!messageReceived) {
        console.error('[Memory Augment] MESSAGE_RECEIVED event is unavailable.');
        return;
    }

    context.eventSource.on(messageReceived, () => {
        queueIngestion(settings).catch((error) => {
            console.error('[Memory Augment] Automatic message ingestion failed.', error);
        });
    });
}

function bindActions(settings) {
    document.querySelector('#memory_augment_refresh_status')?.addEventListener('click', refreshStatus);
    document.querySelector('#memory_augment_rebuild_chat')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.classList.add('disabled');
        try {
            await queueIngestion(settings, { force: true, notify: true });
        } catch (error) {
            showNotice(`聊天向量重建失败：${error.message}`, 'error');
            console.error('[Memory Augment] Chat vector rebuild failed.', error);
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
}

async function initialize() {
    const context = SillyTavern.getContext();
    const settings = mergeSettings(defaultSettings, extension_settings[EXTENSION_KEY]);
    extension_settings[EXTENSION_KEY] = settings;

    if (!document.querySelector('#memory_augment_settings')) {
        const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
        document.querySelector('#extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    }

    bindSettings(settings, context);
    bindModelDiscovery(settings, context);
    bindActions(settings);
    addTopNavigationButton();
    bindMessageIngestion(settings, context);
    initializeSummaryManager(settings, context, { onSaved: refreshStatus });
    await initializeWorldInfoManager(settings, context);
    await initializeBarrageUi(settings, { templatePath: TEMPLATE_PATH });
    await refreshStatus();
}

jQuery(initialize);
