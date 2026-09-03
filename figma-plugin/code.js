// Pointer's Figma-side companion. Turns the design tree the extension
// exports (see src/content/index.ts, buildFigmaTree) into real Figma
// layers: frames with auto layout, native text, images, and vector icons —
// not shapes glued together by SVG coordinates, which is what made the
// old paste-an-SVG approach fall apart on anything but the simplest
// layouts (every unpainted container vanished, and nothing had padding,
// gap, or alignment as actual properties).

figma.showUI(__html__, { width: 340, height: 320 });

const WEIGHT_NAMES = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'Extra Bold',
  900: 'Black',
};

function closestWeightName(weight) {
  const known = Object.keys(WEIGHT_NAMES).map(Number);
  const nearest = known.reduce((a, b) =>
    Math.abs(b - weight) < Math.abs(a - weight) ? b : a
  );
  return WEIGHT_NAMES[nearest];
}

// Tries the exact family/weight/style the page used, then Regular of the
// same family, then falls back to Inter (always available in Figma) so a
// missing font never blocks the import — it just won't look pixel-exact
// for that text until the real font is installed and swapped in by hand.
async function resolveFont(family, weight, italic, stats) {
  const weightName = closestWeightName(weight);
  const primary = italic ? (weight === 400 ? 'Italic' : `${weightName} Italic`) : weightName;

  const attempts = [
    { family, style: primary },
    { family, style: italic ? 'Italic' : 'Regular' },
  ];
  for (const fontName of attempts) {
    try {
      await figma.loadFontAsync(fontName);
      return fontName;
    } catch {
      // try the next one
    }
  }
  const fallback = { family: 'Inter', style: italic ? 'Italic' : 'Regular' };
  try {
    await figma.loadFontAsync(fallback);
  } catch {
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    fallback.style = 'Regular';
  }
  stats.fontFallback.add(family);
  return fallback;
}

async function applyText(node, t, stats) {
  const fontName = await resolveFont(t.fontFamily, t.fontWeight, t.italic, stats);
  node.fontName = fontName;
  node.characters = t.characters;
  node.fontSize = t.fontSize;
  node.letterSpacing = { value: t.letterSpacing, unit: 'PIXELS' };
  node.lineHeight = t.lineHeight === null ? { unit: 'AUTO' } : { value: t.lineHeight, unit: 'PIXELS' };
  node.textAlignHorizontal = t.align;
  node.textCase = t.case;
  node.fills = [
    { type: 'SOLID', color: { r: t.color.r, g: t.color.g, b: t.color.b }, opacity: t.color.a },
  ];
}

function applyCornerRadius(node, radii) {
  const [tl, tr, br, bl] = radii;
  if (tl === tr && tr === br && br === bl) {
    node.cornerRadius = tl;
    return;
  }
  node.topLeftRadius = tl;
  node.topRightRadius = tr;
  node.bottomRightRadius = br;
  node.bottomLeftRadius = bl;
}

