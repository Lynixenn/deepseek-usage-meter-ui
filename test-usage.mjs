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
const body = [
    slice('const PRICE_ALIASES', 'const usageForMessage'),
    slice('function usageFrom(', 'function extractUsage('),
    slice('function extractUsage(', 'function requestUsage('),
    slice('function requestUsage(', 'function patchFetch('),
].join('\n');
const build = new Function('pricing', 'ollama', `${body}\nreturn { usageFrom, extractUsage, requestUsage, requestThinking, ollamaReasoningEffort, mergeBodyYaml, cost, providerFor, priceFor };`);

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

// Ollama's native metrics shape. The API now reports `prompt_eval_count` for the
// whole prompt and `prompt_eval_cached_count` for the cached part (optional in
// Ollama's types, so it can be absent), and `eval_count` for the output. These
// must fold onto the same fields the cost math uses; without this the meter
// showed every native-Ollama request as fully uncached.
const native = api.usageFrom({
    model: 'deepseek-v4-pro:cloud',
    chat_completion_source: 'custom',
    usage: { prompt_eval_count: 1000, prompt_eval_cached_count: 900, eval_count: 50 },
});
assert.ok(native, 'native metric shape must be captured');
assert.equal(native.prompt_tokens, 1000, 'prompt_eval_count maps to prompt_tokens');
assert.equal(native.prompt_cache_hit_tokens, 900, 'prompt_eval_cached_count maps to cache hit');
assert.equal(native.prompt_cache_miss_tokens, 100, 'miss must be prompt - cached');
assert.equal(native.completion_tokens, 50, 'eval_count maps to completion_tokens');
assert.equal(api.cost(native), (900 * 0.044 + 100 * 1.32 + 50 * 3.96) / 1e6,
    'native metrics must price identically to the shim shape');

// The cached count is optional: absent means nothing was served from cache, so
// the whole prompt bills at the miss rate rather than being dropped.
const noCacheField = api.usageFrom({
    model: 'deepseek-v4-pro:cloud', chat_completion_source: 'custom',
    usage: { prompt_eval_count: 400, eval_count: 10 },
});
assert.equal(noCacheField.prompt_cache_hit_tokens, 0);
assert.equal(noCacheField.prompt_cache_miss_tokens, 400);

// A provider reporting more cached than prompt tokens must clamp instead of
// producing a negative miss, which would subtract money from the total.
const overReported = api.usageFrom({
    model: 'deepseek-v4-pro:cloud', chat_completion_source: 'custom',
    usage: { prompt_eval_count: 100, prompt_eval_cached_count: 250, eval_count: 1 },
});
assert.equal(overReported.prompt_cache_hit_tokens, 100, 'cached must clamp to the prompt size');
assert.equal(overReported.prompt_cache_miss_tokens, 0, 'miss must never go negative');
assert.ok(api.cost(overReported) >= 0);

console.log('ollama native metrics shape: ok');

// ST rebuilds the upstream body from a fixed allow-list with no `stream_options`,
// so the flag must also travel via the Custom source's `custom_include_body` YAML
// - otherwise streamed Ollama replies carry no usage at all.
const ollamaStream = [
    'data: {"id":"chatcmpl-1","model":"deepseek-v4-pro","choices":[{"delta":{"content":"hi"}}]}',
    '',
    'data: {"id":"chatcmpl-1","model":"deepseek-v4-pro","choices":[],"usage":{"prompt_tokens":395,"prompt_tokens_details":{"cached_tokens":371},"completion_tokens":12,"total_tokens":407}}',
    '',
    'data: [DONE]',
    '',
].join('\n');

const cloudRequest = { model: 'deepseek-v4-pro:cloud', source: 'custom' };
const streamed = api.extractUsage(ollamaStream, cloudRequest);
assert.ok(streamed, 'streamed Ollama usage chunk must be captured');
assert.equal(streamed.prompt_cache_hit_tokens, 371, 'cached_tokens must map to cache_hit');
assert.equal(streamed.prompt_cache_miss_tokens, 24, 'miss must be prompt - cached');
assert.equal(streamed.completion_tokens, 12);
// The response body has no chat_completion_source; without the request context
// this model would fall back to the DeepSeek rate card and peak schedule.
assert.equal(streamed.source, 'custom');
assert.equal(api.providerFor(streamed.model, streamed.source), 'ollama');
const streamedCost = api.cost(streamed);
assert.equal(streamedCost, (371 * 0.044 + 24 * 1.32 + 12 * 3.96) / 1e6, 'must price on the Ollama peak card');
assert.ok(streamedCost < api.cost({ ...streamed, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 395 }), 'cache hits must be cheaper');

