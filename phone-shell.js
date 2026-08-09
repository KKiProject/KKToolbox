import { createPhoneMessagesController } from './phone-messages.js';
import { createPhoneWeiboController } from './phone-weibo.js';
import { createPhoneCommunityController } from './phone-community.js';
import { createPhoneLiveController } from './phone-live.js';
import { createPhoneSettingsController, syncPhoneAccountProfiles } from './phone-settings.js';
import { createPhoneSession } from './phone-session.js';
import { appendPhoneActivityEvent } from './phone-store.js';
import { cleanPhoneText as text } from './phone-utils.js';
import { preparePhoneStoryContext } from './phone-context.js';
import {
    isPhoneWeiboAiReady,
    requestPhoneWeiboBootstrap,
    requestPhoneWeiboOperation,
} from './phone-weibo-ai.js';
import { isPhoneLiveAiReady, requestPhoneLiveOperation } from './phone-live-ai.js';

export const PHONE_APP_SHELLS = Object.freeze([
    { id: 'messages', label: '消息', icon: 'fa-envelope', tone: 'green' },
    { id: 'weibo', label: '微博', icon: 'fa-fire', tone: 'rose' },
    { id: 'community', label: '社区', icon: 'fa-comments', tone: 'blue' },
    { id: 'live', label: '直播', icon: 'fa-video', tone: 'pink' },
    { id: 'settings', label: '设置', icon: 'fa-gear', tone: 'sand' },
]);

let phoneShellBound = false;
let appControllers = {};
let activeApp = '';

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
                <section class="memory-augment-phone-device" aria-label="娱乐圈手机">
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
                                <strong>娱乐圈</strong>
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
    const phoneSession = runtime.phoneSession ?? createPhoneSession(settings, getCurrentContext);
    const scopedSettings = phoneSession.settings;
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
