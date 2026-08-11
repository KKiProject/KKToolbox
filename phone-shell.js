import { createPhoneMessagesController } from './phone-messages.js';
import { createPhoneWeiboController } from './phone-weibo.js';
import { createPhoneCommunityController } from './phone-community.js';
import { createPhoneLiveController } from './phone-live.js';
import { createPhoneSettingsController, syncPhoneAccountProfiles } from './phone-settings.js';
import { createPhoneSession } from './phone-session.js';
import { appendPhoneActivityEvent, getPhoneChatId } from './phone-store.js';
import { cleanPhoneText as text } from './phone-utils.js';
import { preparePhoneStoryContext } from './phone-context.js';
import { getLatestStoryStatus } from './story-status.js';
import {
    isPhoneWeiboAiReady,
    requestPhoneWeiboBootstrap,
    requestPhoneWeiboOperation,
} from './phone-weibo-ai.js';
import { isPhoneLiveAiReady, requestPhoneLiveOperation } from './phone-live-ai.js';
import {
    isPhoneWorldStoryUpdateInFlight,
    requestPhoneWorldStoryUpdate,
} from './phone-world-ai.js';

export const PHONE_APP_SHELLS = Object.freeze([
    { id: 'messages', label: '消息', icon: 'fa-comments', tone: 'green' },
    { id: 'weibo', label: '微博', icon: 'fa-fire', tone: 'rose' },
    { id: 'community', label: '社区', icon: 'fa-people-group', tone: 'blue' },
    { id: 'live', label: '直播', icon: 'fa-video', tone: 'pink' },
    { id: 'settings', label: '设置', icon: 'fa-gear', tone: 'sand' },
]);

let phoneShellBound = false;
let appControllers = {};
let activeApp = '';

const PHONE_WORLD_MODULE_NOTICES = Object.freeze({
    messages: '有新的消息',
    weibo: '微博有新内容',
    community: '社区有新内容',
    live: '直播有新内容',
});

