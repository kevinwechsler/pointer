# Pointer

Point at elements in your localhost app, tweak them visually, and get a precise prompt to paste into Claude.

## Setup

Two separate installs — the browser extension (required) and the Figma plugin (only if you want to send selections into Figma).

### 1. Install the browser extension

```bash
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` folder of this repo

The Pointer icon appears in the toolbar. After pulling code changes, run `npm run build` again and hit the refresh icon on the extension card in `chrome://extensions`.

### 2. Install the Figma plugin (optional, one-time)

Only needed if you want **Copy for Figma** to work. It isn't published to the Figma Community — it's a **local development plugin**, a setup Figma supports for personal/internal tools with no review and no account needed. You only do this once per computer:

1. Open the **Figma desktop app** (not figma.com in a browser — dev plugins only load from the desktop app).
2. Figma menu (top left) → **Plugins → Development → Import plugin from manifest…**
3. Pick `figma-plugin/manifest.json` from this repo.
4. Done. It now shows up under **Plugins → Development → Pointer** in every file, like any other plugin.

## How it works

1. Open your app running on `localhost` in Chrome.
2. Click the Pointer icon in the toolbar → the side panel opens.
3. Turn on **Inspect**, then click any element on the page.
4. Edit its properties in the panel (colors, typography, spacing, borders, text). Changes preview live on the page.
5. Go to the **Changes** tab → **Copy prompt** → paste into Claude Code.

The prompt references the exact source file and line when the app exposes that info (React apps in dev mode), or a precise CSS selector otherwise.

## Send a selection to Figma

Requires the Figma plugin installed above.

1. Select an element in Pointer, hit **Copy for Figma**. It copies a real design tree (frames, auto layout, text — not an SVG or a screenshot).
2. In Figma, run **Plugins → Development → Pointer**.
3. Paste (⌘V) into the box that opens — it imports as native layers as soon as you paste.

Why not publish it to the Figma Community instead (like html.to.design)? Publishing
means a public listing, Figma's review process, and an ongoing obligation to
maintain something other people are now depending on — overkill for what
this is. The dev-import above gives the same "select and paste" experience;
the only cost is that whoever wants it needs a copy of this repo (cloning it
takes as long as installing a published plugin would). If you want to hand
it to a teammate without them touching git, just zip the `figma-plugin/`
folder and send it — they still use the same Import from manifest step.

See [`figma-plugin/README.md`](figma-plugin/README.md) for what does and
doesn't survive the trip into Figma (fonts, sizing, borders, and so on).

## Known limitations (v1)

- File/line resolution relies on React dev-mode debug info. Newer React versions (19+) removed part of this, so some apps will fall back to selector-based references — still precise, just not file-exact.
- Live edits are previews on the rendered page only; nothing is written to your codebase. Claude makes the real change from the prompt.
- Only works on `http://localhost` / `http://127.0.0.1`.
