// A page reload tears down every listener, queue and iframe together. When off,
// index.js keeps settings editable but never starts the feature lifecycles.
export function bindMasterSwitch(settings, { documentRef, save, reload }) {
    const input = documentRef.querySelector('#memory_augment_enabled');
    const status = documentRef.querySelector('#memory_augment_enabled_status');
    const features = documentRef.querySelector('#memory_augment_feature_settings');
    if (!input) return;
    const enabled = settings.enabled !== false;
    input.checked = enabled;
    if (features) features.hidden = false;
    if (status) status.textContent = enabled ? '工具箱已开启' : '工具箱已关闭；设置仍可查看和保存，重新开启后生效。';
    if (!enabled) {
        features?.querySelectorAll('button').forEach(button => {
            if (button.id === 'memory_augment_add_status_custom_field') return;
            button.disabled = true;
            button.title = '请先开启工具箱再执行此操作';
        });
        for (const id of ['memory_augment_worldinfo_entries', 'memory_augment_status_summary_progress', 'memory_augment_generation_timing']) {
            const element = documentRef.querySelector(`#${id}`);
            if (element) element.textContent = '工具箱已关闭，暂停读取和更新。';
        }
    }
    input.addEventListener('change', async () => {
        const previous = settings.enabled;
        settings.enabled = input.checked;
        input.disabled = true;
        if (status) status.textContent = '正在保存，随后自动刷新…';
        try {
            // ST can defer saving during a temporary generation override.
            // Do not reload and lose the toggle if no save actually happened.
            const result = await save();
            if (result === undefined) throw new Error('酒馆暂时无法保存设置，请等当前生成结束后重试');
            if (result?.result !== 'ok') throw new Error('设置未保存成功，请重试');
            reload();
        } catch (error) {
            settings.enabled = previous;
            input.checked = previous !== false;
            input.disabled = false;
            if (status) status.textContent = `切换未生效：${error.message}`;
        }
    });
}
