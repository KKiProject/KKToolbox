// A page reload tears down every listener, queue and iframe together. When off,
// index.js keeps only this control and never starts the feature lifecycles.
export function bindMasterSwitch(settings, { documentRef, save, reload }) {
    const input = documentRef.querySelector('#memory_augment_enabled');
    const status = documentRef.querySelector('#memory_augment_enabled_status');
    const features = documentRef.querySelector('#memory_augment_feature_settings');
    if (!input) return;
    const enabled = settings.enabled !== false;
    input.checked = enabled;
    if (features) features.hidden = !enabled;
    if (status) status.textContent = enabled ? '工具箱已开启' : '工具箱已关闭';
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
