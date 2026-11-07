# DeepSeek Usage Meter (extension)

Shows DeepSeek and Ollama Cloud usage in SillyTavern: tokens and cost per message, cached vs fresh input, live balance/prices, and session cache stats.

## Install

From inside your SillyTavern folder:

```
git clone https://github.com/Lynixenn/deepseek-usage-meter-server plugins/deepseek-usage-meter-server && git clone https://github.com/Lynixenn/deepseek-usage-meter-ui data/default-user/extensions/deepseek-usage-meter-ui
```

Restart the server and refresh the page. If your profile isn't `default-user`, copy the extension to `data/<profile>/extensions/deepseek-usage-meter-ui` instead.

## Usage

- `/dsum` or the "DeepSeek Usage" wand button opens the full view (balance, prices, peak hours, session stats)
- Hover the numbers on a message for a detailed tooltip, or click the cost/stats to open the full view
- The popup shows a 24h peak-hour timeline in your local time and highlights the model currently in use
- The popup also warns about macros in your system prompt or lorebook that would break DeepSeek's prefix caching ({{time}}, {{random}}, etc.)
- Peak pricing (prices ×2) only applies inside the announced Beijing-time peak windows on weekdays — weekends are off-peak all day, so no ×2 prices and no peak confirm
- The first DeepSeek generation during peak hours asks once per page load whether to continue. The request is held until you answer (nothing is sent on Cancel); refresh SillyTavern to be asked again
- Settings > DeepSeek Usage Meter: enable "Peak confirm test mode" to hold and confirm every generation, so you can test the flow outside peak hours

## Ollama Cloud

Ollama Cloud models are priced per million tokens on [ollama.com/pricing](https://ollama.com/pricing), where the DeepSeek models carry a peak rate (double) inside 12:00-18:00 UTC on weekdays; every other model has a single rate. The table is scraped live and applied per message, the same way the DeepSeek rates are.

- Point SillyTavern at a **Custom (OpenAI-compatible)** source with `http://localhost:11434/v1` — Ollama's OpenAI shim reports `prompt_tokens_details.cached_tokens`, which the meter needs for the cached/fresh split
- Ollama's native metrics (`prompt_eval_count`, `prompt_eval_cached_count`, `eval_count`) are understood too, and are folded onto the same cached/fresh fields, so a response is priced the same whichever endpoint produced it. `prompt_eval_cached_count` was added to the API recently and is optional, so its absence is treated as "nothing was cached" rather than as an error
- Streamed replies only carry usage when the request asks for it, and SillyTavern rebuilds the upstream body from a fixed allow-list that has no `stream_options`. The meter appends `stream_options.include_usage: true` to the Custom source's **Include body** YAML for you on each request (your own YAML and a `stream_options` you set yourself are left alone), so nothing needs configuring by hand
- The provider is resolved per message, so DeepSeek and Ollama chats can be interleaved; peak detection uses the UTC window for Ollama and the Beijing one for DeepSeek
- Your credit balance needs an **Ollama API key** in Settings > DeepSeek Usage Meter; it is only forwarded to `ollama.com/api/balance` and never persisted server-side. The meter shows the remaining included allowance against its monthly allowance, plus any unexpired purchased credits. Older plans that still answer with `session` (5h) and `weekly` (7d) percentage windows get those two bars instead
- Local (non-cloud) Ollama models are not in the pricing table and are left unpriced rather than mis-billed
- Cache hits are only reported when Ollama's cache actually serves one: a stable system prompt and growing history hit, while two unrelated one-shot prompts usually miss

## Ollama (Native)

With the server plugin running, **Chat Completion Source** gains an **Ollama (Native)** entry. It talks to Ollama's `/api/chat` through the plugin's bridge, and shows these settings above the endpoint field:

- **Thinking**: sent as Ollama's `think`. **Follow Reasoning Effort** uses SillyTavern's own Reasoning Effort setting, which SillyTavern does not send for Custom sources, and leaves the model default on Auto. Which level names a model accepts depends on the model: Ollama falls back to the model default for one it does not support, so use **On** for models that only have on and off
- **Context size**: sent as `num_ctx`
- **Keep model loaded**: sent as `keep_alive`

Keep **Request model reasoning** on, or SillyTavern hides the thinking block. Reasoning also counts against Max Response Length.

SillyTavern's source list is built into its core, so the entry is the Custom source pointed at the bridge. Its model list, API key and Additional Parameters all still apply, and the endpoint field is hidden while the entry is selected. Anything you set yourself in Include body takes priority over these controls. While it is selected, switching presets keeps you on it, even if a preset was saved with another endpoint. A connection profile still applies its own saved endpoint, so update any profile that should use this entry. Picking **Custom (OpenAI-compatible)** restores the endpoint you had before. The entry does not appear if the bridge is off or could not start; the server console says why.

Usage and cost work the same as on `/v1`, including the cached/fresh split when Ollama reports `prompt_eval_cached_count`.
