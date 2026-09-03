# Pointer (Figma plugin)

Companion to the Pointer Chrome extension. **Copy for Figma** in the extension
copies a design tree — real frames, auto layout, text — as JSON. This plugin
turns that JSON into native Figma layers.

This replaced an earlier approach that pasted raw SVG into Figma. SVG import
has no concept of auto layout or padding — every unpainted container (most
real layout `<div>`s) silently disappeared, and nothing kept its gap or
alignment as an editable property. This plugin builds the actual layer tree
instead, so what you get behaves like something a designer built by hand.

## Install (development plugin — no publishing needed)

1. Open the **Figma desktop app** (the browser version can't load local dev
   plugins).
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Select `figma-plugin/manifest.json` in this repo.
4. It now shows up under **Plugins → Development → Pointer**.

## Use

1. In the Chrome extension, select an element and hit **Copy for Figma**.
2. In Figma, run **Plugins → Development → Pointer**.
3. Paste (⌘V) into the plugin's textarea — it imports automatically.
4. The result is selected and centered in your view.

## Known limitations

- **Fonts**: if the page's font isn't installed on your machine, text falls
  back to Inter (the plugin tells you which ones). Install the real font and
  swap it in Figma to match exactly.
- **Sizing**: everything defaults to Fixed width/height (pixel-accurate to
  the captured page). Elements that visibly stretch on the page (`flex-grow`,
  `width: 100%`) come in as Fill; nothing is guessed as Hug — set that
  yourself afterward if you want responsive behavior.
- **Borders**: one weight and color per element (the top side), even if the
  source has different borders per side.
- **Not carried over**: gradients, background images, box-shadows, CSS grid
  (only flexbox becomes auto layout — grid containers still export with
  their children in the right place, just without grid-specific properties).
- **Images**: same-origin (e.g. your localhost) images embed fine.
  Cross-origin images without CORS headers become gray placeholders.