async function buildNode(d, parent, stats) {
  let node;

  if (d.type === 'VECTOR') {
    try {
      node = figma.createNodeFromSvg(d.vector.svg);
    } catch {
      node = figma.createRectangle();
      node.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
      stats.vectorFallback++;
    }
  } else if (d.type === 'TEXT') {
    node = figma.createText();
  } else if (d.type === 'IMAGE') {
    node = figma.createRectangle();
  } else {
    node = figma.createFrame();
  }

  node.name = d.name || d.type;
  parent.appendChild(node);
  node.x = d.x;
  node.y = d.y;

  if (d.type === 'FRAME') {
    if (d.fill) {
      node.fills = [
        { type: 'SOLID', color: { r: d.fill.r, g: d.fill.g, b: d.fill.b }, opacity: d.fill.a },
      ];
    } else {
      node.fills = [];
    }
    if (d.stroke) {
      node.strokes = [
        { type: 'SOLID', color: { r: d.stroke.r, g: d.stroke.g, b: d.stroke.b }, opacity: d.stroke.a },
      ];
      node.strokeWeight = d.strokeWeight || 1;
      node.strokeAlign = 'INSIDE';
    }
    if (d.cornerRadius) applyCornerRadius(node, d.cornerRadius);
    if (d.opacity !== undefined) node.opacity = d.opacity;
    node.clipsContent = !!d.clip;

    if (d.layout) {
      node.layoutMode = d.layout.direction;
      node.primaryAxisSizingMode = 'FIXED';
      node.counterAxisSizingMode = 'FIXED';
      node.itemSpacing = d.layout.gap;
      node.paddingTop = d.layout.padding[0];
      node.paddingRight = d.layout.padding[1];
      node.paddingBottom = d.layout.padding[2];
      node.paddingLeft = d.layout.padding[3];
      node.primaryAxisAlignItems = d.layout.primary;
      node.counterAxisAlignItems = d.layout.counter;
      if (d.layout.direction === 'HORIZONTAL') {
        node.layoutWrap = d.layout.wrap ? 'WRAP' : 'NO_WRAP';
      }
    } else {
      node.layoutMode = 'NONE';
    }

    node.resize(Math.max(1, d.width), Math.max(1, d.height));

    if (d.children) {
      for (const c of d.children) {
        const child = await buildNode(c, node, stats);
        if (child && node.layoutMode !== 'NONE' && c.sizing) {
          try {
            child.layoutSizingHorizontal = c.sizing.h;
            child.layoutSizingVertical = c.sizing.v;
          } catch {
            // Some node types (vectors) don't support independent sizing —
            // the fixed x/y/width/height already placed it correctly.
          }
        }
      }
    }
  } else if (d.type === 'TEXT') {
    await applyText(node, d.text, stats);
    node.resize(Math.max(1, d.width), Math.max(1, d.height));
    // Fix the width to what the page wrapped to and let Figma's own text
    // engine compute height at that width — far more reliable than us
    // pre-computing line breaks with the source page's font metrics.
    node.textAutoResize = 'HEIGHT';
  } else if (d.type === 'IMAGE') {
    if (d.image && d.image.dataUrl) {
      try {
        const base64 = d.image.dataUrl.slice(d.image.dataUrl.indexOf(',') + 1);
        const bytes = figma.base64Decode(base64);
        const image = figma.createImage(bytes);
        node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
      } catch {
        node.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
        stats.imageFallback++;
      }
    } else {
      node.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
      stats.imageFallback++;
    }
    node.resize(Math.max(1, d.width), Math.max(1, d.height));
  } else if (d.type === 'VECTOR') {
    node.resize(Math.max(1, d.width), Math.max(1, d.height));
  }

  return node;
}

figma.ui.onmessage = async (msg) => {
  if (msg.type !== 'import') return;
  const stats = { fontFallback: new Set(), imageFallback: 0, vectorFallback: 0 };
  try {
    const design = JSON.parse(msg.json);
    if (!design || design.pointerExport !== 1 || !design.root) {
      throw new Error("That doesn't look like a Pointer export — copy it again with “Copy for Figma”.");
    }
    const root = await buildNode(design.root, figma.currentPage, stats);
    root.x = figma.viewport.center.x - root.width / 2;
    root.y = figma.viewport.center.y - root.height / 2;
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);

    const notes = [];
    if (stats.fontFallback.size) {
      notes.push(
        `${stats.fontFallback.size} font(s) not installed, substituted with Inter: ${[...stats.fontFallback].join(', ')}`
      );
    }
    if (stats.imageFallback) notes.push(`${stats.imageFallback} image(s) shown as gray placeholders`);
    if (stats.vectorFallback) notes.push(`${stats.vectorFallback} icon(s) couldn't be parsed as vectors`);
    figma.ui.postMessage({ type: 'done', notes });
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
