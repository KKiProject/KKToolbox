'use strict';

const { normalizeBaseUrl } = require('./api-url');

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 8064;
const MAX_MAX_TOKENS = 128_000;

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

async function readResponse(response) {
    let rawBody = '';
    let payload;

    console.log('[Barrage] Response status:', response.status);
    try {
        if (typeof response.text === 'function') {
            rawBody = await response.text();
            console.log('[Barrage] Raw response:', rawBody);
            payload = rawBody ? JSON.parse(rawBody) : null;
        } else {
            payload = await response.json();
            rawBody = JSON.stringify(payload);
            console.log('[Barrage] Raw response:', rawBody);
        }
    } catch (error) {
        if (!rawBody) console.log('[Barrage] Raw response:', `[Unable to read response body: ${error?.message ?? error}]`);
        return { rawBody, payload: null, parseError: error };
    }

    return { rawBody, payload, parseError: null };
}

function getErrorDetail(payload, rawBody, fallback = 'Unknown upstream error') {
    const error = payload?.error;
    const candidates = [
        error?.message,
        error?.detail,
        typeof error === 'string' ? error : '',
        payload?.message,
        payload?.detail,
        payload?.msg,
    ];
    const detail = candidates.find(value => typeof value === 'string' && value.trim());
    if (detail) return detail.trim().slice(0, 1000);
    if (error && typeof error === 'object') {
        try {
            return JSON.stringify(error).slice(0, 1000);
        } catch {
            // Fall through to the raw response text.
        }
    }
    return String(rawBody || fallback).trim().slice(0, 1000);
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

function buildBarrageUserContent(recentMessages, ragFragments) {
    const recent = Array.isArray(recentMessages)
        ? recentMessages.map((message, index) => ({
            id: message?.id ?? index,
            name: String(message?.name ?? message?.role ?? '消息').trim(),
            text: String(message?.text ?? '').trim(),
        })).filter(message => message.text)
        : [];
    if (recent.length === 0) {
        const error = new BarrageApiError('At least one recent message is required.', 400);
        throw error;
    }

    const latest = recent.at(-1);
    const recap = recent.slice(0, -1)
        .map(message => `[第 ${message.id} 楼] ${message.name}: ${message.text}`)
        .join('\n');
    const memories = Array.isArray(ragFragments)
        ? ragFragments.map((fragment, index) => {
            const text = String(fragment?.text ?? fragment ?? '').trim();
            return text ? `[历史片段 ${index + 1}] ${text}` : '';
        }).filter(Boolean).join('\n\n')
        : '';

    return [
        '【前情回顾】（仅供理解上下文，不要单独评论）',
        recap || '（无）',
        '',
        '【相关记忆】（仅供前后呼应参考，不要单独评论）',
        memories || '（无）',
        '',
        '---',
        '',
        '【最新章节】（这是你要评论的内容）',
        latest.text,
    ].join('\n');
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
    const requestedMaxTokens = Math.trunc(Number(options.maxTokens));
    const maxTokens = Number.isFinite(requestedMaxTokens)
        ? Math.max(1, Math.min(MAX_MAX_TOKENS, requestedMaxTokens))
        : DEFAULT_MAX_TOKENS;

    if (typeof fetchImpl !== 'function') {
        throw new BarrageApiError('Fetch API is unavailable.', 500);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const requestBody = {
            model: config.model,
            messages,
            max_tokens: maxTokens,
        };
        let response;

        console.log('[Barrage] Sending request to:', config.endpoint);
        console.log('[Barrage] Request body:', JSON.stringify(requestBody, null, 2));
        try {
            response = await fetchImpl(config.endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
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

        const { rawBody, payload, parseError } = await readResponse(response);
        const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
        if (retryable && attempt < maxRetries) {
            const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'));
            const delay = Math.min(retryAfter ?? retryDelayMs * (2 ** attempt), 30_000);
            await sleep(delay);
            continue;
        }

        if (response.status !== 200) {
            const detail = getErrorDetail(payload, rawBody, response.statusText);
            const statusCode = response.status >= 400 && response.status <= 599 ? response.status : 502;
            throw new BarrageApiError(`Barrage API returned ${response.status}: ${detail}`, statusCode);
        }

        if (parseError) {
            throw new BarrageApiError('Barrage API returned invalid JSON.');
        }

        if (payload?.error) {
            const detail = getErrorDetail(payload, rawBody);
            throw new BarrageApiError(`Barrage API returned an error: ${detail}`);
        }

        if (!Array.isArray(payload?.choices)) {
            const detail = getErrorDetail(payload, '', '');
            if (detail) {
                throw new BarrageApiError(`Barrage API returned an error: ${detail}`);
            }
        }

        return extractContent(payload);
    }

    throw new BarrageApiError('Barrage request failed after retries.');
}

module.exports = {
    BarrageApiError,
    DEFAULT_MAX_TOKENS,
    MAX_MAX_TOKENS,
    buildBarrageUserContent,
    generateBarrage,
};