// requestUsage: YAML for the custom source, untouched for other sources.
const customBody = { stream: true, chat_completion_source: 'custom', custom_url: 'http://localhost:11434/v1', model: 'deepseek-v4-pro:cloud' };
api.requestUsage(customBody);
assert.equal(customBody.stream_options.include_usage, true);
assert.equal(customBody.custom_include_body, 'stream_options:\n  include_usage: true\n');
// Existing YAML must be preserved, and a user-set stream_options left alone.
const withYaml = { stream: true, chat_completion_source: 'custom', custom_url: 'http://localhost:11434/v1', model: 'deepseek-v4-pro:cloud', custom_include_body: 'temperature: 0.7\n' };
api.requestUsage(withYaml);
assert.equal(withYaml.custom_include_body, 'temperature: 0.7\nstream_options:\n  include_usage: true\n');
const preset = { ...customBody, custom_include_body: 'stream_options:\n  include_usage: false\n' };
api.requestUsage(preset);
assert.equal(preset.custom_include_body, 'stream_options:\n  include_usage: false\n', 'must not fight a user-set value');
// Non-Ollama custom endpoints and non-custom sources must not be touched.
const otherCustom = { stream: true, chat_completion_source: 'custom', custom_url: 'https://api.example.com/v1', model: 'gpt-5.5' };
api.requestUsage(otherCustom);
assert.equal(otherCustom.custom_include_body, undefined, 'must not inject into unrelated custom endpoints');
const deepseekBody = { stream: true, chat_completion_source: 'deepseek', model: 'deepseek-v4-pro' };
api.requestUsage(deepseekBody);
assert.equal(deepseekBody.custom_include_body, undefined, 'custom_include_body is custom-source only');

console.log('ollama stream capture + usage request injection: ok');

// Regression check for renderQuota. The balance endpoint changed: it used to
// answer with session/weekly percentage windows, and now reports USD credits
// (`included` allowance + `purchased`) with the legacy windows kept only for
// older plans. Both shapes must render, and the bar must clamp to 0..100% and
// flag the warning/exhausted states.
// renderQuota lives between its declaration and hasLegacyQuota; renderLegacyQuota
// sits between that and quotaPct, so they are sliced separately to avoid
// re-declaring the helpers that are injected here.
const quotaSrc = [
    slice('function renderQuota(', 'function hasLegacyQuota'),
    slice('function renderLegacyQuota(', 'const quotaPct'),
].join('\n');
const makeQuota = new Function('settings', 'ollamaQuota', 'document', 'money', 'hasLegacyQuota', 'quotaFrom', `${quotaSrc}\nreturn renderQuota;`);

const money = value => `$${Number(value ?? 0).toFixed(2)}`;
const quotaFromSrc = slice('function quotaFrom(', 'const n = value');
const quotaFrom = new Function(`${quotaFromSrc}\nreturn quotaFrom;`)();
const runQuota = (apiKey, raw) => {
    const node = { innerHTML: '' };
    const documentStub = { querySelector: sel => sel === '#dsum-quota' ? node : null };
    // Mirror the real module: the raw endpoint body is normalised first.
    const quota = quotaFrom(raw);
    makeQuota({ ollamaApiKey: apiKey }, quota, documentStub, money,
        () => quota.session != null || quota.weekly != null,
        quotaFrom)();
    return node.innerHTML;
};

// No key explains itself instead of drawing bars.
assert.match(runQuota('', null), /Add an Ollama API key/, 'no key should explain itself');
// A key with an unusable body says the balance is unavailable.
assert.match(runQuota('k', {}), /balance unavailable/);