export function parsePhoneClockMinutes(value) {
    const source = text(value, 300);
    if (!source) return null;
    const matches = [...source.matchAll(/(?:^|\D)([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)(?!\d)/gu)];
    const match = matches.at(-1)
        ?? source.match(/(?:^|\D)([01]?\d|2[0-3])\s*时\s*([0-5]?\d)\s*分/gu)?.at(-1)?.match(/([01]?\d|2[0-3])\s*时\s*([0-5]?\d)/u);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

export function formatPhoneClockMinutes(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return '';
    const normalized = ((Math.floor(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

export function getPhoneWorldStatusPresentation(worldGeneration = {}) {
    const status = String(worldGeneration?.status ?? 'idle');
    if (status === 'generating') {
        return { state: 'generating', icon: 'fa-spinner', text: '手机内容更新中…' };
    }
    if (worldGeneration?.dismissed === true) {
        return { state: 'idle', icon: '', text: '' };
    }
    if (status === 'error') {
        const detail = text(worldGeneration?.lastError, 240);
        return {
            state: 'error',
            icon: 'fa-circle-exclamation',
            text: detail ? `手机更新失败：${detail}` : '手机内容更新失败',
        };
    }
    const notices = [...new Set((Array.isArray(worldGeneration?.modules) ? worldGeneration.modules : [])
        .map(module => PHONE_WORLD_MODULE_NOTICES[module]).filter(Boolean))];
    if (notices.length > 0) {
        return { state: status === 'partial' ? 'partial' : 'ready', icon: 'fa-bell', text: notices.join(' · ') };
    }
    return { state: 'idle', icon: '', text: '' };
}

export function findLatestPhoneStoryMessageId(context = {}) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message?.is_user && text(message?.mes ?? message?.content, 30_000)) return index;
    }
    return null;
}

function renderAppButtons() {
    return PHONE_APP_SHELLS.map(app => `
        <button type="button" class="memory-augment-phone-app" data-phone-app="${app.id}" data-phone-label="${app.label}">
            <span class="memory-augment-phone-app-icon is-${app.tone}"><i class="fa-solid ${app.icon}" aria-hidden="true"></i></span>
            <span>${app.label}</span>
        </button>`).join('');
}

function setPhoneScreen(root, screen, title = '') {
    const home = root.querySelector('[data-phone-screen="home"]');
    const app = root.querySelector('[data-phone-screen="app"]');
    if (!home || !app) return;
    const showApp = screen === 'app';
    home.hidden = showApp;
    app.hidden = !showApp;
    const heading = app.querySelector('[data-phone-app-title]');
    if (heading) heading.textContent = title || '应用';
}

function renderPlaceholder(content) {
    content.classList.remove('is-messages', 'is-weibo', 'is-community', 'is-live', 'is-phone-settings');
    content.innerHTML = `
        <div class="memory-augment-phone-placeholder-heading"></div>
        <div class="memory-augment-phone-placeholder-card"></div>
        <div class="memory-augment-phone-placeholder-card is-short"></div>`;
}

export function initializePhoneShellUi(
    settings = {},
    context = globalThis.SillyTavern?.getContext?.(),
    documentRef = globalThis.document,
    runtime = {},
) {
    if (!documentRef?.querySelector) return false;
    const root = documentRef.querySelector('#memory_augment_story_phone_view');
    if (!root) return false;
    if (!root.querySelector('.memory-augment-phone-device')) {
        root.innerHTML = `
            <div class="memory-augment-phone-stage">
                <section class="memory-augment-phone-device" aria-label="KK PHONE">
                    <div class="memory-augment-phone-speaker" aria-hidden="true"></div>
                    <div class="memory-augment-phone-screen">
                        <header class="memory-augment-phone-statusbar" aria-label="手机状态栏">
                            <span class="memory-augment-phone-clock">09:41</span>
                            <span class="memory-augment-phone-island" aria-hidden="true"></span>
                            <span class="memory-augment-phone-signals" aria-hidden="true">
                                <i class="fa-solid fa-signal"></i>
                                <i class="fa-solid fa-wifi"></i>
                                <span class="memory-augment-phone-battery"><span></span></span>
                            </span>
                        </header>
                        <main class="memory-augment-phone-home" data-phone-screen="home">
                            <section class="memory-augment-phone-widget">
                                <span>KK PHONE</span>
                                <strong class="memory-augment-phone-world-status" data-phone-world-status data-state="idle"></strong>
                                <button type="button" class="memory-augment-phone-world-regenerate" data-phone-world-regenerate title="接收最新手机内容">
                                    <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>
                                    <span>接收消息</span>
                                </button>
                            </section>
                            <div class="memory-augment-phone-app-grid">
                                ${renderAppButtons()}
                            </div>
                            <div class="memory-augment-phone-dock" aria-label="常用应用">
                                <span class="memory-augment-phone-dock-icon"><i class="fa-solid fa-phone"></i></span>
                                <span class="memory-augment-phone-dock-icon"><i class="fa-solid fa-compass"></i></span>
                                <span class="memory-augment-phone-dock-icon"><i class="fa-solid fa-camera"></i></span>
                            </div>
                        </main>
                        <main class="memory-augment-phone-app-page" data-phone-screen="app" hidden>
                            <header class="memory-augment-phone-app-header">
                                <button type="button" data-phone-back aria-label="返回手机桌面"><i class="fa-solid fa-chevron-left"></i></button>
                                <strong data-phone-app-title>应用</strong>
                                <span aria-hidden="true"></span>
                            </header>
                            <div class="memory-augment-phone-app-content">
                                <div class="memory-augment-phone-placeholder-heading"></div>
                                <div class="memory-augment-phone-placeholder-card"></div>
                                <div class="memory-augment-phone-placeholder-card is-short"></div>
                            </div>
                        </main>
                        <button type="button" class="memory-augment-phone-home-indicator" data-phone-home aria-label="返回手机桌面"></button>
                    </div>
                </section>
            </div>`;
    }
    if (phoneShellBound) return true;

    const getCurrentContext = () => {
        const current = globalThis.SillyTavern?.getContext?.() ?? context ?? {};
        const powerUser = runtime.powerUser ?? context?.powerUser ?? context?.power_user;
        return powerUser ? { ...current, powerUser } : current;
    };
    let clockAnchorKey = '';
    let clockAnchorMinutes = null;
    let clockAnchorStartedAt = 0;
    const renderPhoneClock = () => {
        const target = root.querySelector('.memory-augment-phone-clock');
        if (!target) return;
        const current = getCurrentContext();
        const chatId = getPhoneChatId(current);
        const latest = getLatestStoryStatus(current);
        const storyTime = text(latest?.status?.environment?.time, 300);
        const storyMinutes = parsePhoneClockMinutes(storyTime);
        const now = Date.now();
        if (storyMinutes !== null) {
            const nextAnchorKey = `${chatId}:${latest?.messageId ?? ''}:${latest?.timestamp ?? ''}:${storyTime}`;
            if (clockAnchorKey !== nextAnchorKey) {
                clockAnchorKey = nextAnchorKey;
                clockAnchorMinutes = storyMinutes;
                clockAnchorStartedAt = now;
            }
            const elapsedMinutes = Math.max(0, Math.floor((now - clockAnchorStartedAt) / 60_000));
            target.textContent = formatPhoneClockMinutes(clockAnchorMinutes + elapsedMinutes);
            target.title = storyTime;
            target.dataset.source = 'story';
            return;
        }
        clockAnchorKey = `device:${chatId}`;
        clockAnchorMinutes = null;
        clockAnchorStartedAt = now;
        const deviceTime = new Date(now);
        target.textContent = formatPhoneClockMinutes(deviceTime.getHours() * 60 + deviceTime.getMinutes());
        target.removeAttribute('title');
        target.dataset.source = 'device';
    };
    renderPhoneClock();
    const clockTimer = (runtime.setInterval ?? globalThis.setInterval)?.(renderPhoneClock, 1000);
    clockTimer?.unref?.();
    const phoneSession = runtime.phoneSession ?? createPhoneSession(settings, getCurrentContext);
    const scopedSettings = phoneSession.settings;
    let renderedWorldGeneration = { status: 'idle' };
    let regenerateWorld = async () => undefined;
    let dismissWorldStatus = async () => undefined;
    const renderWorldStatus = worldGeneration => {
        const target = root.querySelector('[data-phone-world-status]');
        if (!target) return;
        renderedWorldGeneration = worldGeneration && typeof worldGeneration === 'object'
            ? { ...worldGeneration }
            : { status: 'idle' };
        const presentation = getPhoneWorldStatusPresentation(worldGeneration);
        target.dataset.state = presentation.state;
        target.replaceChildren();
        target.title = presentation.text;
        const regenerate = root.querySelector('[data-phone-world-regenerate]');
        if (regenerate) {
            const generating = presentation.state === 'generating';
            regenerate.disabled = generating;
            regenerate.dataset.generating = generating ? 'true' : 'false';
            const icon = regenerate.querySelector('i');
            const label = regenerate.querySelector('span');
            if (icon) icon.className = `fa-solid ${generating ? 'fa-spinner' : 'fa-rotate-right'}`;
            if (label) label.textContent = generating ? '接收中' : '接收消息';
        }
        if (presentation.text) {
            const icon = documentRef.createElement('i');
            icon.className = `fa-solid ${presentation.icon}`;
            icon.setAttribute('aria-hidden', 'true');
            const label = documentRef.createElement('span');
            label.textContent = presentation.text;
            target.append(icon, label);
            if (presentation.state === 'error') {
                const actions = documentRef.createElement('span');
                actions.className = 'memory-augment-phone-world-actions';
                const retry = documentRef.createElement('button');
                retry.type = 'button';
                retry.textContent = '重试';
                retry.addEventListener('click', event => {
                    event.stopPropagation();
                    void regenerateWorld(Number(renderedWorldGeneration?.messageId));
                });
                const ignore = documentRef.createElement('button');
                ignore.type = 'button';
                ignore.textContent = '忽略';
                ignore.addEventListener('click', event => {
                    event.stopPropagation();
                    void dismissWorldStatus();
                });
                actions.append(retry, ignore);
                target.append(actions);
            }
        }
    };
    dismissWorldStatus = async () => {
        if (!['ready', 'partial', 'error'].includes(String(renderedWorldGeneration?.status ?? ''))) return;
        const sourceKey = String(renderedWorldGeneration?.sourceKey ?? '');
        renderWorldStatus({ status: 'idle', dismissed: true });
        try {
            const currentStore = await phoneSession.ensure();
            if (sourceKey && String(currentStore.worldGeneration?.sourceKey ?? '') !== sourceKey) return;
            if (!['ready', 'partial', 'error'].includes(String(currentStore.worldGeneration?.status ?? ''))) return;
            currentStore.worldGeneration.dismissed = true;
            await phoneSession.save();
        } catch (error) {
            console.warn('[Memory Augment] 手机更新提示关闭状态保存失败。', error);
        }
    };
    regenerateWorld = async preferredMessageId => {
        if (String(renderedWorldGeneration?.status ?? '') === 'generating') return;
        const current = getCurrentContext();
        const preferred = Number(preferredMessageId);
        const preferredMessage = current?.chat?.[preferred];
        const messageId = Number.isInteger(preferred) && preferred >= 0 && preferredMessage && !preferredMessage.is_user
            ? preferred
            : findLatestPhoneStoryMessageId(current);
        const message = current?.chat?.[messageId];
        if (!Number.isInteger(messageId) || !message || message.is_user) {
            renderWorldStatus({
                status: 'error',
                lastError: '还没有可以用于生成手机内容的正文。',
                dismissed: false,
            });
            return;
        }
        try {
            await requestPhoneWorldStoryUpdate(phoneSession, current, messageId, { force: true });
        } catch {
            // The request itself persists and announces the detailed failure.
        }
    };
    const refreshWorldStatus = async () => {
        if (!getPhoneChatId(getCurrentContext())) {
            renderWorldStatus({ status: 'idle' });
            return;
        }
        try {
            const currentStore = await phoneSession.ensure();
            if (currentStore.worldGeneration?.status === 'generating'
                && !isPhoneWorldStoryUpdateInFlight(currentStore.worldGeneration.sourceKey)
                && Date.now() - Number(currentStore.worldGeneration.startedAt || 0) >= 180_000) {
                currentStore.worldGeneration = {
                    ...currentStore.worldGeneration,
                    status: 'error',
                    lastError: '上一次手机更新已中断，可以重新尝试。',
                    completedAt: Date.now(),
                    dismissed: false,
                };
                await phoneSession.save();
            }
            renderWorldStatus(currentStore.worldGeneration);
        } catch (error) {
            renderWorldStatus({ status: 'error', lastError: error?.message ?? String(error) });
        }
    };
    globalThis.addEventListener?.('memory-augment-phone-world-status', event => {
        renderWorldStatus(event?.detail);
    });
    root.querySelector('[data-phone-world-regenerate]')?.addEventListener('click', event => {
        event.stopPropagation();
        void regenerateWorld();
    });
    root.querySelector('.memory-augment-phone-device')?.addEventListener('click', () => {
        if (['ready', 'partial'].includes(String(renderedWorldGeneration?.status ?? ''))) {
            void dismissWorldStatus();
        }
    });
    void refreshWorldStatus();
    const recordActivity = async value => {
        const currentStore = await phoneSession.ensure();
        const event = appendPhoneActivityEvent(currentStore, value);
        if (event) await phoneSession.save();
        return event;
    };
    const prepareSharedContext = async current => {
        const currentStore = await phoneSession.ensure();
        const recentStory = (Array.isArray(current?.chat) ? current.chat : []).slice(-6)
            .map(item => text(item?.mes ?? item?.content, 5000)).filter(Boolean);
        return preparePhoneStoryContext({
            settings: scopedSettings,
            context: current,
            store: currentStore,
            recentStory,
            snapshot: {
                conversation: { id: 'phone-public', name: '手机公共应用', type: 'group' },
                messages: [],
                messageRecords: [],
                activeMemory: currentStore.onlineMemory?.events ?? [],
            },
        });
    };
    const controllerOptions = {
        document: documentRef,
        settings: scopedSettings,
        contextGetter: getCurrentContext,
        saveSettings: () => phoneSession.save(),
        loadStore: () => phoneSession.ensure(),
        saveStore: () => phoneSession.save(),
        recordActivity,
        weiboAiReady: () => isPhoneWeiboAiReady(scopedSettings),
        bootstrapWeibo: async () => {
            const current = getCurrentContext();
            const storyContext = await prepareSharedContext(current);
            return requestPhoneWeiboBootstrap(scopedSettings, current, {
                saveSettings: () => phoneSession.save(),
                storyContext,
            });
        },
        performWeiboOperation: async operation => {
            const current = getCurrentContext();
            const storyContext = await prepareSharedContext(current);
            return requestPhoneWeiboOperation(scopedSettings, current, operation, {
                saveSettings: () => phoneSession.save(),
                storyContext,
            }).then(async result => {
                const profile = scopedSettings.phone?.weibo?.profile ?? {};
                const post = result?.state?.posts?.[0];
                const role = operation?.type === 'role_post'
                    ? (scopedSettings.phone?.weibo?.roleAccounts ?? []).find(item => item.id === operation.roleId)
                    : null;
                const summaries = {
                    player_post: `发布微博：“${text(operation?.content, 500)}”`,
                    player_repost: `转发微博并写道：“${text(operation?.content, 500) || '转发微博'}”`,
                    player_reply: `在微博评论区回复：“${text(operation?.content, 300)}”`,
                    role_post: `${role?.nickname || post?.author || '角色'}发布微博：“${text(post?.content, 500)}”`,
                };
                await recordActivity({
                    app: 'weibo',
                    tier: operation?.type === 'role_post' ? 'ambient_role' : 'public_personal',
                    accountId: operation?.type === 'role_post' ? role?.id : profile.accountId,
                    isMask: operation?.type === 'role_post' ? false : profile.isMask,
                    summary: summaries[operation?.type],
                    participants: role ? [role.nickname] : (operation?.mentions ?? []).map(item => item.nickname),
                    sourceKey: `${operation?.type}:${post?.id ?? result?.state?.commentReplies?.at(-1)?.id ?? Date.now()}`,
                });
                return result;
            });
        },
        liveAiReady: () => isPhoneLiveAiReady(scopedSettings),
        performLiveOperation: async operation => {
            const current = getCurrentContext();
            const storyContext = await prepareSharedContext(current);
            return requestPhoneLiveOperation(scopedSettings, current, operation, {
                saveSettings: () => phoneSession.save(),
                storyContext,
            }).then(async result => {
                const profile = scopedSettings.phone?.live?.profile ?? {};
                const phase = result?.phase ?? {};
                const action = operation?.type === 'start' ? '开播'
                    : operation?.type === 'end' ? '结束直播' : '推进直播';
                await recordActivity({
                    app: 'live',
                    tier: 'public_personal',
                    accountId: profile.accountId,
                    isMask: profile.isMask,
                    summary: `${action}：${text(phase.summary, 400) || text(operation?.speech, 300) || text(operation?.direction, 300)}`,
                    sourceKey: `live:${result?.ownLive?.sessionId ?? 'session'}:${phase.id ?? Date.now()}`,
                });
                return result;
            });
        },
    };
    appControllers = {
        messages: createPhoneMessagesController(controllerOptions),
        weibo: createPhoneWeiboController(controllerOptions),
        community: createPhoneCommunityController(controllerOptions),
        live: createPhoneLiveController(controllerOptions),
        settings: createPhoneSettingsController(controllerOptions),
    };

    root.querySelectorAll('[data-phone-app]').forEach(button => button.addEventListener('click', async () => {
        appControllers[activeApp]?.close?.();
        activeApp = button.dataset.phoneApp;
        setPhoneScreen(root, 'app', button.dataset.phoneLabel);
        const content = root.querySelector('.memory-augment-phone-app-content');
        if (!content) return;
        content.classList.remove('is-messages', 'is-weibo', 'is-community', 'is-live', 'is-phone-settings');
        try {
            await phoneSession.ensure();
            const before = JSON.stringify(scopedSettings.phone?.accounts ?? null);
            syncPhoneAccountProfiles(scopedSettings, getCurrentContext(), documentRef);
            if (before !== JSON.stringify(scopedSettings.phone?.accounts ?? null)) await phoneSession.save();
        } catch (error) {
            content.textContent = `读取手机失败：${error.message}`;
            return;
        }
        const controller = appControllers[activeApp];
        if (controller) void controller.open(content);
        else renderPlaceholder(content);
    }));
    root.querySelector('[data-phone-back]')?.addEventListener('click', () => {
        if (appControllers[activeApp]?.back?.()) return;
        appControllers[activeApp]?.close?.();
        activeApp = '';
        setPhoneScreen(root, 'home');
    });
    root.querySelector('[data-phone-home]')?.addEventListener('click', () => {
        appControllers[activeApp]?.close?.();
        activeApp = '';
        setPhoneScreen(root, 'home');
    });
    const chatChanged = context?.eventTypes?.CHAT_CHANGED ?? context?.event_types?.CHAT_CHANGED;
    if (chatChanged && context?.eventSource?.on) {
        context.eventSource.on(chatChanged, () => setTimeout(() => {
            phoneSession.invalidate();
            renderPhoneClock();
            void refreshWorldStatus();
            if (!activeApp) return;
            const content = root.querySelector('.memory-augment-phone-app-content');
            if (!content) return;
            void phoneSession.ensure().then(() => {
                syncPhoneAccountProfiles(scopedSettings, getCurrentContext(), documentRef);
                return phoneSession.save();
            }).then(() => appControllers[activeApp]?.open?.(content)).catch(error => {
                content.textContent = `读取手机失败：${error.message}`;
            });
        }, 0));
    }
    phoneShellBound = true;
    return true;
}
