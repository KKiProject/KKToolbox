/**
 * Normalizes an OpenAI-compatible API root before endpoint paths are appended.
 * Accepts roots ending in `/`, `/v1`, or `/v1/` without producing duplicate segments.
 */
export function normalizeBaseUrl(value) {
    return String(value ?? '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/v1$/i, '');
}
