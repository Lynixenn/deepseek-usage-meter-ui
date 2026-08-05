# DeepSeek Usage Meter (extension)

Shows DeepSeek usage in SillyTavern: tokens and cost per message, cached vs fresh input, live balance and prices, and session cache stats.

## Install

From inside your SillyTavern folder:

```
git clone https://github.com/Lynixenn/deepseek-usage-meter-plugin plugins/deepseek-usage-meter && git clone https://github.com/Lynixenn/deepseek-usage-meter-extension data/default-user/extensions/ui-extension
```

Restart the server and refresh the page. If your profile isn't `default-user`, copy the extension to `data/<profile>/extensions/ui-extension` instead.

## Usage

- `/dsum` or the "DeepSeek Usage" wand button opens the full view (balance, prices, peak hours, session stats)
- Hover the numbers on a message for details
- The popup also warns about macros in your system prompt or lorebook that would break DeepSeek's prefix caching ({{time}}, {{random}}, etc.)
