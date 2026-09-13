// Regression check for the provider-aware pricing: which rate card and peak
// schedule applies to a model, and that Ollama's OpenAI-shaped usage maps onto
// the same cache_hit/cache_miss/completion fields the cost math uses.
// Run with: node test-usage.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// index.js is an IIFE that needs SillyTavern's globals, so evaluate just the pure
// helpers out of the source with the pricing tables injected.
const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const body = slice('function usageFrom(', 'function extractUsage(') + slice('const PRICE_ALIASES', 'const usageForMessage');
const build = new Function('pricing', 'ollama', `${body}\nreturn { usageFrom, cost, providerFor, priceFor };`);

const pricing = {
    models: { 'deepseek-v4-pro': { cache_hit: 0.022, cache_miss: 0.66, output: 1.98 } },
    effective: { 'deepseek-v4-pro': { cache_hit: 0.022, cache_miss: 0.66, output: 1.98 } },
};
const ollama = {
    models: {
        'deepseek-v4-pro': { cache_hit: 0.022, cache_miss: 0.66, output: 1.98 },
        'deepseek-v4.1-flash': { cache_hit: 0.003, cache_miss: 0.15, output: 0.6 },
        'gemma4': { cache_hit: 0.05, cache_miss: 0.14, output: 0.4 },
    },
    effective: {
        'deepseek-v4-pro': { cache_hit: 0.044, cache_miss: 1.32, output: 3.96 }, // peak
        'deepseek-v4.1-flash': { cache_hit: 0.003, cache_miss: 0.15, output: 0.6 },
        'gemma4': { cache_hit: 0.05, cache_miss: 0.14, output: 0.4 },
    },
};
const api = build(pricing, ollama);

// DeepSeek native shape, native source.
const deepseek = api.usageFrom({
    model: 'deepseek-v4-pro',
    chat_completion_source: 'deepseek',
    usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100, completion_tokens: 50, total_tokens: 1050 },
});
assert.equal(deepseek.prompt_cache_hit_tokens, 900);
assert.equal(deepseek.prompt_cache_miss_tokens, 100);
assert.equal(api.providerFor(deepseek.model, deepseek.source), 'deepseek');
assert.equal(api.cost(deepseek), (900 * 0.022 + 100 * 0.66 + 50 * 1.98) / 1e6);

// Ollama via the custom OpenAI-compatible source, OpenAI shape, tagged model id.
const cloud = api.usageFrom({
    model: 'deepseek-v4-pro:cloud',
    chat_completion_source: 'custom',
    usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 }, completion_tokens: 50, total_tokens: 1050 },
});
assert.equal(api.providerFor(cloud.model, cloud.source), 'ollama', 'tagged cloud id must resolve to Ollama');
assert.equal(cloud.prompt_cache_hit_tokens, 900, 'cached_tokens must fold into cache_hit');
assert.equal(cloud.prompt_cache_miss_tokens, 100, 'miss must be derived from prompt - cached');
// Peak is live in the ollama stub, so the peak card must be used (1.32, not 0.66).
assert.equal(api.cost(cloud), (900 * 0.044 + 100 * 1.32 + 50 * 3.96) / 1e6);
assert.ok(api.cost(cloud) > api.cost(deepseek), 'peak Ollama pricing must exceed off-peak DeepSeek pricing');

// Ollama-only model, and an unpriceable one.
assert.equal(api.providerFor('gemma4:cloud', 'custom'), 'ollama');
assert.equal(api.usageFrom({ model: 'llama3', chat_completion_source: 'custom', usage: { prompt_tokens: 5 } }), null);
assert.equal(api.priceFor('llama3', 'custom'), null, 'unknown model must not borrow a rate card');

// Records stored before Ollama support have no source; those must stay DeepSeek.
assert.equal(api.providerFor('deepseek-v4-pro', undefined), 'deepseek');
assert.equal(api.cost({ model: 'deepseek-v4-pro', prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000, completion_tokens: 0 }), 0.66 / 1000);

console.log('provider-aware pricing: ok');
