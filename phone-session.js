import {
    createEmptyScopedPhoneState,
    getPhoneChatId,
    loadPhoneStore,
    normalizePhoneProfile,
    savePhoneStore,
} from './phone-store.js';

const SCOPED_STORAGE_VERSION = 1;

function clone(value) {
    if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function currentPersona(context = {}) {
    const powerUser = context?.powerUser ?? context?.power_user ?? globalThis.power_user ?? {};
    return normalizePhoneProfile({
        nickname: context?.name1 || '我',
        avatar: context?.userAvatar ?? context?.user_avatar ?? '',
        persona: powerUser?.persona_description ?? '',
    });
}

/**
 * Keeps all in-world phone state inside the current SillyTavern chat file while
 * allowing existing controllers to keep using their familiar `settings.phone` API.
 */
export function createPhoneSession(globalSettings = {}, contextGetter = () => ({})) {
    let store = null;
    let loading = null;

    const settings = new Proxy(globalSettings, {
        get(target, property, receiver) {
            if (property === 'phone') return store?.phone ?? target.phone;
            return Reflect.get(target, property, receiver);
        },
        set(target, property, value, receiver) {
            if (property === 'phone' && store) {
                store.phone = value && typeof value === 'object' ? value : {};
                return true;
            }
            return Reflect.set(target, property, value, receiver);
        },
    });

    async function initializeStore(nextStore, context) {
        if (nextStore.scopedInitialized) return false;
        const migration = globalSettings.phoneScopedStorage ?? {};
        if (migration.legacyMigrated !== true && globalSettings.phone) {
            const legacyPhone = clone(globalSettings.phone);
            nextStore.phone = legacyPhone;
            nextStore.phone.profile = normalizePhoneProfile(nextStore.phone.profile ?? currentPersona(context));
            nextStore.profile = normalizePhoneProfile(nextStore.phone.profile);
            globalSettings.phoneScopedStorage = {
                version: SCOPED_STORAGE_VERSION,
                legacyMigrated: true,
                migratedChatId: nextStore.chatId,
                migratedAt: Date.now(),
            };
            // Once copied into this chat file, do not leave a second mutable
            // in-world phone behind in global extension settings.
            globalSettings.phone = { scopedStorageVersion: SCOPED_STORAGE_VERSION };
            context?.saveSettingsDebounced?.();
        } else {
            const profile = currentPersona(context);
            nextStore.phone = createEmptyScopedPhoneState(profile);
            nextStore.profile = profile;
        }
        nextStore.scopedInitialized = true;
        await savePhoneStore(nextStore, context);
        return true;
    }

    async function ensure(options = {}) {
        const context = contextGetter() ?? {};
        const chatId = getPhoneChatId(context);
        if (store?.chatId === chatId && !options.force) return store;
        if (loading && !options.force) return loading;
        loading = (async () => {
            const nextStore = await loadPhoneStore(context, { force: options.force === true });
            await initializeStore(nextStore, context);
            store = nextStore;
            return store;
        })();
        try {
            return await loading;
        } finally {
            loading = null;
        }
    }

    async function save() {
        const current = await ensure();
        current.phone ??= createEmptyScopedPhoneState(current.profile);
        current.phone.profile = normalizePhoneProfile(current.phone.profile ?? current.profile);
        current.profile = normalizePhoneProfile(current.phone.profile);
        return savePhoneStore(current, contextGetter());
    }

    function invalidate() {
        store = null;
        loading = null;
    }

    return {
        settings,
        ensure,
        save,
        invalidate,
        getStore: () => store,
    };
}