// Current API: included allowance 100 with 72.50 left => 27.5% used.
const credits = runQuota('k', {
    included: { balance_usd: 72.5, allowance_usd: 100, period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' } },
    purchased: { balance_usd: 25 },
});
assert.match(credits, /width:27\.5%/, 'used fraction must be derived from allowance - balance');
assert.match(credits, /aria-valuenow="28"/, "aria value must be a rounded percent (27.5 rounds to 28)");
assert.match(credits, /27\.5% used/, 'aria-valuetext must read the percentage');
assert.match(credits, /\$72\.50/, 'remaining included credit must be shown');
assert.match(credits, /purchased \$25\.00/, 'purchased credit must be shown');
assert.equal((credits.match(/role="progressbar"/g) ?? []).length, 1, 'one credit bar');
assert.ok(!/dsum-quota-warn|dsum-quota-full/.test(credits), 'low usage must not warn');
// Purchased-only accounts have no allowance to divide by, and must not warn.
const purchasedOnly = runQuota('k', { purchased: { balance_usd: 25 } });
assert.match(purchasedOnly, /purchased \$25\.00/);
assert.ok(!/dsum-quota-warn|dsum-quota-full/.test(purchasedOnly), 'no allowance means no usage state');

// Nearly-exhausted allowance warns, and an overdrawn one clamps and flags.
assert.match(runQuota('k', { included: { balance_usd: 5, allowance_usd: 100 } }), /dsum-quota-warn/);
const overdrawn = runQuota('k', { included: { balance_usd: 0, allowance_usd: 100 } });
assert.match(overdrawn, /width:100\.0%/, 'width must clamp at 100%');
assert.match(overdrawn, /dsum-quota-full/);

// Legacy plans answer with remaining_percent (how much is LEFT), which must be
// inverted into a used fraction before it reaches the bars.
const legacy = runQuota('k', {
    included: {
        session: { remaining_percent: 25, resets_at: '2026-10-01T07:00:00Z' },
        weekly: { remaining_percent: 60, resets_at: '2026-10-05T00:00:00Z' },
    },
    purchased: { balance_usd: 25 },
});
assert.match(legacy, /width:75\.0%/, 'session: 25% remaining means 75% used');
assert.match(legacy, /width:40\.0%/, 'weekly: 60% remaining means 40% used');
assert.equal((legacy.match(/role="progressbar"/g) ?? []).length, 2, 'legacy shape keeps two bars');
// A nearly-spent session window must warn through the legacy path too.
assert.match(runQuota('k', { included: { session: { remaining_percent: 5 } } }), /dsum-quota-warn/);

console.log('renderQuota: credit balance, legacy windows, clamping, and states ok');

// quotaFrom: the two response shapes, and values that must stay null rather
// than becoming 0 (which would read as "fully unused").
const parseQuota = quotaFrom;
assert.deepEqual(parseQuota(undefined), {
    includedUsd: null, allowance: null, periodUntil: null, purchasedUsd: null, session: null, weekly: null,
}, 'a missing body must not fabricate a zero balance');
assert.equal(parseQuota({ included: { balance_usd: 0 } }).includedUsd, 0, 'a real zero must survive');
assert.equal(parseQuota({ included: { balance_usd: '72.5' } }).includedUsd, 72.5, 'numeric strings must parse');
assert.equal(parseQuota({ included: { balance_usd: null } }).includedUsd, null, 'null must not become 0');
assert.equal(parseQuota({ included: { period: { until: '2026-10-15T09:30:00Z' } } }).periodUntil, '2026-10-15T09:30:00Z');
// `usage` (0..1 used) wins when a server still sends the older field, and
// remaining_percent is inverted when only that is present.
assert.equal(parseQuota({ included: { session: { usage: 0.3 } } }).session, 0.3, 'usage is already a used fraction');
const eightyLeft = parseQuota({ included: { session: { remaining_percent: 80 } } }).session;
assert.ok(Math.abs(eightyLeft - 0.2) < 1e-9, '80% left is 20% used');
assert.equal(parseQuota({ included: { session: { remaining_percent: 0 } } }).session, 1, 'nothing left is fully used');

console.log('quotaFrom: balance parsing ok');

// mergeBodyYaml: every layout must stay valid YAML, or ST silently drops the
// user's whole Include body. Valid JSON is valid YAML, so the `{...}` case can be
// checked with JSON.parse.
const merged = api.mergeBodyYaml('{"top_a": 0.5}', { stream_options: { include_usage: true } });
assert.deepEqual(JSON.parse(merged), { top_a: 0.5, stream_options: { include_usage: true } });
assert.deepEqual(JSON.parse(api.mergeBodyYaml('{}', { reasoning_effort: 'high' })), { reasoning_effort: 'high' });
assert.equal(api.mergeBodyYaml('- a: 1\n', { reasoning_effort: 'high' }), '- a: 1\n- reasoning_effort: "high"\n');
assert.equal(api.mergeBodyYaml('reasoning_effort: low\n', { reasoning_effort: 'high' }), 'reasoning_effort: low\n', 'a value the user set wins');
assert.equal(api.mergeBodyYaml('{"reasoning_effort": "low"}', { reasoning_effort: 'high' }), '{"reasoning_effort": "low"}');

// Reasoning Effort reaches Ollama through Include body.
assert.equal(api.ollamaReasoningEffort(true, 'auto'), undefined, 'auto must leave the model default alone');
assert.equal(api.ollamaReasoningEffort(true, 'min'), 'low');
assert.equal(api.ollamaReasoningEffort(true, 'max'), 'max');
assert.equal(api.ollamaReasoningEffort(false, 'high'), 'none', 'Request model reasoning off turns thinking off');
const thinking = { chat_completion_source: 'custom', custom_url: 'http://localhost:11434/v1' };
api.requestThinking(thinking, { show_thoughts: true, reasoning_effort: 'high' });
assert.equal(thinking.custom_include_body, 'reasoning_effort: "high"\n');
const auto = { chat_completion_source: 'custom', custom_url: 'http://localhost:11434/v1' };
api.requestThinking(auto, { show_thoughts: true, reasoning_effort: 'auto' });
assert.equal(auto.custom_include_body, undefined);
const elsewhere = { chat_completion_source: 'custom', custom_url: 'http://localhost:1234/v1' };
api.requestThinking(elsewhere, { show_thoughts: true, reasoning_effort: 'high' });
assert.equal(elsewhere.custom_include_body, undefined, 'must not inject into unrelated custom endpoints');
const openai = { chat_completion_source: 'openai', custom_url: 'http://localhost:11434/v1' };
api.requestThinking(openai, { show_thoughts: true, reasoning_effort: 'high' });
assert.equal(openai.custom_include_body, undefined);
console.log('Ollama reasoning effort: all checks passed');
