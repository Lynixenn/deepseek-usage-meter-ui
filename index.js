(() => {
    const KEY = 'deepseekUsageMeter';
    const defaults = {
        meterToken: '',
    };

    // Fallback prices (USD per 1M tokens) used only while the plugin's /pricing endpoint is unreachable.
    const fallbackModels = {
        'deepseek-v4-flash': { cache_hit: 0.0028, cache_miss: 0.14, output: 0.28 },
        'deepseek-v4-pro': { cache_hit: 0.003625, cache_miss: 0.435, output: 0.87 },
    };

    const context = SillyTavern.getContext();
    const { eventSource, event_types, extensionSettings, SlashCommand, SlashCommandParser, renderExtensionTemplateAsync, callGenericPopup, POPUP_TYPE } = context;
    extensionSettings[KEY] = { ...defaults, ...(extensionSettings[KEY] ?? {}) };
    const settings = extensionSettings[KEY];

    // Live pricing state, refreshed from the server plugin (which pulls it from deepseek.com).
    let pricing = {
        models: fallbackModels,
        effective: fallbackModels,
        peak: false,
        peakMultiplier: 2,
        peakHours: [],
        beijingTime: '',
        source: 'fallback',
        fetchedAt: null,
    };

    // Balance state from the plugin's live /balance endpoint.
    let balance = { infos: [], isAvailable: true };

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
    const ICON_DATABASE = '<path d="M 300 0 C 221.30245 0 150.09841 8.0113158 97.068359 21.535156 C 70.553346 28.297076 48.605538 36.277916 31.677734 46.484375 C 16.579982 55.587421 3.2445893 67.928721 0.53125 85 L 0 85 L 0 90 C 0 95.160045 3.6392602 102.94345 17.03125 112.83789 C 30.423241 122.73233 52.11942 133.00486 79.691406 141.62109 C 134.83535 158.85361 213.32376 170 300 170 C 386.67624 170 465.16467 158.85361 520.30859 141.62109 C 547.8806 133.00486 569.57675 122.73233 582.96875 112.83789 C 596.36075 102.94345 600 95.160045 600 90 L 599.87305 90 C 599.19452 70.318664 584.84711 56.447884 568.32227 46.484375 C 551.39442 36.277916 529.44664 28.297076 502.93164 21.535156 C 449.90159 8.0113158 378.69755 0 300 0 z M 0 149.67969 L 0 234.10742 C 0.70499641 239.21983 4.6599347 246.30446 16.722656 255.2168 C 30.11466 265.11125 51.810798 275.38376 79.382812 284 C 134.52681 301.23251 213.01506 312.37891 299.69141 312.37891 C 386.36774 312.37891 464.85602 301.23251 520 284 C 547.57201 275.38376 569.26815 265.11125 582.66016 255.2168 C 596.05215 245.32235 599.69141 237.53895 599.69141 232.37891 L 600 232.37891 L 600 149.67969 C 581.93283 161.57337 559.1282 171.3983 532.24023 179.80078 C 471.56758 198.761 390.05399 210 300 210 C 209.94601 210 128.43244 198.761 67.759766 179.80078 C 40.871811 171.3983 18.067172 161.57337 0 149.67969 z M 600 291.79688 C 590.25148 298.2521 579.18165 304.12941 566.75 309.46875 C 556.06951 314.05598 544.44003 318.27081 531.93164 322.17969 C 471.2589 341.13992 389.74549 352.37891 299.69141 352.37891 C 209.63733 352.37891 128.12391 341.13993 67.451172 322.17969 C 40.720883 313.82647 18.016718 304.0712 0 292.27148 L 0 380 C 0 385.16005 3.6392334 392.94343 17.03125 402.83789 C 30.423267 412.73235 52.119364 423.00484 79.691406 431.62109 C 134.83545 448.85363 213.32358 460 300 460 C 386.67642 460 465.16455 448.85363 520.30859 431.62109 C 547.88068 423.00484 569.57666 412.73235 582.96875 402.83789 C 596.36074 392.94343 600 385.16005 600 380 L 600 291.79688 z M 0 439.67969 L 0 508.59375 L 0 515 L 0.53125 515 C 3.2445947 532.0713 16.579952 544.41257 31.677734 553.51562 C 48.605572 563.7221 70.553292 571.70292 97.068359 578.46484 C 150.09851 591.98873 221.30229 600 300 600 C 378.69771 600 449.90149 591.98873 502.93164 578.46484 C 529.4467 571.70292 551.3944 563.7221 568.32227 553.51562 C 583.42003 544.41257 596.7554 532.0713 599.46875 515 L 600 515 L 600 508.59375 L 600 439.67969 C 581.93278 451.57339 559.1283 461.39828 532.24023 469.80078 C 471.56747 488.76104 390.05417 500 300 500 C 209.94583 500 128.43256 488.76104 67.759766 469.80078 C 40.871757 461.39828 18.067208 451.57339 0 439.67969 z" fill="currentColor"/>';

    function usageFrom(body) {
        const model = String(body.model || '');
        if (!model.includes('deepseek') || !body.usage) return null;
        return {
            model,
            prompt_tokens: body.usage.prompt_tokens ?? 0,
            prompt_cache_hit_tokens: body.usage.prompt_cache_hit_tokens ?? 0,
            prompt_cache_miss_tokens: body.usage.prompt_cache_miss_tokens ?? 0,
            completion_tokens: body.usage.completion_tokens ?? 0,
            total_tokens: body.usage.total_tokens ?? 0,
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
                // DeepSeek only reports usage in streams when asked to.
                try {
                    const parsed = JSON.parse(init.body);
                    if (parsed.stream) {
                        parsed.stream_options = { ...(parsed.stream_options || {}), include_usage: true };
                        init = { ...init, body: JSON.stringify(parsed) };
                    }
                } catch { /* body is not JSON */ }
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
        patched.__dsumPatched = true;
        window.fetch = patched;
    }

    const n = value => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value ?? 0));
    const money = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 5 }).format(Number(value ?? 0));
    const headers = () => settings.meterToken ? { 'x-meter-token': settings.meterToken } : {};
    const meterUrl = path => `/api/plugins/deepseek-usage-meter${path}`;
    const balanceText = () => balance.infos.map(x => `${x.currency} ${x.total_balance}`).join(' · ') || 'No balance';

    const priceFor = model => pricing.effective[model]
        ?? pricing.models[model]
        ?? Object.values(pricing.effective)[0]
        ?? fallbackModels['deepseek-v4-flash'];

    function cost(usage) {
        const p = priceFor(usage.model);
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
            `<div class="dsum-finding"><span class="dsum-bad">${f.label} ×${f.count}</span> — ${escapeHtml(f.location)}<code>${f.snippet}</code></div>`,
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
        const peak = usage.peak ? usage.peakMultiplier ?? pricing.peakMultiplier : null;
        const hitTotal = (usage.prompt_cache_hit_tokens ?? 0) + (usage.prompt_cache_miss_tokens ?? 0);
        const hitPct = hitTotal ? `${Math.round((usage.prompt_cache_hit_tokens / hitTotal) * 100)}%` : '—';
        const title = `Model ${usage.model || 'unknown'} · In ${n((usage.prompt_tokens ?? 0) - (usage.prompt_cache_hit_tokens ?? 0))} · Cached ${n(usage.prompt_cache_hit_tokens)} · Miss ${n(usage.prompt_cache_miss_tokens)} · Out ${n(usage.completion_tokens)} · Total ${n(usage.total_tokens)} · Hit ${hitPct} · Balance ${balanceText()}${peak ? ` · Peak ×${peak}` : ''}`;
        // Avatar column, right under the core token counter (.tokenCounterDisplay).
        const wrapper = node.querySelector('.mesAvatarWrapper');
        if (wrapper) {
            wrapper.insertAdjacentHTML('beforeend', `
            <svg class="dsum-mes-stats" viewBox="0 0 60 36" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${title}" title="${title}">
                <title>${title}</title>
                <g transform="translate(2.5,3) scale(0.5)">${ICON_UPLOAD}</g>
                <text x="15" y="14.4">${n((usage.prompt_tokens ?? 0) - (usage.prompt_cache_hit_tokens ?? 0))}</text>
                <g transform="translate(2.5,22) scale(0.0166667)">${ICON_DATABASE}</g>
                <text x="15" y="32.4">${n(usage.prompt_cache_hit_tokens)}</text>
            </svg>`);
        }
        // Cost sits in the message header next to the model icon (timestamp-icon),
        // away from ST's absolutely-positioned swipe counter at the bottom-right.
        const modelIcon = node.querySelector('.ch_name .timestamp-icon');
        const headerAnchor = modelIcon || node.querySelector('.ch_name .timestamp') || node.querySelector('.ch_name .name_text');
        if (headerAnchor) {
            headerAnchor.insertAdjacentHTML('afterend', `<span class="dsum-msg-cost" title="${title}">${costText(value)}${peak ? ` · PEAK ×${peak}` : ''}</span>`);
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
            const record = {
                ...usage,
                peak: pricing.peak,
                peakMultiplier: pricing.peakMultiplier,
                calculated_cost_usd: cost(usage),
            };
            // Keep one record per swipe so each variant shows its own tokens/cost.
            message.extra.deepseekUsageBySwipe ??= {};
            message.extra.deepseekUsageBySwipe[message.swipe_id ?? 0] = record;
            message.extra.deepseekUsage = record; // current swipe; legacy fallback
            const p = priceFor(usage.model);
            sessionStats.requests++;
            sessionStats.hit += usage.prompt_cache_hit_tokens;
            sessionStats.miss += usage.prompt_cache_miss_tokens;
            sessionStats.saved += usage.prompt_cache_hit_tokens * (p.cache_miss - p.cache_hit) / 1_000_000;
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
            if (output) output.textContent = balanceText();
        } catch (error) {
            balance = { infos: [], isAvailable: false };
            const output = document.querySelector('#dsum-balance');
            if (output) output.textContent = 'Balance unavailable';
            console.debug('[DeepSeek Usage Meter]', error.message);
        }
    }

    function renderPricing() {
        const node = document.querySelector('#dsum-pricing');
        if (!node) return;
        const status = pricing.peak
            ? `Peak pricing active — prices ×${pricing.peakMultiplier} (Beijing ${pricing.beijingTime})`
            : `Off-peak pricing (Beijing ${pricing.beijingTime})`;
        const rows = Object.entries(pricing.models).map(([model, p]) => {
            const e = pricing.effective[model] ?? p;
            return `<div class="dsum-model"><b>${model}</b><span>in ${money(e.cache_miss)}/1M · cached ${money(e.cache_hit)}/1M · out ${money(e.output)}/1M</span></div>`;
        }).join('');
        node.innerHTML = `<div class="dsum-status">${status}</div>${rows}<small>Prices fetched from deepseek.com · source: ${pricing.source}${pricing.fetchedAt ? ` · ${new Date(pricing.fetchedAt).toLocaleTimeString()}` : ''}</small>`;
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

    async function openUsagePopup() {
        await Promise.all([fetchPricing(), refreshBalance()]);
        const priceRows = Object.entries(pricing.models).map(([model, p]) => {
            const e = pricing.effective[model] ?? p;
            return { model, cacheHit: e.cache_hit, cacheMiss: e.cache_miss, output: e.output };
        });
        const totals = chatTotals();
        const html = await renderExtensionTemplateAsync('third-party/ui-extension', 'popup', {
            balanceText: balanceText(),
            isAvailable: balance.isAvailable,
            peakText: pricing.peak
                ? `Peak pricing active — prices ×${pricing.peakMultiplier} (Beijing ${pricing.beijingTime})`
                : `Off-peak pricing (Beijing ${pricing.beijingTime})`,
            priceRows,
            chatCost: money(totals.cost),
            chatTokens: n(totals.tokens),
            sessionText: sessionCacheText(),
            auditHtml: auditHtml(),
            source: pricing.source,
            fetchedAt: pricing.fetchedAt ? new Date(pricing.fetchedAt).toLocaleTimeString() : '',
        });
        callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true });
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
              <label>Meter token (optional) <input id="dsum-token" class="text_pole" type="password"></label>
              <div class="dsum-hint">Per-message usage (cost, cached/missed tokens) is captured automatically from SillyTavern's chat-completion response. Keep the DeepSeek endpoint on <code>api.deepseek.com</code> — no proxy needed.</div>
              <div id="dsum-pricing" class="dsum-pricing"></div>
              <div class="dsum-total">This chat: <b id="dsum-chat-total"></b></div>
              <div class="dsum-total">Cache session: <b id="dsum-session"></b></div>
              <div class="dsum-actions"><button id="dsum-refresh" class="menu_button">Refresh balance &amp; prices</button><span id="dsum-balance"></span></div>
            </div>
          </div>`);
        const token = document.querySelector('#dsum-token');
        token.value = settings.meterToken;
        token.addEventListener('input', () => {
            settings.meterToken = token.value;
            context.saveSettingsDebounced();
        });
        document.querySelector('#dsum-refresh').addEventListener('click', () => { refreshBalance(); fetchPricing(); });
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
    refreshBalance();
    renderChatTotals();
    setInterval(fetchPricing, 10 * 60 * 1000); // keep peak-hour detection current across session
    eventSource.on(event_types.APP_READY, addWandButton); // auto-fires if the app is already ready
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, render);
    eventSource.on(event_types.MESSAGE_SWIPED, mesId => render(mesId)); // each swipe shows its own usage
    eventSource.on(event_types.GENERATION_ENDED, attachLatestUsage);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        context.chat.forEach((_, i) => render(i));
        renderChatTotals();
    });
})();
