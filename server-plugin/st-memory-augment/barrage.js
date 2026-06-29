'use strict';

const { normalizeBaseUrl } = require('./api-url');

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 500;

class BarrageApiError extends Error {
    constructor(message, statusCode = 502) {
        super(message);
        this.name = 'BarrageApiError';
        this.statusCode = statusCode;
    }
}

function validateConfig(config) {
    const baseUrl = normalizeBaseUrl(config?.baseUrl);
    const apiKey = String(config?.apiKey ?? '').trim();
    const model = String(config?.model ?? '').trim();

    if (!baseUrl || !apiKey || !model) {
        throw new BarrageApiError('Barrage base URL, API key, and model are required.', 400);
    }

    let endpoint;
    try {
        endpoint = new URL(`${baseUrl}/v1/chat/completions`);
    } catch {
        throw new BarrageApiError('Barrage base URL is invalid.', 400);
    }

    if (!['http:', 'https:'].includes(endpoint.protocol)) {
        throw new BarrageApiError('Barrage base URL must use HTTP or HTTPS.', 400);
    }

    return { endpoint: endpoint.toString(), apiKey, model };
}

function parseRetryAfter(value) {
    if (!value) {
        return null;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
    }

    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

async function readError(response) {
    try {
        const payload = await response.json();
        return String(payload?.error?.message ?? payload?.message ?? response.statusText).slice(0, 500);
    } catch {
        return String(response.statusText || 'Unknown upstream error').slice(0, 500);
    }
}

function extractContent(payload) {
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) {
        return content.trim();
    }

    if (Array.isArray(content)) {
        const text = content.map(part => part?.text ?? '').join('').trim();
        if (text) {
            return text;
        }
    }

    throw new BarrageApiError('Barrage API response is missing choices[0].message.content.');
}

async function generateBarrage(messages, rawConfig, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new BarrageApiError('Barrage messages are required.', 400);
    }

    const config = validateConfig(rawConfig);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (typeof fetchImpl !== 'function') {
        throw new BarrageApiError('Fetch API is unavailable.', 500);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let response;

        try {
            response = await fetchImpl(config.endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: config.model,
                    messages,
                    max_tokens: MAX_TOKENS,
                }),
                signal: controller.signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new BarrageApiError(`Barrage request timed out after ${timeoutMs}ms.`);
            }
            throw new BarrageApiError(`Barrage request failed: ${error?.message ?? error}`);
        } finally {
            clearTimeout(timeout);
        }

        const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
        if (retryable && attempt < maxRetries) {
            const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'));
            const delay = Math.min(retryAfter ?? retryDelayMs * (2 ** attempt), 30_000);
            await sleep(delay);
            continue;
        }

        if (!response.ok) {
            const detail = await readError(response);
            const statusCode = response.status === 429 ? 429 : 502;
            throw new BarrageApiError(`Barrage API returned ${response.status}: ${detail}`, statusCode);
        }

        let payload;
        try {
            payload = await response.json();
        } catch {
            throw new BarrageApiError('Barrage API returned invalid JSON.');
        }

        return extractContent(payload);
    }

    throw new BarrageApiError('Barrage request failed after retries.');
}

module.exports = {
    BarrageApiError,
    MAX_TOKENS,
    generateBarrage,
};
