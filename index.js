(() => {
    const KEY = 'deepseekUsageMeter';
    const defaults = {
        meterToken: '',
        ollamaApiKey: '',
        testMode: false,
    };

    const context = SillyTavern.getContext();
    const { eventSource, event_types, extensionSettings, SlashCommand, SlashCommandParser, renderExtensionTemplateAsync, Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup, stopGeneration } = context;
    extensionSettings[KEY] = { ...defaults, ...(extensionSettings[KEY] ?? {}) };
    const settings = extensionSettings[KEY];

    // Live pricing state, refreshed from the server plugin (which pulls it from deepseek.com).
    let pricing = {
        models: {},
        effective: {},
        peak: false,
        peakMultiplier: 2,
        peakHours: [],
        weekendOffPeak: false,
        beijingTime: '',
        source: 'fallback',
        fetchedAt: null,
    };

    // Ollama Cloud pricing from ollama.com (via the server plugin) and the
    // account's rolling quota windows, which need an Ollama API key.
    let ollama = {
        models: {},
        effective: {},
        peakModels: {},
        peak: false,
        peakMultiplier: 2,
        peakHours: [],
        peakDays: 'Mon-Fri',
        utcTime: '',
        source: 'fallback',
        fetchedAt: null,
    };
    let ollamaQuota = { session: null, weekly: null };

    // Balance state from the plugin's live /balance endpoint.
    let balance = { infos: [], isAvailable: true };

    // Model of the most recent captured message, highlighted in the price table.
    let lastModel = '';

    // Once-per-page-load peak pricing confirm; resets whenever SillyTavern is refreshed.
    let peakWarned = false;

    // Usage captured by intercepting ST's own chat-completions generate response.
    const GENERATE_URL = '/api/backends/chat-completions/generate';
    const capturedQueue = [];

    // Session-wide cache accounting (per browser session).
    const sessionStats = { requests: 0, hit: 0, miss: 0, saved: 0 };

    // Macros that re-expand per request and therefore break the cached prefix
    // when they sit in the system prompt / lorebook / character card.
    // History messages are macro-expanded once at send time and stored frozen,
    // so they are intentionally not scanned.
    const VOLATILE_PATTERNS = [
        { re: /\{\{\s*(?:date|time|datetime|yesterday|today|tomorrow|weekday|month|year|day|hour|minute|second|timestamp|isotimestamp)\s*(?::|\})/g, label: 'time/date' },
        { re: /\{\{\s*random\s*(?::|\})/g, label: 'random' },
        { re: /\{\{\s*roll\s*:/g, label: 'dice roll' },
        { re: /\{\{\s*(?:setvar|incvar|decvar|getvar|getglobalvar|setglobalvar|globalvar)\s*(?::|\})/g, label: 'variable' },
        { re: /\{\{\s*pipe\s*(?::|\})/g, label: 'pipe script' },
        { re: /\{\{\s*idle_duration\s*\}/g, label: 'idle duration' },
    ];

    // Vector icons (fill follows the theme via currentColor).
    const ICON_UPLOAD = '<path d="M7.33199 7.68464C6.94146 8.07517 6.3083 8.07517 5.91777 7.68464C5.52725 7.29412 5.52725 6.66095 5.91777 6.27043L10.5834 1.60483C11.3644 0.823781 12.6308 0.82378 13.4118 1.60483L18.0802 6.27327C18.4707 6.66379 18.4707 7.29696 18.0802 7.68748C17.6897 8.078 17.0565 8.078 16.666 7.68748L13 4.02145V21.9999C13 22.5522 12.5523 22.9999 12 22.9999C11.4477 22.9999 11 22.5522 11 21.9999V4.01666L7.33199 7.68464Z" fill="currentColor"/>';
    const ICON_CACHE = '<path fill-rule="evenodd" clip-rule="evenodd" d="M18.1716 1C18.702 1 19.2107 1.21071 19.5858 1.58579L22.4142 4.41421C22.7893 4.78929 23 5.29799 23 5.82843V20C23 21.6569 21.6569 23 20 23H4C2.34315 23 1 21.6569 1 20V4C1 2.34315 2.34315 1 4 1H18.1716ZM4 3C3.44772 3 3 3.44772 3 4V20C3 20.5523 3.44772 21 4 21L5 21L5 15C5 13.3431 6.34315 12 8 12L16 12C17.6569 12 19 13.3431 19 15V21H20C20.5523 21 21 20.5523 21 20V6.82843C21 6.29799 20.7893 5.78929 20.4142 5.41421L18.5858 3.58579C18.2107 3.21071 17.702 3 17.1716 3H17V5C17 6.65685 15.6569 8 14 8H10C8.34315 8 7 6.65685 7 5V3H4ZM17 21V15C17 14.4477 16.5523 14 16 14L8 14C7.44772 14 7 14.4477 7 15L7 21L17 21ZM9 3H15V5C15 5.55228 14.5523 6 14 6H10C9.44772 6 9 5.55228 9 5V3Z" fill="currentColor"/>';

    // Ollama's OpenAI shim reports the standard shape (`cached_tokens` nested in
    // `prompt_tokens_details`); DeepSeek reports the cache fields at the top level.
    function usageFrom(body) {
        const model = String(body.model || '');
        const usage = body.usage;
        if (!usage || !providerFor(model, body.chat_completion_source)) return null;
        const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
        return {
            model,
            source: body.chat_completion_source ?? '',
            prompt_tokens: usage.prompt_tokens ?? 0,
            prompt_cache_hit_tokens: hit,
            prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - hit),
            completion_tokens: usage.completion_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
            captured_at: new Date().toISOString(),
        };
    }

    function extractUsage(text) {
        // Non-streaming: the whole body is one JSON object.
        try {
            const json = JSON.parse(text);
            const usage = usageFrom(json);
            if (usage) return usage;
        } catch { /* fall through to SSE parsing */ }
        // Streaming: usage arrives in the last data chunk that carries it.
        let found = null;
        for (const line of String(text).split('\n')) {
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
            try {
                const usage = usageFrom(JSON.parse(line.slice(6)));
                if (usage) found = usage;
            } catch { /* malformed chunk */ }
        }
        return found;
    }

    function patchFetch() {
        const realFetch = window.fetch.bind(window);
        const patched = async function (input, init) {
            const url = typeof input === 'string' ? input : input?.url;
            const isGenerate = typeof url === 'string' && url.includes(GENERATE_URL);
            if (isGenerate && init && typeof init.body === 'string' && (init.method === undefined || init.method === 'POST')) {
                let parsed = null;
                try {
                    parsed = JSON.parse(init.body);
                } catch { /* body is not JSON */ }
                if (parsed) {
                    // DeepSeek only reports usage in streams when asked to.
                    if (parsed.stream) {
                        parsed.stream_options = { ...(parsed.stream_options || {}), include_usage: true };
                        init = { ...init, body: JSON.stringify(parsed) };
                    }
                    // Hold the request until the once-per-page-load peak confirm
                    // is answered; the request is not sent until Continue is clicked.
                    if (providerFor(parsed.model, parsed.chat_completion_source)) {
                        let go = true;
                        try {
                            go = await confirmPeakPricing(parsed.model, parsed.chat_completion_source);
                        } catch (error) {
                            console.debug('[DeepSeek Usage Meter]', error.message);
                        }
                        if (!go) {
                            cancelPeakGeneration();
                            throw new Error('Generation cancelled by user (peak pricing)');
                        }
                    }
                }
            }
            const response = await realFetch(input, init);
            if (isGenerate && response.ok) {
                response.clone().text()
                    .then(text => {
                        const usage = extractUsage(text);
                        if (usage) capturedQueue.push(usage);
                    })
                    .catch(() => { });
            }
            return response;
        };
        window.fetch = patched;
    }

    const n = value => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value ?? 0));
    const money = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 5 }).format(Number(value ?? 0));
    const priceMoney = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(Number(value ?? 0));
    const hmToMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
    const minToHm = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    // Peak hours arrive from the server in Beijing time (UTC+8); shift them into
    // the user's own timezone so the timeline reads 00-23 in local hours.
    const beijingToLocal = min => ((min - (480 + new Date().getTimezoneOffset())) % 1440 + 1440) % 1440;
    const utcToLocal = min => ((min - new Date().getTimezoneOffset()) % 1440 + 1440) % 1440;
    const localMinutesNow = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
    const beijingTimeNow = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
    // Beijing day-of-week (0=Sun..6=Sat). The pricing page makes weekends all
    // off-peak, so the peak timeline must not highlight any hour on those days.
    const beijingDayNow = () => new Date(Date.now() + 8 * 3600 * 1000).getUTCDay();
    const isBeijingWeekend = () => { const d = beijingDayNow(); return d === 0 || d === 6; };
    function buildTimeline(peakHours, nowMinutes, weekendOffPeak = false) {
        // On a weekend with the rule live, there are no peak hours to highlight.
        const windows = (weekendOffPeak && isBeijingWeekend())
            ? []
            : (peakHours ?? []).map(({ start, end }) => ({ start: beijingToLocal(hmToMin(start)), end: beijingToLocal(hmToMin(end)) }));
        return Array.from({ length: 24 }, (_, h) => {
            const start = h * 60, end = start + 60;
            const peak = windows.some(({ start: s, end: e }) => s <= e ? start < e && end > s : start < e || end > s);
            return { label: String(h).padStart(2, '0'), peak, now: nowMinutes >= start && nowMinutes < end };
        });
    }
    const headers = () => ({
        ...(settings.meterToken ? { 'x-meter-token': settings.meterToken } : {}),
        ...(settings.ollamaApiKey ? { 'x-ollama-key': settings.ollamaApiKey } : {}),
    });
    const meterUrl = path => `/api/plugins/deepseek-usage-meter${path}`;
    const balanceText = () => balance.infos.map(x => `${x.currency} ${x.total_balance}`).join(' · ') || 'No balance';

    // The API model id doesn't always equal the pricing page's column name: the
    // page header can carry a footnote (`deepseek-v4-pro(2)`), and the retired
    // Flash names now bill under `deepseek-flash`. Normalise both before the
    // fallback, otherwise the lookup silently prices an unrelated model.
    const PRICE_ALIASES = {
        'deepseek-v4-flash': 'deepseek-flash',
        'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    };
    // Ollama cloud ids carry a tag (`deepseek-v4-pro:cloud`) that the price tables
    // don't use, and DeepSeek page headers can carry a footnote.
    const priceKey = model => String(model || '')
        .replace(/:(?:cloud|latest)$/, '').replace(/-cloud$/, '').replace(/\(\d+\)\s*$/, '').trim();
    const lookup = (table, key) => table?.[key] ?? table?.[PRICE_ALIASES[key]];
    const inTable = (table, key) => Boolean(lookup(table, key));

    // Which rate card + peak schedule applies. The request source is authoritative
    // (`deepseek` is the native API, anything else reaching Ollama is a custom
    // OpenAI-compatible endpoint); the tables are the fallback.
    function providerFor(model, source) {
        if (source === 'deepseek') return 'deepseek';
        const key = priceKey(model);
        const inOllama = inTable(ollama.models, key) || inTable(ollama.effective, key);
        const inDeepseek = inTable(pricing.models, key) || inTable(pricing.effective, key);
        // Records stored before the Ollama support landed carry no source; keep the
        // original DeepSeek-first attribution for those instead of guessing Ollama.
        if (!source) return inDeepseek ? 'deepseek' : (inOllama ? 'ollama' : null);
        return inOllama ? 'ollama' : (inDeepseek ? 'deepseek' : null);
    }

    const peakFor = (model, source) => {
        const provider = providerFor(model, source);
        if (provider === 'ollama') return { peak: ollama.peak, multiplier: ollama.peakMultiplier };
        if (provider === 'deepseek') return { peak: pricing.peak, multiplier: pricing.peakMultiplier };
        return { peak: false, multiplier: 1 };
    };

    const priceFor = (model, source) => {
        const key = priceKey(model);
        const provider = providerFor(model, source);
        if (provider === 'ollama') return lookup(ollama.effective, key) ?? lookup(ollama.models, key) ?? null;
        if (provider === 'deepseek') {
            return lookup(pricing.effective, key) ?? lookup(pricing.models, key)
                ?? Object.values(pricing.effective)[0];
        }
        return null;
    };

    function cost(usage) {
        const p = priceFor(usage.model, usage.source);
        if (!p) return 0;
        return (usage.prompt_cache_hit_tokens * p.cache_hit
            + usage.prompt_cache_miss_tokens * p.cache_miss
            + usage.completion_tokens * p.output) / 1_000_000;
    }

    // Usage for the message's currently active swipe (falls back to the legacy single record).
    const usageForMessage = message => {
        if (!message?.extra) return null;
        const bySwipe = message.extra.deepseekUsageBySwipe;
        if (bySwipe) {
            const swipe = bySwipe[message.swipe_id ?? 0];
            if (swipe) return swipe;
        }
        return message.extra.deepseekUsage ?? null;
    };

    function chatTotals() {
        return (context.chat ?? []).reduce((acc, message) => {
            const usage = usageForMessage(message);
            if (!usage) return acc;
            acc.cost += Number(usage.calculated_cost_usd ?? 0);
            acc.tokens += Number(usage.total_tokens ?? 0);
            return acc;
        }, { cost: 0, tokens: 0 });
    }

    const costText = value => {
        const v = Number(value ?? 0);
        if (v === 0) return '$0';
        if (v >= 0.01) return `$${v.toFixed(2)}`;
        if (v >= 0.0001) return `$${v.toFixed(4)}`;
        // Tiny costs: 2 significant decimals via toFixed, never exponential (9.5e-5 reads badly).
        const decimals = Math.min(10, Math.ceil(-Math.log10(v)) + 2);
        return `$${v.toFixed(decimals)}`;
    };

    const escapeHtml = value => String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const sessionCacheText = () => {
        const total = sessionStats.hit + sessionStats.miss;
        const pct = total ? Math.round((sessionStats.hit / total) * 100) : 0;
        return `${sessionStats.requests} request${sessionStats.requests === 1 ? '' : 's'} · ${pct}% cached (${n(sessionStats.hit)}/${n(total)} tokens) · saved ${costText(sessionStats.saved)} vs no cache`;
    };

    // Only sources that re-expand every request can break the prefix:
    // the system prompt (chat[0], substituteParams'd each generation), lorebook
    // entries, and character card fields. Frozen history messages are excluded.
    function auditPrompt() {
        const sources = [];
        if (context.chat?.[0]?.mes) sources.push({ name: 'System prompt', text: context.chat[0].mes });
        for (const [key, entry] of Object.entries(context.worldInfo?.entries ?? {})) {
            if (entry?.content) sources.push({ name: `Lorebook: ${entry.name || key}`, text: entry.content });
        }
        const char = context.characters?.[context.charId];
        if (char) {
            for (const field of ['description', 'scenario', 'personality']) {
                if (char[field]) sources.push({ name: `Character card: ${field}`, text: char[field] });
            }
        }
        const findings = [];
        for (const src of sources) {
            const found = new Map(); // label -> { count, at }
            for (const { re, label } of VOLATILE_PATTERNS) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(src.text))) {
                    const cur = found.get(label) ?? { count: 0, at: m.index };
                    cur.count++;
                    found.set(label, cur);
                }
            }
            for (const [label, info] of found) {
                const start = Math.max(0, info.at - 30);
                const end = Math.min(src.text.length, info.at + 30);
                const snippet = `${start > 0 ? '…' : ''}${escapeHtml(src.text.slice(start, end))}${end < src.text.length ? '…' : ''}`;
                findings.push({ location: src.name, label, count: info.count, snippet });
            }
        }
        return findings;
    }

    const auditHtml = () => {
        const findings = auditPrompt();
        if (!findings.length) return '';
        return findings.map(f =>
            `<div class="dsum-finding"><span class="dsum-bad">${f.label} ×${f.count}</span> - ${escapeHtml(f.location)}<code>${f.snippet}</code></div>`,
        ).join('');
    };

    function render(messageId) {
        const message = context.chat?.[messageId];
        const usage = usageForMessage(message);
        const node = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!node || !usage) return;
        node.querySelector('.dsum-mes-stats')?.remove();
        node.querySelector('.dsum-msg-cost')?.remove();
        const value = usage.calculated_cost_usd ?? cost(usage);
        const peak = usage.peak ? usage.peakMultiplier ?? 2 : null;
        const hitTotal = (usage.prompt_cache_hit_tokens ?? 0) + (usage.prompt_cache_miss_tokens ?? 0);
        const hitPct = hitTotal ? `${Math.round((usage.prompt_cache_hit_tokens / hitTotal) * 100)}%` : '-';
        const title = [
            `Model ${usage.model || 'unknown'}`,
            `In ${n((usage.prompt_tokens ?? 0) - (usage.prompt_cache_hit_tokens ?? 0))} · Cached ${n(usage.prompt_cache_hit_tokens)} · Miss ${n(usage.prompt_cache_miss_tokens)}`,
            `Out ${n(usage.completion_tokens)} · Total ${n(usage.total_tokens)} · Hit ${hitPct}`,
            `Cost ${costText(value)} · Balance ${balanceText()}`,
            peak ? `Peak ×${peak} - click for details` : 'Click for details',
        ].join('\n');
        // Avatar column, right under the core token counter (.tokenCounterDisplay).
        const wrapper = node.querySelector('.mesAvatarWrapper');
        if (wrapper) {
            wrapper.insertAdjacentHTML('beforeend', `
            <div class="dsum-mes-stats" role="img" aria-label="${title}" title="${title}">
                <div class="dsum-mes-row"><svg viewBox="0 0 24 24">${ICON_UPLOAD}</svg><span>${n((usage.prompt_tokens ?? 0) - (usage.prompt_cache_hit_tokens ?? 0))}</span></div>
                <div class="dsum-mes-row"><svg viewBox="0 0 24 24">${ICON_CACHE}</svg><span>${n(usage.prompt_cache_hit_tokens)}</span></div>
            </div>`);
            node.querySelector('.dsum-mes-stats').addEventListener('click', event => { event.stopPropagation(); openUsagePopup(); });
        }
        // Cost sits in the message header next to the model icon (timestamp-icon),
        // away from ST's absolutely-positioned swipe counter at the bottom-right.
        const modelIcon = node.querySelector('.ch_name .timestamp-icon');
        const headerAnchor = modelIcon || node.querySelector('.ch_name .timestamp') || node.querySelector('.ch_name .name_text');
        if (headerAnchor) {
            headerAnchor.insertAdjacentHTML('afterend', `<span class="dsum-msg-cost${peak ? ' dsum-peak-cost' : ''}" title="${title}">${costText(value)}${peak ? ` · PEAK ×${peak}` : ''}</span>`);
            node.querySelector('.dsum-msg-cost').addEventListener('click', event => { event.stopPropagation(); openUsagePopup(); });
        }
    }

    async function takeUsage() {
        // The streamed response finishes a moment after GENERATION_ENDED fires, so wait briefly.
        for (let i = 0; i < 20; i++) {
            if (capturedQueue.length) return capturedQueue.shift();
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return null;
    }

    async function attachLatestUsage() {
        try {
            const usage = await takeUsage();
            if (!usage) return;
            const lastId = context.chat.length - 1;
            const message = context.chat[lastId];
            if (!message || message.is_user) return;
            message.extra ??= {};
            const { peak, multiplier } = peakFor(usage.model, usage.source);
            const record = {
                ...usage,
                peak,
                peakMultiplier: multiplier,
                calculated_cost_usd: cost(usage),
            };
            lastModel = usage.model;
            // Keep one record per swipe so each variant shows its own tokens/cost.
            message.extra.deepseekUsageBySwipe ??= {};
            message.extra.deepseekUsageBySwipe[message.swipe_id ?? 0] = record;
            message.extra.deepseekUsage = record; // current swipe; legacy fallback
            const p = priceFor(usage.model, usage.source);
            if (p) {
                sessionStats.requests++;
                sessionStats.hit += usage.prompt_cache_hit_tokens;
                sessionStats.miss += usage.prompt_cache_miss_tokens;
                sessionStats.saved += usage.prompt_cache_hit_tokens * (p.cache_miss - p.cache_hit) / 1_000_000;
            }
            context.saveChat?.();
            render(lastId);
            renderChatTotals();
            refreshBalance(); // keep the balance display current after spending
        } catch (error) {
            console.debug('[DeepSeek Usage Meter]', error.message);
        }
    }

    async function refreshBalance() {
        try {
            const response = await fetch(meterUrl('/balance'), { headers: headers() });
            if (!response.ok) throw new Error(`Balance request returned ${response.status}`);
            const body = await response.json();
            balance = { infos: body.balance_infos ?? [], isAvailable: body.is_available !== false };
            const output = document.querySelector('#dsum-balance');
            if (output) {
                output.textContent = balanceText();
                output.classList.toggle('dsum-bad', !balance.isAvailable);
            }
        } catch (error) {
            balance = { infos: [], isAvailable: false };
            const output = document.querySelector('#dsum-balance');
            if (output) {
                output.textContent = 'Balance unavailable';
                output.classList.add('dsum-bad');
            }
            console.debug('[DeepSeek Usage Meter]', error.message);
        }
        await refreshOllamaQuota();
        updateWand();
    }

    function renderPricing() {
        const node = document.querySelector('#dsum-pricing');
        if (!node) return;
        const todayOffPeak = pricing.weekendOffPeak && isBeijingWeekend();
        const status = pricing.peak
            ? `Peak pricing active - prices ×${pricing.peakMultiplier} (Beijing ${pricing.beijingTime})`
            : todayOffPeak
                ? `Off-peak pricing (Beijing ${pricing.beijingTime}) - weekend off-peak all day`
                : `Off-peak pricing (Beijing ${pricing.beijingTime})`;
        const schedule = todayOffPeak ? '' : (pricing.peakHours ?? []).map(({ start, end }) => `${minToHm(beijingToLocal(hmToMin(start)))}–${minToHm(beijingToLocal(hmToMin(end)))}`).join(' · ');
        const rows = Object.entries(pricing.models).map(([model, p]) => {
            const e = pricing.effective[model] ?? p;
            return `<div class="dsum-model"><b>${model}</b><span>in ${priceMoney(e.cache_miss)}/1M · cached ${priceMoney(e.cache_hit)}/1M · out ${priceMoney(e.output)}/1M</span></div>`;
        }).join('');
        node.innerHTML = `<div class="dsum-status">${status}</div>${schedule ? `<div class="dsum-schedule">Peak hours (your time): ${schedule}</div>` : ''}${rows}<small>Prices fetched from deepseek.com · source: ${pricing.source}${pricing.fetchedAt ? ` · ${new Date(pricing.fetchedAt).toLocaleTimeString()}` : ''}</small>`;
        updateStatusline();
        updateWand();
    }

    function updateStatusline() {
        const state = document.querySelector('#dsum-peak-state');
        if (state) {
            state.textContent = pricing.peak ? `Peak ×${pricing.peakMultiplier}` : 'Off-peak';
            state.className = `dsum-peak-state ${pricing.peak ? 'dsum-bad' : 'dsum-ok'}`;
        }
        const clock = document.querySelector('#dsum-bj-clock');
        if (clock) clock.textContent = `Beijing ${beijingTimeNow()}`;
    }

    function renderOllamaPricing() {
        const node = document.querySelector('#dsum-ollama-pricing');
        if (!node) return;
        if (!Object.keys(ollama.models).length) {
            node.innerHTML = '<small>Ollama prices unavailable</small>';
            return;
        }
        const status = ollama.peak
            ? `Ollama peak pricing active - prices ×${ollama.peakMultiplier} (UTC ${ollama.utcTime})`
            : `Ollama off-peak (UTC ${ollama.utcTime})`;
        const rule = `peak ${ollama.peakDays} ${(ollama.peakHours ?? []).map(({ start, end }) => `${minToHm(utcToLocal(hmToMin(start)))}–${minToHm(utcToLocal(hmToMin(end)))}`).join(' · ')} (your time)`;
        const rows = Object.entries(ollama.models).map(([model, p]) => {
            const e = ollama.effective[model] ?? p;
            return `<div class="dsum-model"><b>${model}</b><span>in ${priceMoney(e.cache_miss)}/1M · cached ${priceMoney(e.cache_hit)}/1M · out ${priceMoney(e.output)}/1M</span></div>`;
        }).join('');
        node.innerHTML = `<div class="dsum-status">${status}${ollama.peak ? '' : ` · ${rule}`}</div>${rows}<small>Prices fetched from ollama.com · source: ${ollama.source}${ollama.fetchedAt ? ` · ${new Date(ollama.fetchedAt).toLocaleTimeString()}` : ''}</small>`;
    }

    const quotaPct = value => value == null ? '-' : `${(Number(value) * 100).toFixed(1)}%`;
    const quotaText = () => ollamaQuota.session == null
        ? (settings.ollamaApiKey ? 'Ollama quota unavailable' : 'Ollama API key not set')
        : `Ollama ${quotaPct(ollamaQuota.session)} of 5h · ${quotaPct(ollamaQuota.weekly)} of 7d`;

    async function refreshOllamaQuota() {
        if (!settings.ollamaApiKey) {
            ollamaQuota = { session: null, weekly: null };
        } else {
            try {
                const response = await fetch(meterUrl('/ollama/usage'), { headers: headers() });
                if (!response.ok) throw new Error(`Ollama usage returned ${response.status}`);
                const body = await response.json();
                ollamaQuota = {
                    session: body?.limits?.session?.usage ?? null,
                    weekly: body?.limits?.weekly?.usage ?? null,
                };
            } catch (error) {
                ollamaQuota = { session: null, weekly: null };
                console.debug('[DeepSeek Usage Meter]', error.message);
            }
        }
        const node = document.querySelector('#dsum-ollama-quota');
        if (node) node.textContent = quotaText();
    }

    async function fetchOllamaPricing() {
        try {
            const response = await fetch(meterUrl('/ollama/pricing'), { headers: headers() });
            if (!response.ok) throw new Error(`Ollama pricing request returned ${response.status}`);
            const body = await response.json();
            ollama = { ...ollama, ...body, effective: body.effective ?? body.models };
        } catch (error) {
            ollama = { ...ollama, source: 'fallback' };
            console.debug('[DeepSeek Usage Meter]', error.message);
        }
        renderOllamaPricing();
        updateWand();
    }

    function updateWand() {
        const btn = document.querySelector('#dsum_wand_button');
        if (!btn) return;
        btn.title = [
            `DeepSeek usage & balance - ${balanceText()}${pricing.peak ? ` · PEAK ×${pricing.peakMultiplier}` : ''}`,
            `Ollama Cloud${ollama.peak ? ` · PEAK ×${ollama.peakMultiplier}` : ''}${ollamaQuota.session == null ? '' : ` · ${quotaText()}`}`,
        ].join('\n');
    }

    // Once-per-page-load confirm when a generation starts during peak pricing.
    // Called from the fetch patch, which HOLDS the request until the user answers,
    // so nothing is sent to the server before Continue is clicked. Returns false
    // when the user cancels and the request must be dropped.
    // Test mode: asks on every generation, ignoring peak state and the page-load
    // gate, so the flow can be tried at any time.
    async function confirmPeakPricing(model, source) {
        const provider = providerFor(model, source);
        const { peak, multiplier } = peakFor(model, source);
        const label = provider === 'ollama' ? 'Ollama' : 'DeepSeek';
        const clock = provider === 'ollama' ? `UTC ${ollama.utcTime}` : `Beijing ${pricing.beijingTime}`;
        if (!settings.testMode) {
            if (peakWarned) return true;
            // Only warn when the peak state is actually known.
            const fetchedAt = provider === 'ollama' ? ollama.fetchedAt : pricing.fetchedAt;
            if (!fetchedAt || !peak) return true;
            peakWarned = true;
        }
        const status = peak
            ? `${label} prices are currently <b>×${multiplier}</b> during peak hours (${clock}).`
            : `${label} is currently off-peak.`;
        const title = settings.testMode ? 'Peak confirm (test mode)' : `${label} peak pricing active`;
        const note = settings.testMode ? ' Test mode is on, so every generation is held for confirmation.' : '';
        const confirmed = await callGenericPopup(
            `<h3>${title}</h3><p>${status}${note} Continue generating?</p>`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Continue', cancelButton: 'Cancel' },
        );
        return confirmed === POPUP_RESULT.AFFIRMATIVE;
    }

    // Cancels a held generation: the request never went out, so abort ST's
    // in-flight state (same path as the Stop button) and re-enable the UI.
    function cancelPeakGeneration() {
        if (typeof stopGeneration === 'function') stopGeneration();
        if (typeof context.activateSendButtons === 'function') context.activateSendButtons();
    }

    function renderChatTotals() {
        const node = document.querySelector('#dsum-chat-total');
        if (!node) return;
        const totals = chatTotals();
        node.textContent = `${money(totals.cost)} · ${n(totals.tokens)} tokens`;
        const session = document.querySelector('#dsum-session');
        if (session) session.textContent = sessionCacheText();
    }

    async function fetchPricing() {
        try {
            const response = await fetch(meterUrl('/pricing'), { headers: headers() });
            if (!response.ok) throw new Error(`Pricing request returned ${response.status}`);
            const body = await response.json();
            pricing = { ...pricing, ...body, effective: body.effective ?? body.models };
        } catch (error) {
            pricing = { ...pricing, source: 'fallback' };
            console.debug('[DeepSeek Usage Meter]', error.message);
        }
        renderPricing();
    }

    // Renders the popup HTML from the currently cached pricing/balance state.
    // No network calls here - the data was refreshed on a timer and after each
    // generation, so the popup can appear instantly.
    async function buildPopupHtml() {
        const activeKey = priceKey(lastModel);
        const rowsFor = (table, effective) => Object.entries(table).map(([model, p]) => {
            const e = effective[model] ?? p;
            return { model, cacheHit: priceMoney(e.cache_hit), cacheMiss: priceMoney(e.cache_miss), output: priceMoney(e.output), current: model === activeKey };
        });
        const priceRows = [
            { group: 'DeepSeek API' }, ...rowsFor(pricing.models, pricing.effective),
            { group: 'Ollama Cloud' }, ...rowsFor(ollama.models, ollama.effective),
        ];
        const totals = chatTotals();
        return renderExtensionTemplateAsync('third-party/deepseek-usage-meter-ui', 'popup', {
            balanceText: balanceText(),
            isAvailable: balance.isAvailable,
            peak: pricing.peak,
            peakText: pricing.peak
                ? `Peak pricing ×${pricing.peakMultiplier}`
                : (pricing.weekendOffPeak && isBeijingWeekend()) ? 'Off-peak pricing · weekend' : 'Off-peak pricing',
            beijingTime: beijingTimeNow(),
            timeline: buildTimeline(pricing.peakHours, localMinutesNow(), pricing.weekendOffPeak),
            ollamaPeak: ollama.peak,
            ollamaPeakText: ollama.peak
                ? `Ollama peak ×${ollama.peakMultiplier}`
                : `Ollama off-peak (UTC ${ollama.utcTime})`,
            quotaText: quotaText(),
            priceRows,
            chatCost: money(totals.cost),
            chatTokens: n(totals.tokens),
            sessionText: sessionCacheText(),
            auditHtml: auditHtml(),
            source: pricing.source,
            ollamaSource: ollama.source,
            fetchedAt: pricing.fetchedAt ? new Date(pricing.fetchedAt).toLocaleTimeString() : '',
        });
    }

    // Refreshes pricing/balance and, if the popup is still open, re-renders its
    // content in place (the refresh button inside the popup uses this too).
    async function refreshPopupContent(popup) {
        await Promise.all([fetchPricing(), fetchOllamaPricing(), refreshBalance()]);
        if (popup.dlg?.open) {
            popup.content.innerHTML = await buildPopupHtml();
            wirePopupRefresh(popup);
        }
    }

    // The popup HTML is sanitized by DOMPurify, so no inline handlers survive;
    // wire the refresh button explicitly after every render instead.
    function wirePopupRefresh(popup) {
        const btn = popup.content.querySelector('#dsum-popup-refresh');
        if (btn && !btn.dataset.dsumWired) {
            btn.dataset.dsumWired = '1';
            btn.addEventListener('click', () => refreshPopupContent(popup));
        }
    }

    async function openUsagePopup() {
        // Show the popup right away from cached data; refresh prices and balance
        // in the background and update the open popup in place when they land.
        const popup = new Popup(await buildPopupHtml(), POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
        wirePopupRefresh(popup);
        const shown = popup.show();
        refreshPopupContent(popup).catch(error => console.debug('[DeepSeek Usage Meter]', error.message));
        return shown;
    }

    function addWandButton() {
        const menu = document.querySelector('#extensionsMenu');
        if (!menu) return;
        if (document.querySelector('#dsum_wand_container')) return;
        const container = document.createElement('div');
        container.id = 'dsum_wand_container';
        container.className = 'extension_container';
        container.innerHTML = `
            <div id="dsum_wand_button" class="list-group-item flex-container flexGap5 interactable" title="DeepSeek usage & balance">
                <div class="fa-solid fa-coins extensionsMenuExtensionButton"></div>
                <span>DeepSeek Usage</span>
            </div>`;
        menu.appendChild(container);
        container.querySelector('#dsum_wand_button').addEventListener('click', openUsagePopup);
    }

    function addSettings() {
        $('#extensions_settings').append(`
          <div id="dsum-settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>DeepSeek Usage Meter</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
              <div class="dsum-statusline">
                <span id="dsum-peak-state" class="dsum-peak-state dsum-ok">Off-peak</span>
                <span id="dsum-bj-clock" class="dsum-clock">Beijing -</span>
              </div>
              <div id="dsum-pricing" class="dsum-pricing"></div>
              <div class="dsum-statusline">
                <span class="dsum-peak-state dsum-ok">Ollama Cloud</span>
                <span id="dsum-ollama-quota" class="dsum-clock">-</span>
              </div>
              <div id="dsum-ollama-pricing" class="dsum-pricing"></div>
              <label class="dsum-token-row">Ollama API key (quota only)
                <span class="dsum-token-wrap"><input id="dsum-ollama-key" class="text_pole" type="password"><button id="dsum-ollama-key-toggle" class="menu_button dsum-token-toggle" type="button" title="Show/hide key"><i class="fa-solid fa-eye"></i></button></span>
              </label>
              <div class="dsum-grid">
                <div class="dsum-total">This chat: <b id="dsum-chat-total"></b></div>
                <div class="dsum-total">Cache session: <b id="dsum-session"></b></div>
              </div>
              <div class="dsum-actions">
                <button id="dsum-refresh" class="menu_button"><i class="fa-solid fa-rotate"></i> Refresh balance &amp; prices</button>
                <span id="dsum-balance" class="dsum-balance"></span>
              </div>
              <label class="dsum-token-row">Meter token (optional)
                <span class="dsum-token-wrap"><input id="dsum-token" class="text_pole" type="password"><button id="dsum-token-toggle" class="menu_button dsum-token-toggle" type="button" title="Show/hide token"><i class="fa-solid fa-eye"></i></button></span>
              </label>
              <label class="dsum-check-row">Peak confirm test mode
                <input id="dsum-test-mode" type="checkbox">
              </label>
              <small>Holds every priced generation and asks to continue, so you can test the peak confirm outside peak hours.</small>
              <div class="dsum-hint">Per-message usage (cost, cached/missed tokens) is captured automatically from SillyTavern's chat-completion response. DeepSeek needs the native <code>deepseek</code> source on <code>api.deepseek.com</code>; Ollama Cloud goes through a custom OpenAI-compatible source pointed at <code>localhost:11434/v1</code> (its OpenAI shim reports cached tokens). Click any per-message cost or token stats for the full view.</div>
            </div>
          </div>`);
        for (const [inputId, toggleId, key, onChange] of [
            ['#dsum-token', '#dsum-token-toggle', 'meterToken', null],
            ['#dsum-ollama-key', '#dsum-ollama-key-toggle', 'ollamaApiKey', refreshOllamaQuota],
        ]) {
            const input = document.querySelector(inputId);
            const toggle = document.querySelector(toggleId);
            input.value = settings[key];
            input.addEventListener('input', () => {
                settings[key] = input.value;
                context.saveSettingsDebounced();
            });
            if (onChange) input.addEventListener('change', () => onChange());
            toggle.addEventListener('click', () => {
                const show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                toggle.querySelector('i').className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
            });
        }
        const testMode = document.querySelector('#dsum-test-mode');
        testMode.checked = !!settings.testMode;
        testMode.addEventListener('change', () => {
            settings.testMode = testMode.checked;
            if (!settings.testMode) peakWarned = false; // real-mode confirm is fresh again
            context.saveSettingsDebounced();
        });
        document.querySelector('#dsum-refresh').addEventListener('click', () => { refreshBalance(); fetchPricing(); fetchOllamaPricing(); });
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dsum',
        callback: async () => { await openUsagePopup(); return ''; },
        returns: 'opens the DeepSeek usage & balance popup',
        helpString: 'Opens a popup with DeepSeek balance, live prices, peak-hour status, and this chat\'s usage totals.',
    }));

    patchFetch();
    addSettings();
    addWandButton();
    fetchPricing();
    fetchOllamaPricing();
    refreshBalance();
    renderChatTotals();
    setInterval(fetchPricing, 10 * 60 * 1000); // keep peak-hour detection current across session
    setInterval(fetchOllamaPricing, 10 * 60 * 1000);
    setInterval(() => { refreshBalance(); updateStatusline(); }, 10 * 60 * 1000); // keep balance/quota + clocks fresh
    setInterval(updateStatusline, 30 * 1000); // Beijing clock tick
    eventSource.on(event_types.APP_READY, addWandButton); // auto-fires if the app is already ready
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, render);
    eventSource.on(event_types.MESSAGE_SWIPED, mesId => render(mesId)); // each swipe shows its own usage
    eventSource.on(event_types.GENERATION_ENDED, attachLatestUsage);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        context.chat.forEach((_, i) => render(i));
        renderChatTotals();
    });
})();
