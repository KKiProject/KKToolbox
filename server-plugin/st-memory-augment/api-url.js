'use strict';

/**
 * Normalize an OpenAI-compatible API root before appending `/v1/...` endpoints.
 */
function normalizeBaseUrl(value) {
    return String(value ?? '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/v1$/i, '');
}

module.exports = { normalizeBaseUrl };
