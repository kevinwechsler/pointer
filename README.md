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

## Send a selection to Figma

Select an element and hit **Copy for Figma** in the panel. It copies a real
design tree (frames, auto layout, text — not an SVG), which the companion
Figma plugin turns into native layers.

The plugin isn't published to the Figma Community — it runs as a **local
development plugin**, a one-time, no-review, no-account setup Figma supports
for exactly this kind of personal/internal tool. You only do this once per
computer:

1. Open the **Figma desktop app** — dev plugins can't be loaded from
   figma.com in a browser, only the desktop app.
2. Figma menu (top left) → **Plugins → Development → Import plugin from
   manifest…**
3. Pick `figma-plugin/manifest.json` from this repo.
4. Done — it now shows up under **Plugins → Development → Pointer** in
   every file, same as any other plugin.

To use it: select an element in Pointer → **Copy for Figma** → in Figma,
run **Plugins → Development → Pointer** → paste (⌘V) into the box that
opens. It imports as soon as you paste.

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
