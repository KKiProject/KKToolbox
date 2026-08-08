export function clonePhoneState(value) {
    if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

export function restorePhoneState(target, snapshot) {
    for (const key of Object.keys(target ?? {})) delete target[key];
    Object.assign(target, clonePhoneState(snapshot));
}

export function beginPhoneStateTransaction(target) {
    const snapshot = clonePhoneState(target);
    let active = true;
    return {
        target,
        commit() {
            active = false;
        },
        rollback() {
            if (!active) return;
            restorePhoneState(target, snapshot);
            active = false;
        },
        async persist(save) {
            try {
                const result = await save(target);
                active = false;
                return result;
            } catch (error) {
                this.rollback();
                throw error;
            }
        },
    };
}
