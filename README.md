# DeepSeek Usage Meter (extension)

Shows DeepSeek usage in SillyTavern: tokens and cost per message, cached vs fresh input, live balance and prices, and session cache stats.

## Install

From inside your SillyTavern folder:

```
git clone https://github.com/Lynixenn/deepseek-usage-meter-server plugins/deepseek-usage-meter-server && git clone https://github.com/Lynixenn/deepseek-usage-meter-ui data/default-user/extensions/deepseek-usage-meter-ui
```

Restart the server and refresh the page. If your profile isn't `default-user`, copy the extension to `data/<profile>/extensions/deepseek-usage-meter-ui` instead.

## Usage

- `/dsum` or the "DeepSeek Usage" wand button opens the full view (balance, prices, peak hours, session stats)
- Hover the numbers on a message for a detailed tooltip, or click the cost/stats to open the full view
- The popup shows a 24h peak-hour timeline in Beijing time and highlights the model currently in use
- The popup also warns about macros in your system prompt or lorebook that would break DeepSeek's prefix caching ({{time}}, {{random}}, etc.)
