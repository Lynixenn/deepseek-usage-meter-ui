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

Ollama Cloud models are priced per million tokens on [ollama.com/pricing](https://ollama.com/pricing), with a peak surcharge (×2) for the DeepSeek models between 12:00 and 18:00 UTC, Monday to Friday. Both are scraped live and applied per message, the same way the DeepSeek rates are.

- Point SillyTavern at a **Custom (OpenAI-compatible)** source with `http://localhost:11434/v1` — Ollama's OpenAI shim reports `prompt_tokens_details.cached_tokens`, which the meter needs for the cached/fresh split
- Streamed replies only carry usage when the request asks for it, and SillyTavern rebuilds the upstream body from a fixed allow-list that has no `stream_options`. The meter appends `stream_options.include_usage: true` to the Custom source's **Include body** YAML for you on each request (your own YAML and a `stream_options` you set yourself are left alone), so nothing needs configuring by hand
- The provider is resolved per message, so DeepSeek and Ollama chats can be interleaved; peak detection uses the UTC window for Ollama and the Beijing one for DeepSeek
- The session/weekly quota windows (`session` = 5h, `weekly` = 7d) need an **Ollama API key** in Settings > DeepSeek Usage Meter; it is only forwarded to `ollama.com/api/usage` and never persisted server-side
- Local (non-cloud) Ollama models are not in the pricing table and are left unpriced rather than mis-billed
- Cache hits are only reported when Ollama's cache actually serves one: a stable system prompt and growing history hit, while two unrelated one-shot prompts usually miss
