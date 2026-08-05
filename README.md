# DeepSeek Usage Meter (extension)

Shows DeepSeek usage in SillyTavern: tokens and cost per message, cached vs fresh input, live balance and prices, and session cache stats.

## Install

Copy this folder to your SillyTavern install:

```
data/default-user/extensions/ui-extension
```

Refresh the page. If your profile isn't `default-user`, put it in `data/<profile>/extensions/ui-extension` instead.

Requires the server plugin: https://github.com/Lynixenn/deepseek-usage-meter-plugin

## Usage

- `/dsum` or the "DeepSeek Usage" wand button opens the full view (balance, prices, peak hours, session stats)
- Hover the numbers on a message for details
- The popup also warns about macros in your system prompt or lorebook that would break DeepSeek's prefix caching ({{time}}, {{random}}, etc.)
