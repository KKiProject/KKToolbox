import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBaseUrl } from '../api-utils.js';

test('normalizes root, /v1, and /v1/ API base URLs to one root', () => {
    const expected = 'https://api.example.com';
    assert.equal(normalizeBaseUrl('https://api.example.com'), expected);
    assert.equal(normalizeBaseUrl('https://api.example.com/v1'), expected);
    assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), expected);
});

test('normalizes a version suffix after a custom path case-insensitively', () => {
    assert.equal(normalizeBaseUrl(' https://api.example.com/proxy/V1/// '), 'https://api.example.com/proxy');
});
