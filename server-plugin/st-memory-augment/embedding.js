'use strict';

const { normalizeBaseUrl } = require('./api-url');

const MAX_BATCH_SIZE = 64;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

class EmbeddingApiError extends Error {
    constructor(message, statusCode = 502) {
        super(message);
        this.name = 'EmbeddingApiError';
        this.statusCode = statusCode;
    }
}

function validateConfig(config) {
    const baseUrl = normalizeBaseUrl(config?.baseUrl);
    const apiKey = String(config?.apiKey ?? '').trim();
    const model = String(config?.model ?? '').trim();

    if (!baseUrl || !apiKey || !model) {
        throw new EmbeddingApiError('Embedding base URL, API key, and model are required.', 400);
    }

    let endpoint;
    try {
        endpoint = new URL(`${baseUrl}/v1/embeddings`);
    } catch {
        throw new EmbeddingApiError('Embedding base URL is invalid.', 400);
    }

    if (!['http:', 'https:'].includes(endpoint.protocol)) {
        throw new EmbeddingApiError('Embedding base URL must use HTTP or HTTPS.', 400);
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

async function requestBatch(input, config, options) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (typeof fetchImpl !== 'function') {
        throw new EmbeddingApiError('Fetch API is unavailable.', 500);
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
                    input,
                    encoding_format: 'float',
                }),
                signal: controller.signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new EmbeddingApiError(`Embedding request timed out after ${timeoutMs}ms.`);
            }
            throw new EmbeddingApiError(`Embedding request failed: ${error?.message ?? error}`);
        } finally {
            clearTimeout(timeout);
        }

        if (response.status === 429 && attempt < maxRetries) {
            const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'));
            const delay = Math.min(retryAfter ?? retryDelayMs * (2 ** attempt), 30_000);
            await sleep(delay);
            continue;
        }

        if (!response.ok) {
            const detail = await readError(response);
            const statusCode = response.status === 429 ? 429 : 502;
            throw new EmbeddingApiError(`Embedding API returned ${response.status}: ${detail}`, statusCode);
        }

        let payload;
        try {
            payload = await response.json();
        } catch {
            throw new EmbeddingApiError('Embedding API returned invalid JSON.');
        }

        if (!Array.isArray(payload?.data)) {
            throw new EmbeddingApiError('Embedding API response is missing the data array.');
        }

        const vectors = [...payload.data]
            .sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0))
            .map(item => item.embedding);

        const dimension = vectors[0]?.length ?? 0;
        const invalidVector = vectors.some(vector => !Array.isArray(vector)
            || vector.length !== dimension
            || vector.some(value => !Number.isFinite(Number(value))));

        if (vectors.length !== input.length || dimension === 0 || invalidVector) {
            throw new EmbeddingApiError('Embedding API returned an unexpected number of vectors.');
        }

        return vectors;
    }

    throw new EmbeddingApiError('Embedding request failed after retries.');
}

async function createEmbeddings(input, rawConfig, options = {}) {
    const texts = Array.isArray(input) ? input.map(value => String(value)) : [];
    if (texts.length === 0) {
        return [];
    }

    const config = validateConfig(rawConfig);
    const vectors = [];

    for (let offset = 0; offset < texts.length; offset += MAX_BATCH_SIZE) {
        const batch = texts.slice(offset, offset + MAX_BATCH_SIZE);
        vectors.push(...await requestBatch(batch, config, options));
    }

    return vectors;
}

module.exports = {
    EmbeddingApiError,
    MAX_BATCH_SIZE,
    createEmbeddings,
};
