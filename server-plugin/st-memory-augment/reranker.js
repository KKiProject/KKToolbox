'use strict';

const { normalizeBaseUrl } = require('./api-url');

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

class RerankerApiError extends Error {
    constructor(message, statusCode = 502) {
        super(message);
        this.name = 'RerankerApiError';
        this.statusCode = statusCode;
    }
}

function validateConfig(config) {
    const baseUrl = normalizeBaseUrl(config?.baseUrl);
    const apiKey = String(config?.apiKey ?? '').trim();
    const model = String(config?.model ?? '').trim();

    if (!baseUrl || !apiKey || !model) {
        throw new RerankerApiError('Reranker base URL, API key, and model are required.', 400);
    }

    let endpoint;
    try {
        endpoint = new URL(`${baseUrl}/v1/rerank`);
    } catch {
        throw new RerankerApiError('Reranker base URL is invalid.', 400);
    }

    if (!['http:', 'https:'].includes(endpoint.protocol)) {
        throw new RerankerApiError('Reranker base URL must use HTTP or HTTPS.', 400);
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

function normalizeResults(payload, documentCount) {
    const rawResults = Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload?.data) ? payload.data : null;

    if (!rawResults) {
        throw new RerankerApiError('Reranker API response is missing the results array.');
    }

    const seen = new Set();
    const results = [];

    for (const result of rawResults) {
        const index = Number(result?.index);
        const score = Number(result?.relevance_score ?? result?.score);
        if (!Number.isInteger(index) || index < 0 || index >= documentCount || !Number.isFinite(score) || seen.has(index)) {
            continue;
        }
        seen.add(index);
        results.push({ index, score });
    }

    return results.sort((left, right) => right.score - left.score);
}

async function rerankDocuments(query, documents, rawConfig, topN, options = {}) {
    const normalizedQuery = String(query ?? '').trim();
    const normalizedDocuments = Array.isArray(documents) ? documents.map(value => String(value)) : [];
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(topN) || 7)));

    if (!normalizedQuery) {
        throw new RerankerApiError('Reranker query is required.', 400);
    }
    if (normalizedDocuments.length === 0) {
        return [];
    }

    const config = validateConfig(rawConfig);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (typeof fetchImpl !== 'function') {
        throw new RerankerApiError('Fetch API is unavailable.', 500);
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
                    query: normalizedQuery,
                    documents: normalizedDocuments,
                    top_n: limit,
                }),
                signal: controller.signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new RerankerApiError(`Reranker request timed out after ${timeoutMs}ms.`);
            }
            throw new RerankerApiError(`Reranker request failed: ${error?.message ?? error}`);
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
            throw new RerankerApiError(`Reranker API returned ${response.status}: ${detail}`, statusCode);
        }

        let payload;
        try {
            payload = await response.json();
        } catch {
            throw new RerankerApiError('Reranker API returned invalid JSON.');
        }

        return normalizeResults(payload, normalizedDocuments.length).slice(0, limit);
    }

    throw new RerankerApiError('Reranker request failed after retries.');
}

module.exports = {
    RerankerApiError,
    rerankDocuments,
};
