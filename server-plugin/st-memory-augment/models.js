'use strict';

const { normalizeBaseUrl } = require('./api-url');

const DEFAULT_TIMEOUT_MS = 30_000;

class ModelsApiError extends Error {
    constructor(message, statusCode = 502) {
        super(message);
        this.name = 'ModelsApiError';
        this.statusCode = statusCode;
    }
}

function validateConfig(config) {
    const baseUrl = normalizeBaseUrl(config?.baseUrl);
    const apiKey = String(config?.apiKey ?? '').trim();
    if (!baseUrl || !apiKey) {
        throw new ModelsApiError('Base URL 和 API Key 不能为空。', 400);
    }

    let endpoint;
    try {
        endpoint = new URL(`${baseUrl}/v1/models`);
    } catch {
        throw new ModelsApiError('Base URL 格式无效。', 400);
    }

    if (!['http:', 'https:'].includes(endpoint.protocol)) {
        throw new ModelsApiError('Base URL 必须使用 HTTP 或 HTTPS。', 400);
    }

    return { endpoint: endpoint.toString(), apiKey };
}

async function readError(response) {
    try {
        const payload = await response.json();
        return String(payload?.error?.message ?? payload?.message ?? response.statusText).slice(0, 300);
    } catch {
        return String(response.statusText || '未知上游错误').slice(0, 300);
    }
}

function normalizeModels(payload) {
    const items = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models) ? payload.models : [];
    return [...new Set(items
        .map(item => typeof item === 'string' ? item : item?.id ?? item?.name)
        .map(value => String(value ?? '').trim())
        .filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

async function listModels(rawConfig, options = {}) {
    const config = validateConfig(rawConfig);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof fetchImpl !== 'function') {
        throw new ModelsApiError('Fetch API 不可用。', 500);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetchImpl(config.endpoint, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
                Accept: 'application/json',
            },
            signal: controller.signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new ModelsApiError(`模型列表请求在 ${timeoutMs}ms 后超时。`);
        }
        throw new ModelsApiError(`模型列表请求失败：${error?.message ?? error}`);
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        const detail = await readError(response);
        throw new ModelsApiError(`模型 API 返回 ${response.status}：${detail}`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new ModelsApiError('模型 API 返回了无效 JSON。');
    }

    const models = normalizeModels(payload);
    if (models.length === 0) {
        throw new ModelsApiError('模型 API 未返回可用模型。');
    }
    return models;
}

module.exports = {
    ModelsApiError,
    listModels,
    normalizeModels,
};
