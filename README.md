# Pointer

Point at elements in your localhost app, tweak them visually, and get a precise prompt to paste into Claude.

## How it works

1. Open your app running on `localhost` in Chrome.
2. Click the Pointer icon in the toolbar → the side panel opens.
3. Turn on **Inspect**, then click any element on the page.
4. Edit its properties in the panel (colors, typography, spacing, borders, text). Changes preview live on the page.
5. Go to the **Changes** tab → **Copy prompt** → paste into Claude Code.

The prompt references the exact source file and line when the app exposes that info (React apps in dev mode), or a precise CSS selector otherwise.

## Install (dev)

```bash
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` folder of this repo

After making code changes, run `npm run build` again and hit the refresh icon on the extension card.

## Known limitations (v1)

- File/line resolution relies on React dev-mode debug info. Newer React versions (19+) removed part of this, so some apps will fall back to selector-based references — still precise, just not file-exact.
- Live edits are previews on the rendered page only; nothing is written to your codebase. Claude makes the real change from the prompt.
- Only works on `http://localhost` / `http://127.0.0.1`.
