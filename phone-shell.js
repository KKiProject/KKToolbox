import { createPhoneMessagesController } from './phone-messages.js';

export const PHONE_APP_SHELLS = Object.freeze([
    { id: 'messages', label: '消息', icon: 'fa-envelope', tone: 'green' },
    { id: 'weibo', label: '微博', icon: 'fa-fire', tone: 'rose' },
    { id: 'community', label: '社区', icon: 'fa-comments', tone: 'blue' },
    { id: 'live', label: '直播', icon: 'fa-video', tone: 'pink' },
    { id: 'settings', label: '设置', icon: 'fa-gear', tone: 'sand' },
]);

let phoneShellBound = false;
let messagesController = null;
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

function renderPlaceholder(content, title) {
    content.classList.remove('is-messages');
    content.innerHTML = `
        <div class="memory-augment-phone-placeholder-heading"></div>
        <div class="memory-augment-phone-placeholder-card"></div>
        <div class="memory-augment-phone-placeholder-card is-short"></div>
        <p>${title}功能稍后接入。</p>`;
}

export function initializePhoneShellUi(settings = {}, context = globalThis.SillyTavern?.getContext?.(), documentRef = globalThis.document) {
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
                                <small>故事之外，也有人正在注视他们。</small>
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
                                <p>手机骨架已经就位，内容功能稍后接入。</p>
                            </div>
                        </main>
                        <button type="button" class="memory-augment-phone-home-indicator" data-phone-home aria-label="返回手机桌面"></button>
                    </div>
                </section>
            </div>`;
    }
    if (phoneShellBound) return true;

    messagesController = createPhoneMessagesController({
        document: documentRef,
        settings,
        contextGetter: () => globalThis.SillyTavern?.getContext?.() ?? context,
        saveSettings: () => (globalThis.SillyTavern?.getContext?.() ?? context)?.saveSettingsDebounced?.(),
    });

    root.querySelectorAll('[data-phone-app]').forEach(button => button.addEventListener('click', () => {
        activeApp = button.dataset.phoneApp;
        setPhoneScreen(root, 'app', button.dataset.phoneLabel);
        const content = root.querySelector('.memory-augment-phone-app-content');
        if (!content) return;
        if (activeApp === 'messages') void messagesController.open(content);
        else renderPlaceholder(content, button.dataset.phoneLabel);
    }));
    root.querySelector('[data-phone-back]')?.addEventListener('click', () => {
        if (activeApp === 'messages' && messagesController.back()) return;
        activeApp = '';
        setPhoneScreen(root, 'home');
    });
    root.querySelector('[data-phone-home]')?.addEventListener('click', () => {
        activeApp = '';
        setPhoneScreen(root, 'home');
    });
    phoneShellBound = true;
    return true;
}
