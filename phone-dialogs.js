import { cleanPhoneText as text } from './phone-utils.js';

const activePhoneOverlayClosers = new WeakMap();

export function closeActivePhoneOverlay(root) {
    if (!root) return false;
    const closer = activePhoneOverlayClosers.get(root);
    if (closer) {
        closer();
        return true;
    }
    const overlay = root.querySelector('.memory-augment-phone-sheet-overlay');
    if (!overlay) return false;
    overlay.remove();
    return true;
}

export function registerPhoneOverlayCloser(root, closer) {
    activePhoneOverlayClosers.set(root, closer);
}

export function unregisterPhoneOverlayCloser(root, closer) {
    if (activePhoneOverlayClosers.get(root) === closer) activePhoneOverlayClosers.delete(root);
}

export function getPhoneFieldValidationMessage(descriptor = {}, value = '') {
    const label = text(descriptor.label, 120) || '此项';
    const empty = descriptor.type === 'file'
        ? !value
        : !String(value ?? '').trim();
    if (descriptor.required && empty) return `请填写${label}。`;
    if (descriptor.type !== 'number' || empty) return '';

    const number = Number(value);
    if (!Number.isFinite(number)) return `${label}必须是有效数字。`;
    if (descriptor.min !== undefined && number < Number(descriptor.min)) {
        return `${label}不能小于 ${descriptor.min}。`;
    }
    if (descriptor.max !== undefined && number > Number(descriptor.max)) {
        return `${label}不能大于 ${descriptor.max}。`;
    }

    const step = descriptor.step === 'any'
        ? 0
        : Number(descriptor.step ?? 1);
    if (Number.isFinite(step) && step > 0) {
        const base = descriptor.min !== undefined && Number.isFinite(Number(descriptor.min))
            ? Number(descriptor.min)
            : 0;
        const steps = (number - base) / step;
        if (Math.abs(steps - Math.round(steps)) > 1e-8) {
            return step === 0.01
                ? `${label}最多保留两位小数。`
                : `${label}必须按 ${step} 递增。`;
        }
    }
    return '';
}

function createField(documentRef, descriptor) {
    const label = documentRef.createElement(descriptor.type === 'file' ? 'div' : 'label');
    label.className = 'memory-augment-phone-form-field';
    const caption = documentRef.createElement('span');
    caption.textContent = descriptor.label;
    const input = descriptor.type === 'textarea'
        ? documentRef.createElement('textarea')
        : descriptor.type === 'select'
            ? documentRef.createElement('select')
            : documentRef.createElement('input');
    if (!['textarea', 'select'].includes(descriptor.type)) input.type = descriptor.type ?? 'text';
    input.name = descriptor.name;
    input.autocomplete = 'off';
    input.placeholder = descriptor.placeholder ?? '';
    if (descriptor.min !== undefined) input.min = String(descriptor.min);
    if (descriptor.max !== undefined) input.max = String(descriptor.max);
    if (descriptor.step !== undefined) input.step = String(descriptor.step);
    if (descriptor.accept) input.accept = descriptor.accept;
    if (descriptor.required) input.required = true;
    if (descriptor.type === 'select') {
        for (const optionDescriptor of descriptor.options ?? []) {
            const option = documentRef.createElement('option');
            option.value = optionDescriptor.value;
            option.textContent = optionDescriptor.label;
            input.append(option);
        }
    }
    input.value = descriptor.value ?? '';
    if (descriptor.type === 'file') {
        input.hidden = true;
        const picker = documentRef.createElement('div');
        picker.className = 'memory-augment-phone-file-picker';
        const choose = documentRef.createElement('button');
        choose.type = 'button';
        choose.textContent = '选择本地图片';
        const chosen = documentRef.createElement('span');
        chosen.textContent = '未选择图片';
        choose.addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
            chosen.textContent = input.files?.[0]?.name || '未选择图片';
        });
        picker.append(choose, chosen, input);
        label.append(caption, picker);
    } else {
        label.append(caption, input);
    }
    return { label, input };
}

export function openPhoneForm(root, config) {
    return new Promise((resolve) => {
        closeActivePhoneOverlay(root);
        const documentRef = root.ownerDocument;
        const overlay = documentRef.createElement('div');
        overlay.className = 'memory-augment-phone-sheet-overlay';
        const form = documentRef.createElement('form');
        form.className = 'memory-augment-phone-sheet';
        form.autocomplete = 'off';
        form.noValidate = true;
        const heading = documentRef.createElement('h3');
        heading.textContent = config.title;
        const fields = new Map();
        form.append(heading);
        if (config.message) {
            const message = documentRef.createElement('p');
            message.className = 'memory-augment-phone-confirm-message';
            message.textContent = config.message;
            form.append(message);
        }
        for (const descriptor of config.fields ?? []) {
            const field = createField(documentRef, descriptor);
            fields.set(descriptor.name, field.input);
            form.append(field.label);
        }
        const error = documentRef.createElement('div');
        error.className = 'memory-augment-phone-form-error';
        const actions = documentRef.createElement('div');
        actions.className = 'memory-augment-phone-sheet-actions';
        const cancel = documentRef.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '取消';
        const submit = documentRef.createElement('button');
        submit.type = 'submit';
        submit.textContent = config.submitLabel ?? '确定';
        if (config.danger) submit.classList.add('is-danger');
        actions.append(cancel, submit);
        form.append(error, actions);
        overlay.append(form);
        root.append(overlay);
        let settled = false;
        const close = (value = null) => {
            if (settled) return;
            settled = true;
            unregisterPhoneOverlayCloser(root, close);
            overlay.remove();
            resolve(value);
        };
        registerPhoneOverlayCloser(root, close);
        cancel.addEventListener('click', () => close(null));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) close(null);
        });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            submit.disabled = true;
            error.textContent = '';
            const values = {};
            fields.forEach((input, name) => {
                values[name] = input.type === 'file' ? input.files?.[0] ?? null : input.value;
            });
            for (const descriptor of config.fields ?? []) {
                const validationMessage = getPhoneFieldValidationMessage(descriptor, values[descriptor.name]);
                if (!validationMessage) continue;
                error.textContent = validationMessage;
                fields.get(descriptor.name)?.focus?.();
                submit.disabled = false;
                return;
            }
            try {
                const result = config.onSubmit ? await config.onSubmit(values) : values;
                close(result ?? values);
            } catch (formError) {
                error.textContent = formError.message;
                submit.disabled = false;
            }
        });
        fields.values().next().value?.focus?.();
    });
}

export async function openPhoneConfirm(root, config) {
    return Boolean(await openPhoneForm(root, {
        title: config.title ?? '请确认',
        message: config.message,
        submitLabel: config.confirmLabel ?? '确定',
        danger: config.danger !== false,
        fields: [],
        onSubmit: () => true,
    }));
}
