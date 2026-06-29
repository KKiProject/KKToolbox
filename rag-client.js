const API_BASE = '/api/plugins/st-memory-augment';

async function request(endpoint, options = {}) {
    const context = SillyTavern.getContext();
    const headers = {
        ...context.getRequestHeaders(),
        ...(options.headers ?? {}),
    };
    const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
    let payload;

    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        throw new Error(payload?.error ?? `Memory Augment request failed (${response.status} ${response.statusText})`);
    }

    return payload;
}

function post(endpoint, payload) {
    return request(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function getStatus(chatId) {
    const query = chatId ? `?chatId=${encodeURIComponent(chatId)}` : '';
    return request(`/status${query}`);
}

export function ingestChat(payload) {
    return post('/ingest', payload);
}

export function fetchModels(payload) {
    return post('/models', {
        base_url: payload?.base_url ?? payload?.baseUrl,
        api_key: payload?.api_key ?? payload?.apiKey,
    });
}

export function embedWorldInfo(payload) {
    return post('/embed', payload);
}

export function searchMemory(payload) {
    return post('/search', payload);
}

export function rerankMemory(payload) {
    return post('/rerank', payload);
}

export function generateBarrage(payload) {
    return post('/barrage', payload);
}

export function clearChat(chatId) {
    return post('/clear', { chatId });
}
