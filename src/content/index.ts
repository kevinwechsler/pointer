// The panel and this script exchange these shapes; they used to be
// declared twice, once on each side, which let them drift apart in
// silence. Type-only imports are erased at build time, so sharing the
// single definition costs the content script nothing at runtime.
import type { SelectionPayload, SizeMode, SourceInfo } from '@/lib/pointer'

// Pointer content script: runs inside the localhost page.
// Handles hover highlighting, element selection, live style edits with
// true revert (restores the element's pristine state), and resolving
// the selected DOM element back to its source file via React fiber.


// With all_frames enabled, one copy of this script runs per frame (the app
// may live inside an iframe, e.g. hosted platforms like Urdi). Each copy
// tags what it sends with a unique token so the panel can route follow-up
// messages (style edits, exports) back to the frame that owns the element.
const FRAME_TOKEN = crypto.randomUUID()
const IS_TOP = window === window.top

// Dev harnesses (e.g. Urdi's) render the real app inside an iframe and dress
// the outer page up as host chrome — a sidebar, a title bar — purely for
// context. That chrome is never what you want to edit, and it tends to sit
// on top of the iframe and swallow clicks meant for the app. When the top
// frame is recognizably a harness, it stays out of the way and lets the
// iframe's own copy of this script handle everything.
const IS_HOST_CHROME =
  IS_TOP &&
  (/urdi dev harness/i.test(document.title) ||
    !!document.querySelector('iframe[src^="/__app__"]'))


const STYLE_PROPS = [
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'fontFamily',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'borderRadius',
  'borderWidth',
  'borderColor',
  'borderStyle',
  'display',
  'flexDirection',
  'alignItems',
  'justifyContent',
  'gap',
  // Read and written separately from the `gap` shorthand: that shorthand can
  // hold two different lengths at once ("10px 20px"), which no single numeric
  // field can represent or edit.
  'rowGap',
  'columnGap',
  'opacity',
  'boxShadow',
  'width',
  'height',
  'transform',
  'flexWrap',
  'gridTemplateColumns',
  'gridTemplateRows',
  'alignSelf',
  'flexGrow',
  'overflow',
  'textTransform',
] as const

let active = false
let hoverEl: Element | null = null
// Where the cursor last was, so holding Option can bring the measurements up
// on the spot — in Figma they appear the moment you press it, without having
// to jiggle the mouse first.
let lastPointer = { x: 0, y: 0 }
let selectedEl: Element | null = null

// ---------- element registry & pristine state ----------
// Elements get a numeric id so the panel can target them even after
// selecting something else (needed for undo/redo across elements).

let nextId = 1
const registry = new Map<number, Element>()
const idOf = new Map<Element, number>()

// Pristine state captured the first time an element is touched, so any
// edit can be fully reverted (inline style removed, original text restored).
type Pristine = {
  inline: Map<string, string>
  text: string | null
}
const pristine = new Map<number, Pristine>()

function registerEl(el: Element): number {
  let id = idOf.get(el)
  if (id == null) {
    id = nextId++
    registry.set(id, el)
    idOf.set(el, id)
  }
  return id
}

function getEl(id: number): HTMLElement | null {
  const el = registry.get(id)
  return el && el.isConnected ? (el as HTMLElement) : null
}

function ensurePristine(id: number): Pristine {
  let p = pristine.get(id)
  if (!p) {
    p = { inline: new Map(), text: null }
    pristine.set(id, p)
  }
  return p
}

// ---------- overlay ----------

function makeBox(color: string, bg: string): HTMLDivElement {
  const box = document.createElement('div')
  Object.assign(box.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483646',
    border: `2px solid ${color}`,
    background: bg,
    borderRadius: '2px',
    display: 'none',
    boxSizing: 'border-box',
  })
  document.documentElement.appendChild(box)
  return box
}

let hoverBox: HTMLDivElement | null = null
let selectBox: HTMLDivElement | null = null
let hoverLabel: HTMLDivElement | null = null

function ensureOverlay() {
  if (hoverBox) return
  hoverBox = makeBox('#3b82f6', 'rgba(59,130,246,0.08)')
  selectBox = makeBox('#f59e0b', 'transparent')
  hoverLabel = document.createElement('div')
  Object.assign(hoverLabel.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483647',
    background: '#171717',
    color: '#fafafa',
    font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '2px 6px',
    borderRadius: '4px',
    display: 'none',
    maxWidth: '360px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  })
  document.documentElement.appendChild(hoverLabel)
}

function positionBox(box: HTMLDivElement, el: Element) {
  const r = el.getBoundingClientRect()
  Object.assign(box.style, {
    display: 'block',
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  })
  if (box === selectBox) positionHandles(el)
}

function hideBox(box: HTMLDivElement | null) {
  if (box) box.style.display = 'none'
  if (box && box === selectBox) hideHandles()
}

// ---------- element identity ----------

function shortDescriptor(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const id = el.id ? `#${el.id}` : ''
  const cls = el.classList.length
    ? '.' + Array.from(el.classList).slice(0, 3).join('.')
    : ''
  return `${tag}${id}${cls}`
}

function cssSelector(el: Element): string {
  const parts: string[] = []
  let node: Element | null = el
  while (node && node !== document.body && parts.length < 4) {
    let part = node.tagName.toLowerCase()
    if (node.id) {
      parts.unshift(`${part}#${node.id}`)
      break
    }
    const stable = Array.from(node.classList).filter(
      (c) => !/^\d|\[|:|\//.test(c) && c.length < 40
    )
    if (stable.length) part += '.' + stable.slice(0, 2).join('.')
    const parent = node.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (s) => s.tagName === node!.tagName
      )
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
    }
    parts.unshift(part)
    node = node.parentElement
  }
  return parts.join(' > ')
}

// ---------- React fiber source lookup ----------

function getFiber(el: Element): any {
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      return (el as any)[key]
    }
  }
  return null
}

// ---------- layer tree ----------
// The page as Figma would list it: nested layers with readable names. Names
// come from the React component that rendered the node when available,
// otherwise from the tag plus its first class. Capped so a huge page can't
// flood the panel.
// What the layer *is*, so the panel can show the same icon vocabulary
// Figma uses: T for text, a diamond for components, a square/circle for
// leaf shapes with visible paint, a frame icon for plain containers.
export type LayerKind = 'text' | 'image' | 'vector' | 'circle' | 'rect' | 'component' | 'frame'

export type LayerNode = {
  id: number
  name: string
  kind: LayerKind
  tag: string
  text: string
  children: LayerNode[]
}

const TREE_MAX_DEPTH = 14
const TREE_MAX_NODES = 2500
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BR'])

function layerName(el: Element): { name: string; isComponent: boolean } {
  const fiber = getFiber(el)
  // Nearest component that owns this host node, without walking far.
  let f = fiber
  for (let i = 0; f && i < 6; i++) {
    const n = fiberName(f)
    if (n) return { name: n, isComponent: true }
    f = f._debugOwner || f.return
  }
  const tag = el.tagName.toLowerCase()
  const cls = Array.from(el.classList).find((c) => !/^\d|\[|:|\//.test(c) && c.length < 32)
  return { name: cls ? `${tag}.${cls}` : tag, isComponent: false }
}

function classifyLayer(
  el: Element,
  hasChildren: boolean,
  ownText: string,
  isComponent: boolean
): LayerKind {
  const tag = el.tagName.toLowerCase()
  if (tag === 'img' || tag === 'picture') return 'image'
  if (tag === 'svg') return 'vector'
  if (!hasChildren && ownText) return 'text'
  if (hasChildren) return isComponent ? 'component' : 'frame'
  // Childless, textless: a shape if it visibly paints something, otherwise
  // an empty frame (Figma shows plain empty frames the same way).
  const cs = getComputedStyle(el)
  const bg = figmaColor(cs.backgroundColor)
  const hasBorder = (parseFloat(cs.borderTopWidth) || 0) > 0 && cs.borderTopStyle !== 'none'
  if (!bg && !hasBorder) return 'frame'
  const radius = parseFloat(cs.borderTopLeftRadius) || 0
  const rect = el.getBoundingClientRect()
  const isCircle = radius > 0 && radius >= Math.min(rect.width, rect.height) / 2 - 1
  return isCircle ? 'circle' : 'rect'
}

function buildLayerTree(): LayerNode[] {
  let count = 0
  const walk = (el: Element, depth: number): LayerNode | null => {
    if (count >= TREE_MAX_NODES) return null
    if (SKIP_TAGS.has(el.tagName)) return null
    if (el.hasAttribute('data-pointer-pin')) return null
    count++
    const children: LayerNode[] = []
    if (depth < TREE_MAX_DEPTH) {
      for (const child of Array.from(el.children)) {
        const node = walk(child, depth + 1)
        if (node) children.push(node)
      }
    }
    // Own text only (not descendants'), trimmed, for a Figma-like preview.
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent || '').trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 40)
    const { name, isComponent } = layerName(el)
    return {
      id: registerEl(el),
      name,
      kind: classifyLayer(el, children.length > 0, ownText, isComponent),
      tag: el.tagName.toLowerCase(),
      text: ownText,
      children,
    }
  }
  const root = walk(document.body, 0)
  return root ? root.children : []
}

function fiberName(fiber: any): string | null {
  const t = fiber?.type
  if (!t) return null
  if (typeof t === 'string') return null
  return t.displayName || t.name || null
}

function resolveSource(el: Element): { source: SourceInfo; chain: string[] } {
  const chain: string[] = []
  let source: SourceInfo = null
  let fiber = getFiber(el)
  let hops = 0
  while (fiber && hops < 50) {
    if (!source && fiber._debugSource) {
      const s = fiber._debugSource
      source = { fileName: s.fileName, lineNumber: s.lineNumber }
    }
    const name = fiberName(fiber)
    if (name && !chain.includes(name)) chain.push(name)
    fiber = fiber._debugOwner || fiber.return
    hops++
    if (chain.length >= 5 && source) break
  }
  return { source, chain: chain.slice(0, 5) }
}

// ---------- selection ----------

// Typography properties that only make sense to show/edit when they mean
// one consistent thing across whatever text is inside the selection.
const TYPOGRAPHY_KEYS = [
  'color',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textTransform',
] as const

/** Every descendant (including the element itself) that owns direct,
 * non-whitespace text — i.e. every distinct "text run" inside the
 * selection, at any depth. */
function collectTextRuns(root: Element): Element[] {
  const runs: Element[] = []
  const walk = (node: Element) => {
    const hasOwnText = Array.from(node.childNodes).some(
      (c) => c.nodeType === Node.TEXT_NODE && (c.textContent || '').trim()
    )
    if (hasOwnText) runs.push(node)
    for (const child of Array.from(node.children)) walk(child)
  }
  walk(root)
  return runs
}

function buildPayload(el: Element): SelectionPayload {
  const computed = window.getComputedStyle(el)
  const styles: Record<string, string> = {}
  for (const p of STYLE_PROPS) styles[p] = computed[p as any] as string

  // A container holding several distinct text elements has no single
  // "content" to show — el.textContent used to concatenate all of them,
  // and editing that wrote the joined string back via el.innerText,
  // silently deleting every child element in the process. Content is only
  // ever shown/editable for an actual text leaf (no child elements at all).
  const isLeaf = el.children.length === 0
  const text = isLeaf ? (el.textContent || '').trim().slice(0, 120) : ''

  // Likewise, a container's own computed font/color reflects nothing in
  // particular when its text children don't all agree — showing it invites
  // editing a value that doesn't actually represent (or won't actually
  // change) everything underneath. Each typography field is only included
  // when every text run in the subtree currently shares that exact value;
  // the panel hides whichever ones don't.
  const textRuns = collectTextRuns(el)
  const mixedTypography: string[] = []
  if (textRuns.length === 0) {
    mixedTypography.push(...TYPOGRAPHY_KEYS)
  } else {
    for (const k of TYPOGRAPHY_KEYS) {
      const values = new Set(textRuns.map((r) => getComputedStyle(r)[k as any] as string))
      if (values.size > 1) mixedTypography.push(k)
      // A single deeper run (el itself has no direct text, but there's
      // exactly one nested leaf) is the value that's actually true —
      // el's own computed style could easily disagree with it.
      else styles[k] = values.values().next().value as string
    }
  }

  const { source, chain } = resolveSource(el)
  const rect = el.getBoundingClientRect()
  return {
    frameToken: FRAME_TOKEN,
    elementId: registerEl(el),
    index: el.parentElement ? Array.from(el.parentElement.children).indexOf(el) : 0,
    siblingCount: el.parentElement ? el.parentElement.children.length : 1,
    isNew: el.hasAttribute('data-pointer-new'),
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    classes: Array.from(el.classList),
    selector: cssSelector(el),
    text,
    mixedTypography,
    componentChain: chain,
    source,
    styles,
    rect: {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      top: Math.round(rect.top),
    },
    sizing: readSizing(el),
    specified: readSpecified(el),
    parentLayout: readParentLayout(el),
    transform: getTransformParts(registerEl(el)),
  }
}

/** How the parent lays its children out. Whether "Fill" means grow, stretch
 * or 100% width depends entirely on this — the same CSS does nothing at all
 * in the wrong kind of parent. */
function readParentLayout(el: Element): SelectionPayload['parentLayout'] {
  const parent = el.parentElement
  if (!parent) return { display: 'block', flexDirection: 'row' }
  const cs = getComputedStyle(parent)
  return { display: cs.display, flexDirection: cs.flexDirection }
}

// ---------- Hug / Fixed / Fill ----------
// Computed styles can't answer this: getComputedStyle always reports a used
// pixel length, so "width: 100%", "width: fit-content" and "width: 240px"
// all come back as the same "240px". The panel used to read the element's
// inline style instead, which is blind to every size that comes from a
// stylesheet — i.e. nearly all of them in a real app — so anything sized by
// a class read as "Hug" no matter what it actually did. What's needed is the
// *specified* value, which means reading the stylesheets the way the
// browser's own Styles pane does.

/** Style rules that set a width or height, gathered once — matching one
 * element against only these (usually a few dozen) instead of against every
 * rule in a framework's stylesheet (often thousands) is what keeps this
 * cheap enough to redo after every edit. */
type SizeRule = { selector: string; width: string; height: string; spec: number }
let sizeRules: SizeRule[] | null = null
let sizeRulesStamp = ''

/** Rough CSS specificity: ids, then classes/attributes/pseudo-classes, then
 * element names, with !important on top. Enough to pick the winner among the
 * handful of rules that size one element; a faithful implementation would
 * need the whole selector grammar. */
function specificityOf(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) || []).length
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length
  const els = (selector.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length
  return ids * 10000 + classes * 100 + els
}

function collectSizeRules(): SizeRule[] {
  // Stylesheets change when a dev server hot-reloads CSS; the count plus the
  // last sheet's rule count is a cheap enough stand-in for "still the same".
  const sheets = Array.from(document.styleSheets)
  let lastCount = 0
  try {
    lastCount = sheets[sheets.length - 1]?.cssRules.length ?? 0
  } catch {
    lastCount = 0
  }
  const stamp = `${sheets.length}:${lastCount}`
  if (sizeRules && sizeRulesStamp === stamp) return sizeRules

  const out: SizeRule[] = []
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        // Only rules that apply right now, at this viewport.
        if (window.matchMedia(rule.conditionText).matches) visit(rule.cssRules)
      } else if (rule instanceof CSSSupportsRule) {
        visit(rule.cssRules)
      } else if (rule instanceof CSSStyleRule) {
        const width = rule.style.getPropertyValue('width')
        const height = rule.style.getPropertyValue('height')
        if (!width && !height) continue
        const important =
          rule.style.getPropertyPriority('width') === 'important' ||
          rule.style.getPropertyPriority('height') === 'important'
        out.push({
          selector: rule.selectorText,
          width,
          height,
          spec: specificityOf(rule.selectorText) + (important ? 1e6 : 0),
        })
      }
    }
  }
  for (const sheet of sheets) {
    try {
      visit(sheet.cssRules)
    } catch {
      // A cross-origin stylesheet — unreadable by design, nothing to do.
    }
  }
  sizeRules = out
  sizeRulesStamp = stamp
  return out
}

/** The size the author actually asked for on this axis ('', 'auto', '100%',
 * 'fit-content', '240px', ...) — inline style first, then the winning rule. */
function specifiedSize(el: HTMLElement, axis: 'width' | 'height'): string {
  const inline = el.style.getPropertyValue(axis)
  if (inline) return inline.trim()
  let best = ''
  let bestSpec = -1
  for (const rule of collectSizeRules()) {
    const v = rule[axis]
    if (!v || rule.spec < bestSpec) continue
    try {
      if (!el.matches(rule.selector)) continue
    } catch {
      continue // a selector this browser can't parse (::v-deep and friends)
    }
    // Ties go to whichever comes last in document order, like the cascade.
    bestSpec = rule.spec
    best = v.trim()
  }
  return best
}

/** Sizes that ask to hug the content outright, as opposed to "auto", which
 * only means "no opinion" — what that ends up doing depends entirely on the
 * parent, so it has to be worked out rather than taken at face value. */
const HUG_KEYWORDS = ['fit-content', 'max-content', 'min-content']

/** Displays whose width shrinks to fit their content rather than filling the
 * space available to them. */
const SHRINK_TO_FIT = /^(inline|table|inline-table|table-cell)/

function sizeModeFor(el: HTMLElement, axis: 'width' | 'height'): SizeMode {
  const spec = specifiedSize(el, axis)
  if (HUG_KEYWORDS.includes(spec)) return 'hug'
  if (spec.endsWith('%')) return spec === '100%' ? 'fill' : 'fixed'
  if (spec !== '' && spec !== 'auto') return 'fixed'

  const cs = getComputedStyle(el)
  const parent = el.parentElement
  const pcs = parent ? getComputedStyle(parent) : null
  if (pcs?.display.includes('flex')) {
    const mainAxis = pcs.flexDirection.startsWith('column') ? 'height' : 'width'
    if (axis === mainAxis) return (parseFloat(cs.flexGrow) || 0) > 0 ? 'fill' : 'hug'
    // Across the parent's main axis it's align-self that decides, falling
    // back to the parent's align-items — which defaults to stretch, so a
    // flex child really does fill this axis unless told otherwise.
    const self = cs.alignSelf === 'auto' ? pcs.alignItems : cs.alignSelf
    return self === 'stretch' || self === 'normal' ? 'fill' : 'hug'
  }
  // Outside flex, only a block-level box in normal flow fills its line;
  // floated, absolutely positioned and inline boxes shrink to fit. Height
  // is always content-driven when it isn't given a length.
  if (axis === 'height') return 'hug'
  if (cs.position === 'absolute' || cs.position === 'fixed') return 'hug'
  if (cs.float !== 'none') return 'hug'
  return SHRINK_TO_FIT.test(cs.display) ? 'hug' : 'fill'
}

function readSizing(el: Element): SelectionPayload['sizing'] {
  if (!(el instanceof HTMLElement)) return { width: 'fixed', height: 'fixed' }
  return { width: sizeModeFor(el, 'width'), height: sizeModeFor(el, 'height') }
}

function readSpecified(el: Element): SelectionPayload['specified'] {
  if (!(el instanceof HTMLElement)) return { width: '', height: '' }
  return { width: specifiedSize(el, 'width'), height: specifiedSize(el, 'height') }
}

function selectElement(el: Element) {
  if (editingEl && editingEl !== el) exitTextEdit(true)
  hidePadBand()
  selectedEl = el
  ensureOverlay()
  positionBox(selectBox!, el)
  clearHighlight()
  drawGridOverlay(el)
  chrome.runtime.sendMessage({ type: 'PTR_SELECTED', payload: buildPayload(el) })
  // A plain (non-shift) select always resets to a single element, same as
  // clicking empty canvas space and re-picking one in Figma.
  if (extraSelectedIds.size) {
    extraSelectedIds = new Set()
    drawExtraBoxes()
  }
  broadcastMultiSelection()
}

// ---------- multi-select ----------
// Shift+click adds or removes an element from the selection, Figma-style.
// The most recently clicked element stays `selectedEl` — the one the
// Element tab reads and edits — while everything picked up along the way
// lives in this set, drawn with a plainer outline of its own and with no
// individual editing. Right now the only thing a multi-selection is for is
// grouping into a new auto-layout container.
let extraSelectedIds = new Set<number>()
let extraBoxes: HTMLDivElement[] = []

function drawExtraBoxes() {
  for (const b of extraBoxes) b.remove()
  extraBoxes = []
  for (const id of extraSelectedIds) {
    const el = getEl(id)
    if (!el) continue
    const r = el.getBoundingClientRect()
    const box = document.createElement('div')
    box.dataset.pointerUi = '1'
    Object.assign(box.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483646',
      top: `${r.top}px`,
      left: `${r.left}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      border: '2px solid #3b82f6',
      borderRadius: '2px',
      boxSizing: 'border-box',
    })
    document.documentElement.appendChild(box)
    extraBoxes.push(box)
  }
}

/** Every currently selected element — the primary plus the extras — in DOM
 * order, as the descriptor list the panel's "N selected" view is built from. */
function broadcastMultiSelection() {
  const ids = new Set(extraSelectedIds)
  if (selectedEl) ids.add(registerEl(selectedEl))
  const items = Array.from(ids)
    .map((id) => ({ id, el: getEl(id) }))
    .filter((x): x is { id: number; el: HTMLElement } => !!x.el)
    .sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    )
    .map(({ id, el }) => ({ elementId: id, descriptor: shortDescriptor(el) }))
  chrome.runtime.sendMessage({ type: 'PTR_MULTI_SELECTED', payload: { items } })
}

function toggleMultiSelect(el: Element) {
  if (editingEl && editingEl !== el) exitTextEdit(true)
  hidePadBand()
  const id = registerEl(el)
  if (selectedEl === el) {
    // Shift-clicking the primary drops it and promotes the most recently
    // added extra, if there is one — it just becomes the one every other
    // control (Position, Fill, ...) reads from.
    selectedEl = null
    const remaining = Array.from(extraSelectedIds)
    const promoted = remaining.pop()
    extraSelectedIds = new Set(remaining)
    if (promoted != null) selectedEl = getEl(promoted)
  } else if (extraSelectedIds.has(id)) {
    extraSelectedIds.delete(id)
  } else {
    if (selectedEl) extraSelectedIds.add(registerEl(selectedEl))
    selectedEl = el
  }

  ensureOverlay()
  clearHighlight()
  if (selectedEl) {
    positionBox(selectBox!, selectedEl)
    drawGridOverlay(selectedEl)
    chrome.runtime.sendMessage({ type: 'PTR_SELECTED', payload: buildPayload(selectedEl) })
  } else {
    hideBox(selectBox)
    clearGridOverlay()
    chrome.runtime.sendMessage({ type: 'PTR_DESELECTED' })
  }
  drawExtraBoxes()
  broadcastMultiSelection()
}

// The general form of Figma's "Add auto layout": wrap two or more selected
// elements in a new flex container without touching anything about them
// individually. Requires them to already be siblings — grouping elements
// from different parents would mean deciding whose coordinate space wins,
// and guessing silently is worse than asking for siblings.
function createAutoLayout(ids: number[]): {
  ok: boolean
  reason?: 'too-few' | 'different-parent'
  payload?: SelectionPayload
  html?: string
  parentDesc?: string
} {
  const els = Array.from(new Set(ids))
    .map((id) => getEl(id))
    .filter((el): el is HTMLElement => !!el)
  if (els.length < 2) return { ok: false, reason: 'too-few' }
  const parent = els[0].parentElement
  if (!parent || els.some((el) => el.parentElement !== parent)) {
    return { ok: false, reason: 'different-parent' }
  }
  const ordered = els.sort((a, b) => siblingIndex(a) - siblingIndex(b))

  const wrapper = document.createElement('div')
  Object.assign(wrapper.style, {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: '8px',
    width: 'fit-content',
  })
  wrapper.setAttribute('data-pointer-new', 'layout')
  parent.insertBefore(wrapper, ordered[0])

  for (const child of ordered) {
    const cid = registerEl(child)
    if (!movePristine.has(cid)) {
      movePristine.set(cid, { parent: child.parentElement!, nextSibling: child.nextSibling })
    }
    wrapper.appendChild(child)
  }

  const wid = registerEl(wrapper)
  insertedEls.set(wid, wrapper)
  selectElement(wrapper)
  schedulePinUpdate()
  return {
    ok: true,
    payload: buildPayload(wrapper),
    html: wrapper.outerHTML,
    parentDesc: shortDescriptor(parent),
  }
}

/**
 * Reverses createAutoLayout: puts every current child of the wrapper back
 * where it came from — via the same movePristine records reparentElement
 * and friends already rely on — then removes the now-empty wrapper.
 *
 * Restoring in reverse DOM order matters: two originally-adjacent children
 * point at each other as their recorded "next sibling", so the later one
 * has to land back first, or the earlier one's anchor won't exist yet.
 */
function ungroup(wrapperId: number): boolean {
  const wrapper = getEl(wrapperId)
  if (!wrapper) return false
  const children = Array.from(wrapper.children)
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i]
    const cid = registerEl(child)
    if (!resetMove(cid)) {
      // No recorded original spot (e.g. added after grouping) — drop it
      // next to the wrapper rather than losing it.
      wrapper.parentElement?.insertBefore(child, wrapper)
    }
  }
  wrapper.remove()
  insertedEls.delete(wrapperId)
  if (selectedEl === wrapper) {
    selectedEl = null
    hideBox(selectBox)
  }
  schedulePinUpdate()
  return true
}

// ---------- edit operations ----------

/** What an element looks like right after an edit — the parts of the
 * selection an edit can change under the panel, which it would otherwise
 * keep reading from the snapshot taken when the element was selected. */
type StyleResult = {
  ok: boolean
  sizing?: SelectionPayload['sizing']
  specified?: SelectionPayload['specified']
  rect?: SelectionPayload['rect']
}

function liveStyleState(el: Element): StyleResult {
  const r = el.getBoundingClientRect()
  return {
    ok: true,
    sizing: readSizing(el),
    specified: readSpecified(el),
    rect: {
      width: Math.round(r.width),
      height: Math.round(r.height),
      left: Math.round(r.left),
      top: Math.round(r.top),
    },
  }
}

function applyStyle(id: number, prop: string, value: string): StyleResult {
  const el = getEl(id)
  if (!el) return { ok: false }
  const p = ensurePristine(id)
  if (!p.inline.has(prop)) p.inline.set(prop, el.style.getPropertyValue(prop))
  el.style.setProperty(prop, value)
  if (selectedEl === el && selectBox) positionBox(selectBox, el)
  return liveStyleState(el)
}

function resetStyle(id: number, prop: string): StyleResult {
  const el = getEl(id)
  if (!el) return { ok: false }
  const original = pristine.get(id)?.inline.get(prop)
  if (original) el.style.setProperty(prop, original)
  else el.style.removeProperty(prop)
  pristine.get(id)?.inline.delete(prop)
  if (selectedEl === el && selectBox) positionBox(selectBox, el)
  return liveStyleState(el)
}

function setText(id: number, value: string): boolean {
  const el = getEl(id)
  if (!el) return false
  const p = ensurePristine(id)
  if (p.text === null) p.text = el.innerText
  el.innerText = value
  return true
}

function resetText(id: number): boolean {
  const el = getEl(id)
  if (!el) return false
  const original = pristine.get(id)?.text
  if (original != null) {
    el.innerText = original
    pristine.get(id)!.text = null
  }
  return true
}

// ---------- reordering ----------
// Where an element sat before Pointer moved it, so the move can be undone
// exactly even after several shuffles.
const movePristine = new Map<number, { parent: Element; nextSibling: Node | null }>()

function siblingIndex(el: Element): number {
  return el.parentElement ? Array.from(el.parentElement.children).indexOf(el) : -1
}

function moveElement(
  id: number,
  dir: 'prev' | 'next'
): { ok: boolean; from?: number; to?: number; parentDesc?: string } {
  const el = getEl(id)
  const parent = el?.parentElement
  if (!el || !parent) return { ok: false }
  const sibling = dir === 'prev' ? el.previousElementSibling : el.nextElementSibling
  if (!sibling) return { ok: false }

  if (!movePristine.has(id)) {
    movePristine.set(id, { parent, nextSibling: el.nextSibling })
  }
  const from = siblingIndex(el)
  if (dir === 'prev') parent.insertBefore(el, sibling)
  else parent.insertBefore(sibling, el)
  const to = siblingIndex(el)

  if (selectBox) positionBox(selectBox, el)
  schedulePinUpdate()
  return { ok: true, from, to, parentDesc: shortDescriptor(parent) }
}

function moveToEdge(
  id: number,
  edge: 'front' | 'back'
): { ok: boolean; from?: number; to?: number; parentDesc?: string } {
  const el = getEl(id)
  const parent = el?.parentElement
  if (!el || !parent) return { ok: false }
  const from = siblingIndex(el)
  if (!movePristine.has(id)) {
    movePristine.set(id, { parent, nextSibling: el.nextSibling })
  }
  if (edge === 'front') parent.appendChild(el)
  else parent.insertBefore(el, parent.firstChild)
  const to = siblingIndex(el)
  if (from === to) return { ok: false }

  if (selectBox) positionBox(selectBox, el)
  schedulePinUpdate()
  return { ok: true, from, to, parentDesc: shortDescriptor(parent) }
}

/** Moves an element to an exact sibling index within its current parent —
 * unlike moveElement/moveToEdge (one adjacent step at a time), this can
 * jump straight to any position. It's what undo/redo replay a 'move' op
 * with: a canvas drag or "move to end" can jump several positions in one
 * user action, and undoing that needs to land back on the exact original
 * index, not just take one step in the right direction. */
function moveElementToIndex(id: number, index: number): { ok: boolean } {
  const el = getEl(id)
  const parent = el?.parentElement
  if (!el || !parent) return { ok: false }
  const siblings = Array.from(parent.children).filter((c) => c !== el)
  const refNode = index < siblings.length ? siblings[index] : null
  if (el === refNode) return { ok: true } // already exactly there
  if (!movePristine.has(id)) {
    movePristine.set(id, { parent, nextSibling: el.nextSibling })
  }
  parent.insertBefore(el, refNode)
  if (selectedEl === el && selectBox) positionBox(selectBox, el)
  schedulePinUpdate()
  return { ok: true }
}

// A place in the tree, as "which parent, at which child index". This is what
// a Layers-tab move is recorded as, so it can be undone/redone exactly even
// when the element crossed into a different parent.
type Placement = { parentId: number; parentDesc: string; index: number }

function placementOf(el: Element): Placement | null {
  const parent = el.parentElement
  if (!parent) return null
  return { parentId: registerEl(parent), parentDesc: shortDescriptor(parent), index: siblingIndex(el) }
}

/** Where the element sat before Pointer ever moved it — its current spot if
 * it hasn't been moved. The panel compares this against where a move lands
 * to describe the *net* change ("moved into X", or nothing at all if it's
 * back where it started), instead of chaining one move onto the last. */
function pristinePlacement(id: number, el: Element): Placement | null {
  const rec = movePristine.get(id)
  if (!rec) return placementOf(el)
  // Walk from the remembered marker to the next real element — skipping
  // text nodes, and the element itself, which may since have landed right
  // back between the marker and its old neighbour.
  let next: Node | null = rec.nextSibling
  while (next && (next.nodeType !== Node.ELEMENT_NODE || next === el)) next = next.nextSibling
  const others = Array.from(rec.parent.children).filter((c) => c !== el)
  const index = next ? others.indexOf(next as Element) : -1
  return {
    parentId: registerEl(rec.parent),
    parentDesc: shortDescriptor(rec.parent),
    index: index < 0 ? others.length : index,
  }
}

// from: where it sat just before this move. origin: where it sat before
// Pointer ever touched it. to: where it is now.
type MoveResult = {
  ok: boolean
  target?: SelectionPayload
  from?: Placement
  origin?: Placement
  to?: Placement
}

function afterElementMoved(el: Element) {
  if (selectedEl === el && selectBox) positionBox(selectBox, el)
  if (selectedEl) drawGridOverlay(selectedEl)
  schedulePinUpdate()
}

// Arbitrary drag-and-drop from the Layers tab — not limited to swapping with
// an adjacent sibling like moveElement/moveToEdge (those back the Position
// tab's Back/Forward buttons), this can also move an element into a
// completely different parent, like dragging a layer in Figma.
//   before / after — as a sibling of `target`, on that side of it
//   inside         — as the last child of `target` (i.e. "put it in the div")
function reparentElement(
  id: number,
  targetId: number,
  position: 'before' | 'after' | 'inside'
): MoveResult {
  const el = getEl(id)
  const target = getEl(targetId)
  if (!el || !target || el === target) return { ok: false }
  // Dropping onto (or before/after, which still resolves inside) one of the
  // dragged element's own descendants would detach it from the document.
  if (el.contains(target)) return { ok: false }

  const parent = position === 'inside' ? target : target.parentElement
  if (!parent) return { ok: false }
  const from = placementOf(el)
  if (!from) return { ok: false }

  // Work out where it would land before touching the DOM, so a drop that
  // resolves to its current spot (e.g. "after" its own previous sibling)
  // is a clean no-op rather than a recorded edit.
  const others = Array.from(parent.children).filter((c) => c !== el)
  const index =
    position === 'inside'
      ? others.length
      : others.indexOf(target) + (position === 'after' ? 1 : 0)
  if (parent === el.parentElement && index === from.index) return { ok: false }

  if (!movePristine.has(id)) {
    movePristine.set(id, { parent: el.parentElement!, nextSibling: el.nextSibling })
  }
  parent.insertBefore(el, index < others.length ? others[index] : null)
  afterElementMoved(el)
  return { ok: true, target: buildPayload(el), from, origin: pristinePlacement(id, el)!, to: placementOf(el)! }
}

/** Puts an element at an exact (parent, index) — what undo/redo replays a
 * Layers-tab move with, since such a move may have crossed parents. */
function placeElement(id: number, parentId: number, index: number): MoveResult {
  const el = getEl(id)
  const parent = getEl(parentId)
  if (!el || !parent || el === parent || el.contains(parent)) return { ok: false }
  const from = placementOf(el)
  if (!from) return { ok: false }
  if (!movePristine.has(id)) {
    movePristine.set(id, { parent: el.parentElement!, nextSibling: el.nextSibling })
  }
  const siblings = Array.from(parent.children).filter((c) => c !== el)
  const refNode = index < siblings.length ? siblings[index] : null
  parent.insertBefore(el, refNode)
  afterElementMoved(el)
  return { ok: true, target: buildPayload(el), from, origin: pristinePlacement(id, el)!, to: placementOf(el)! }
}

function resetMove(id: number): boolean {
  const el = getEl(id)
  const rec = movePristine.get(id)
  if (!el || !rec) return false
  rec.parent.insertBefore(el, rec.nextSibling)
  movePristine.delete(id)
  if (selectBox) positionBox(selectBox, el)
  schedulePinUpdate()
  return true
}

// ---------- inserting new elements ----------
// Elements Pointer itself created. They're plain DOM nodes with inline
// styles, so they behave like any other element for selection and editing —
// but they're tracked so they can be removed on undo and described in the
// prompt as additions rather than edits.
const insertedEls = new Map<number, Element>()

type InsertKind = 'layout' | 'rect' | 'circle' | 'text'

function buildNewElement(kind: InsertKind): HTMLElement {
  const el = document.createElement('div')
  switch (kind) {
    case 'layout':
      Object.assign(el.style, {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: '12px',
        padding: '16px',
        minWidth: '160px',
        minHeight: '64px',
        border: '1px dashed #94a3b8',
        borderRadius: '8px',
      })
      break
    case 'rect':
      Object.assign(el.style, {
        width: '120px',
        height: '80px',
        background: '#3b82f6',
        borderRadius: '8px',
      })
      break
    case 'circle':
      Object.assign(el.style, {
        width: '80px',
        height: '80px',
        background: '#8b5cf6',
        borderRadius: '50%',
      })
      break
    case 'text':
      el.textContent = 'New text'
      Object.assign(el.style, {
        fontSize: '16px',
        fontWeight: '400',
        color: '#0f172a',
      })
      break
  }
  return el
}

function insertElement(
  kind: InsertKind,
  targetId: number | null,
  position: 'inside' | 'after'
): { ok: boolean; payload?: SelectionPayload; html?: string; parentDesc?: string } {
  const anchor = targetId != null ? getEl(targetId) : document.body
  if (!anchor) return { ok: false }

  const el = buildNewElement(kind)
  el.setAttribute('data-pointer-new', kind)

  if (position === 'inside') anchor.appendChild(el)
  else anchor.parentElement?.insertBefore(el, anchor.nextSibling)

  const id = registerEl(el)
  insertedEls.set(id, el)
  selectElement(el)
  return {
    ok: true,
    payload: buildPayload(el),
    html: el.outerHTML,
    parentDesc: shortDescriptor(el.parentElement ?? document.body),
  }
}

function removeInserted(id: number): boolean {
  const el = insertedEls.get(id)
  if (!el) return false
  el.remove()
  insertedEls.delete(id)
  if (selectedEl === el) {
    selectedEl = null
    hideBox(selectBox)
  }
  if (extraSelectedIds.delete(id)) drawExtraBoxes()
  broadcastMultiSelection()
  return true
}

// ---------- delete / duplicate ----------
// Deleting keeps the node around (detached) so it can be put back exactly
// where it was; Pointer never destroys page content irreversibly.
const deletedEls = new Map<number, { el: Element; parent: Element; nextSibling: Node | null }>()

function deleteElement(id: number): { ok: boolean; desc?: string; inserted?: boolean } {
  // Elements Pointer itself added are simply dropped — there's nothing in
  // the real page to restore.
  if (insertedEls.has(id)) {
    const desc = shortDescriptor(insertedEls.get(id)!)
    return { ok: removeInserted(id), desc, inserted: true }
  }
  const el = getEl(id)
  if (!el?.parentElement) return { ok: false }
  deletedEls.set(id, { el, parent: el.parentElement, nextSibling: el.nextSibling })
  const desc = shortDescriptor(el)
  el.remove()
  if (selectedEl === el) {
    selectedEl = null
    hideBox(selectBox)
  }
  if (extraSelectedIds.delete(id)) drawExtraBoxes()
  broadcastMultiSelection()
  schedulePinUpdate()
  return { ok: true, desc }
}

function restoreElement(id: number): boolean {
  const rec = deletedEls.get(id)
  if (!rec) return false
  rec.parent.insertBefore(rec.el, rec.nextSibling)
  deletedEls.delete(id)
  schedulePinUpdate()
  return true
}

function duplicateElement(
  id: number
): { ok: boolean; payload?: SelectionPayload; html?: string; parentDesc?: string } {
  const el = getEl(id)
  if (!el?.parentElement) return { ok: false }
  const clone = el.cloneNode(true) as Element
  // Comment anchors are per-element; a copy must not claim the original's.
  clone.removeAttribute('data-pointer-cid')
  clone.querySelectorAll('[data-pointer-cid]').forEach((n) => n.removeAttribute('data-pointer-cid'))
  clone.setAttribute('data-pointer-new', 'duplicate')
  el.parentElement.insertBefore(clone, el.nextSibling)
  const cloneId = registerEl(clone)
  insertedEls.set(cloneId, clone)
  selectElement(clone)
  return {
    ok: true,
    payload: buildPayload(clone),
    html: clone.outerHTML,
    parentDesc: shortDescriptor(el.parentElement),
  }
}

function resetAll() {
  for (const [id, p] of pristine) {
    const el = getEl(id)
    if (!el) continue
    for (const [prop, original] of p.inline) {
      if (original) el.style.setProperty(prop, original)
      else el.style.removeProperty(prop)
    }
    if (p.text != null) el.innerText = p.text
  }
  pristine.clear()
  for (const id of Array.from(movePristine.keys())) resetMove(id)
  for (const id of Array.from(deletedEls.keys())) restoreElement(id)
  for (const id of Array.from(insertedEls.keys())) removeInserted(id)
  if (selectedEl && selectBox) positionBox(selectBox, selectedEl)
}

// ---------- design tokens (CSS custom properties) ----------

const tokenPristine = new Map<string, string>()

function getTokens(): { name: string; value: string }[] {
  const seen = new Map<string, string>()
  // Walk same-origin stylesheets for :root / html custom property declarations.
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // cross-origin stylesheet
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue
      const sel = rule.selectorText
      if (!/(^|,)\s*(:root|html)\s*($|,)/.test(sel)) continue
      for (const prop of Array.from(rule.style)) {
        if (prop.startsWith('--')) {
          // Live value (reflects any override we applied).
          const live = getComputedStyle(document.documentElement)
            .getPropertyValue(prop)
            .trim()
          seen.set(prop, live || rule.style.getPropertyValue(prop).trim())
        }
      }
    }
  }
  return Array.from(seen, ([name, value]) => ({ name, value }))
}

function setToken(name: string, value: string) {
  if (!tokenPristine.has(name)) {
    tokenPristine.set(
      name,
      document.documentElement.style.getPropertyValue(name)
    )
  }
  // 'important' guarantees this wins even if another !important rule
  // (e.g. a reset or a dark-mode override) also targets this variable.
  document.documentElement.style.setProperty(name, value, 'important')
  // Diagnostic: if this ever mismatches, something outside Pointer is
  // overriding the variable after we set it. Open this page's own
  // devtools console (not the extension panel's) to see this.
  const readBack = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  console.log(
    `[Pointer] set ${name} = "${value}" → computed reads "${readBack}"`
  )
}

function resetToken(name: string) {
  const original = tokenPristine.get(name)
  if (original) document.documentElement.style.setProperty(name, original, 'important')
  else document.documentElement.style.removeProperty(name)
  tokenPristine.delete(name)
}

// ---------- comments ----------

type PointerComment = {
  id: string
  selector: string
  descriptor: string
  text: string
  createdAt: number
}

// Comments used to live in this page's own localStorage — which the browser
// scopes per *origin*, port included. Dev servers (Vite, Next…) routinely
// come up on a different port after a restart if the usual one is still
// held by something, which silently swapped the whole storage bucket out
// from under Pointer — the comments weren't deleted, just stranded on an
// origin you'd stopped visiting. chrome.storage.local lives with the
// extension instead, so it doesn't care which port the app happens to be
// on this time. Keyed by pathname alone (not origin) so a comment survives
// that swap; the tradeoff is that two different local projects that happen
// to share a route path (e.g. both have "/") would share its comments too
// — acceptable for a tool used on one app at a time.
const COMMENTS_KEY = () => `pointer_comments:${location.pathname}`
const COMMENTS_VISIBLE_KEY = '__pointer_comments_visible__'

let commentMode = false
let commentsVisible = localStorage.getItem(COMMENTS_VISIBLE_KEY) !== '0'
const pinEls: HTMLDivElement[] = []

// In-memory mirror of chrome.storage.local so the many synchronous call
// sites (rendering pins, etc.) don't all need to become async. Loaded once
// at startup below; every write updates both the cache and storage.
let commentsCache: PointerComment[] = []
let commentsLoaded = false

async function initComments() {
  const key = COMMENTS_KEY()
  const result = await chrome.storage.local.get(key)
  commentsCache = (result[key] as PointerComment[] | undefined) ?? []
  commentsLoaded = true
  renderPins()
}
void initComments()

function loadComments(): PointerComment[] {
  return commentsCache
}

async function saveComments(comments: PointerComment[]) {
  commentsCache = comments
  await chrome.storage.local.set({ [COMMENTS_KEY()]: comments })
}

function clearPins() {
  for (const p of pinEls) p.remove()
  pinEls.length = 0
}

// Resolve a comment back to its DOM element: prefer the exact node it was
// created on (tagged with a data attribute, unambiguous), fall back to the
// reconstructed selector only if that node is gone (e.g. after a reload).
function resolveCommentEl(c: PointerComment): Element | null {
  const tagged = document.querySelector(`[data-pointer-cid="${c.id}"]`)
  if (tagged) return tagged
  try {
    return document.querySelector(c.selector)
  } catch {
    return null
  }
}

let selectedCommentId: string | null = null

function renderPins() {
  clearPins()
  if (!commentsVisible) return
  const comments = loadComments()
  comments.forEach((c, i) => {
    const el = resolveCommentEl(c)
    if (!el) return
    if (!el.hasAttribute('data-pointer-cid')) el.setAttribute('data-pointer-cid', c.id)
    const r = el.getBoundingClientRect()
    const isSelected = c.id === selectedCommentId
    const pin = document.createElement('div')
    pin.textContent = String(i + 1)
    pin.title = c.text
    pin.dataset.pointerPin = c.id
    const size = isSelected ? 26 : 20
    Object.assign(pin.style, {
      position: 'fixed',
      top: `${r.top - size / 2}px`,
      left: `${r.left + r.width - size / 2}px`,
      zIndex: '2147483647',
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '50% 50% 50% 4px',
      background: isSelected ? '#5b21b6' : '#7c3aed',
      color: '#fff',
      font: `bold ${isSelected ? 13 : 11}px/${size}px system-ui, sans-serif`,
      textAlign: 'center',
      // Clickable so a pin can open its comment in the panel.
      pointerEvents: 'auto',
      cursor: 'pointer',
      boxShadow: isSelected
        ? '0 0 0 3px rgba(124,58,237,0.35), 0 1px 4px rgba(0,0,0,0.3)'
        : '0 1px 4px rgba(0,0,0,0.3)',
    })
    pin.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      selectedCommentId = c.id
      renderPins()
      chrome.runtime.sendMessage({
        type: 'PTR_COMMENT_CLICKED',
        payload: { id: c.id, frameToken: FRAME_TOKEN },
      })
    })
    document.documentElement.appendChild(pin)
    pinEls.push(pin)
  })
}

// Keep pins glued to their elements while scrolling/resizing.
let pinRaf = 0
function schedulePinUpdate() {
  cancelAnimationFrame(pinRaf)
  pinRaf = requestAnimationFrame(renderPins)
}
window.addEventListener('scroll', schedulePinUpdate, true)
window.addEventListener('resize', schedulePinUpdate)
// Initial render once the page settles.
setTimeout(renderPins, 500)

// ---------- event handlers ----------

// ---------- Figma-style measurement & navigation micro-interactions ----------

function toKebabCase(p: string): string {
  return p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
}

function makeMeasureLine(): HTMLDivElement {
  const line = document.createElement('div')
  Object.assign(line.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483645',
    background: '#f43f5e',
    display: 'none',
  })
  document.documentElement.appendChild(line)
  return line
}

function makeMeasureLabel(): HTMLDivElement {
  const label = document.createElement('div')
  Object.assign(label.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483647',
    background: '#f43f5e',
    color: '#fff',
    font: 'bold 10px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '1px 4px',
    borderRadius: '3px',
    display: 'none',
    whiteSpace: 'nowrap',
  })
  document.documentElement.appendChild(label)
  return label
}

// A small pool of reusable line/label nodes, repositioned per frame instead
// of recreated — cheap enough to update at mousemove rate.
const measure: {
  hLine: HTMLDivElement | null
  vLine: HTMLDivElement | null
  hLabel: HTMLDivElement | null
  vLabel: HTMLDivElement | null
  // Shaded regions with a number in them — the four padding sides plus one
  // per gap between children, so the count isn't fixed.
  bands: HTMLDivElement[]
  bandLabels: HTMLDivElement[]
  bandsUsed: number
} = { hLine: null, vLine: null, hLabel: null, vLabel: null, bands: [], bandLabels: [], bandsUsed: 0 }

function ensureMeasure() {
  if (measure.hLine) return
  measure.hLine = makeMeasureLine()
  measure.vLine = makeMeasureLine()
  measure.hLabel = makeMeasureLabel()
  measure.vLabel = makeMeasureLabel()
}

function resetBands() {
  measure.bandsUsed = 0
  for (const b of measure.bands) hideBox(b)
  for (const l of measure.bandLabels) hideBox(l)
}

/** Shade one spacing region and print its value in the middle. */
function addBand(left: number, top: number, width: number, height: number, value: number) {
  if (value <= 0.5 || width <= 0 || height <= 0) return
  const i = measure.bandsUsed++
  if (i === measure.bands.length) {
    measure.bands.push(makeMeasureLine())
    measure.bandLabels.push(makeMeasureLabel())
  }
  Object.assign(measure.bands[i].style, {
    display: 'block',
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    background: 'rgba(244, 63, 94, 0.25)',
  })
  placeLabel(measure.bandLabels[i], left + width / 2 - 8, top + height / 2 - 8, `${Math.round(value)}`)
}

function hideMeasure() {
  if (!measure.hLine) return
  hideBox(measure.hLine)
  hideBox(measure.vLine)
  hideBox(measure.hLabel)
  hideBox(measure.vLabel)
  resetBands()
}

function placeHLine(line: HTMLDivElement, x1: number, x2: number, y: number) {
  Object.assign(line.style, {
    display: 'block',
    left: `${Math.min(x1, x2)}px`,
    top: `${y}px`,
    width: `${Math.abs(x2 - x1)}px`,
    height: '1px',
  })
}

function placeVLine(line: HTMLDivElement, y1: number, y2: number, x: number) {
  Object.assign(line.style, {
    display: 'block',
    left: `${x}px`,
    top: `${Math.min(y1, y2)}px`,
    width: '1px',
    height: `${Math.abs(y2 - y1)}px`,
  })
}

function placeLabel(label: HTMLDivElement, x: number, y: number, text: string) {
  label.textContent = text
  Object.assign(label.style, { display: 'block', left: `${x}px`, top: `${y}px` })
}

// Alt + hover a different element than the current selection: show the gap
// between them (Figma's "measure against selection").
function drawDistanceOverlay(a: Element, b: Element) {
  ensureMeasure()
  const ra = a.getBoundingClientRect()
  const rb = b.getBoundingClientRect()

  let horizontalGap: number | null = null
  let hx1 = 0
  let hx2 = 0
  if (rb.left >= ra.right) {
    horizontalGap = rb.left - ra.right
    hx1 = ra.right
    hx2 = rb.left
  } else if (rb.right <= ra.left) {
    horizontalGap = ra.left - rb.right
    hx1 = rb.right
    hx2 = ra.left
  }
  if (horizontalGap !== null) {
    const overlapTop = Math.max(ra.top, rb.top)
    const overlapBottom = Math.min(ra.bottom, rb.bottom)
    const hy = overlapBottom > overlapTop ? (overlapTop + overlapBottom) / 2 : (ra.top + rb.top) / 2
    placeHLine(measure.hLine!, hx1, hx2, hy)
    placeLabel(measure.hLabel!, (hx1 + hx2) / 2 - 12, hy - 18, `${Math.round(horizontalGap)}`)
  } else {
    hideBox(measure.hLine)
    hideBox(measure.hLabel)
  }

  let verticalGap: number | null = null
  let vy1 = 0
  let vy2 = 0
  if (rb.top >= ra.bottom) {
    verticalGap = rb.top - ra.bottom
    vy1 = ra.bottom
    vy2 = rb.top
  } else if (rb.bottom <= ra.top) {
    verticalGap = ra.top - rb.bottom
    vy1 = rb.bottom
    vy2 = ra.top
  }
  if (verticalGap !== null) {
    const overlapLeft = Math.max(ra.left, rb.left)
    const overlapRight = Math.min(ra.right, rb.right)
    const vx = overlapRight > overlapLeft ? (overlapLeft + overlapRight) / 2 : (ra.left + rb.left) / 2
    placeVLine(measure.vLine!, vy1, vy2, vx)
    placeLabel(measure.vLabel!, vx + 6, (vy1 + vy2) / 2 - 8, `${Math.round(verticalGap)}`)
  } else {
    hideBox(measure.vLine)
    hideBox(measure.vLabel)
  }

  ensureOverlay()
  positionBox(hoverBox!, b)
}

/**
 * What Figma shows while you hold Option with an auto-layout frame selected:
 * the frame's four padding bands and the gaps between its children, each
 * labelled with its value.
 *
 * Anchored on the *selection*, never on whatever the cursor happens to be
 * over. Deriving it from the deepest element under the pointer is how a DOM
 * inspector works, and it's why this used to appear only over the handful of
 * pixels the container itself owned — step onto a child and the readout was
 * suddenly about the child instead.
 */
function drawSpacingOverlay(el: Element) {
  ensureMeasure()
  ensureOverlay()
  positionBox(hoverBox!, el)
  resetBands()
  hideBox(measure.hLine)
  hideBox(measure.vLine)
  hideBox(measure.hLabel)
  hideBox(measure.vLabel)

  const r = el.getBoundingClientRect()
  const s = getComputedStyle(el)
  const pt = pf(s.paddingTop)
  const pr = pf(s.paddingRight)
  const pb = pf(s.paddingBottom)
  const pl = pf(s.paddingLeft)
  const innerTop = r.top + pt
  const innerHeight = Math.max(0, r.height - pt - pb)
  addBand(r.left, r.top, r.width, pt, pt)
  addBand(r.left, r.bottom - pb, r.width, pb, pb)
  addBand(r.left, innerTop, pl, innerHeight, pl)
  addBand(r.right - pr, innerTop, pr, innerHeight, pr)

  drawChildGaps(el, s)
}

/** The spacing between an auto layout's items — the other half of what
 * Option reveals in Figma, and the part a padding-only readout misses. */
function drawChildGaps(el: Element, s: CSSStyleDeclaration) {
  const rects = Array.from(el.children)
    .filter((c) => !isPointerUi(c) && !SKIP_TAGS.has(c.tagName))
    .map((c) => c.getBoundingClientRect())
    .filter((k) => k.width > 0 && k.height > 0)
  if (rects.length < 2) return

  const byTop = rects.slice().sort((a, b) => a.top - b.top)
  const byLeft = rects.slice().sort((a, b) => a.left - b.left)
  const stacksDown = byTop.every((k, i) => i === 0 || k.top >= byTop[i - 1].bottom - 0.5)
  const stacksAcross = byLeft.every((k, i) => i === 0 || k.left >= byLeft[i - 1].right - 0.5)
  // Flex says which way it runs; anything else has to be read off the
  // geometry, and children that overlap aren't a stack at all.
  const vertical = s.display.includes('flex')
    ? s.flexDirection.startsWith('column')
    : stacksDown
  if (vertical ? !stacksDown : !stacksAcross) return

  const order = vertical ? byTop : byLeft
  for (let i = 1; i < order.length; i++) {
    const prev = order[i - 1]
    const next = order[i]
    if (vertical) {
      const gap = next.top - prev.bottom
      const left = Math.max(prev.left, next.left)
      const right = Math.min(prev.right, next.right)
      addBand(left, prev.bottom, Math.max(0, right - left), gap, gap)
    } else {
      const gap = next.left - prev.right
      const top = Math.max(prev.top, next.top)
      const bottom = Math.min(prev.bottom, next.bottom)
      addBand(prev.right, top, gap, Math.max(0, bottom - top), gap)
    }
  }
}

/**
 * Which element a measurement runs to. Figma's plain Option measures to the
 * object sitting at the same level as the selection, and ⌘Option drills into
 * whatever is nested under the cursor. A DOM pointer always lands on the
 * deepest node, so plain Option is the one that has to walk back up.
 */
function measureTarget(el: Element, deep: boolean): Element {
  const parent = selectedEl?.parentElement
  if (deep || !parent) return el
  let node: Element | null = el
  while (node?.parentElement && node.parentElement !== parent) node = node.parentElement
  return node?.parentElement === parent ? node : el
}

// Grid overlay: automatically shown while a CSS grid container is selected.
let gridLines: HTMLDivElement[] = []

function clearGridOverlay() {
  for (const l of gridLines) l.remove()
  gridLines = []
}

function drawGridOverlay(el: Element) {
  clearGridOverlay()
  const s = getComputedStyle(el)
  if (s.display !== 'grid' && s.display !== 'inline-grid') return
  const r = el.getBoundingClientRect()
  const pl = parseFloat(s.paddingLeft) || 0
  const pt = parseFloat(s.paddingTop) || 0
  const cols = s.gridTemplateColumns.split(' ').map(parseFloat).filter((n) => !Number.isNaN(n))
  const rows = s.gridTemplateRows.split(' ').map(parseFloat).filter((n) => !Number.isNaN(n))
  const colGap = parseFloat(s.columnGap) || 0
  const rowGap = parseFloat(s.rowGap) || 0

  const addLine = (style: Partial<CSSStyleDeclaration>) => {
    const line = document.createElement('div')
    Object.assign(line.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483644',
      background: 'rgba(139, 92, 246, 0.5)',
      ...style,
    })
    document.documentElement.appendChild(line)
    gridLines.push(line)
  }

  let x = r.left + pl
  cols.forEach((w, i) => {
    if (i > 0) {
      addLine({ left: `${x - colGap / 2}px`, top: `${r.top}px`, width: '1px', height: `${r.height}px` })
    }
    x += w + colGap
  })
  let y = r.top + pt
  rows.forEach((h, i) => {
    if (i > 0) {
      addLine({ left: `${r.left}px`, top: `${y - rowGap / 2}px`, width: `${r.width}px`, height: '1px' })
    }
    y += h + rowGap
  })
}

// "H": highlight every other element that shares the selected element's
// exact class list — a stand-in for "same component" without needing a
// full framework-aware component match.
let highlightEls: HTMLDivElement[] = []

function clearHighlight() {
  for (const b of highlightEls) b.remove()
  highlightEls = []
}

function toggleHighlightSiblings() {
  if (highlightEls.length) {
    clearHighlight()
    return
  }
  if (!selectedEl) return
  const cls = Array.from(selectedEl.classList)
  if (!cls.length) return
  let matches: Element[] = []
  try {
    matches = Array.from(document.querySelectorAll('.' + cls.map((c) => CSS.escape(c)).join('.')))
  } catch {
    return
  }
  for (const m of matches) {
    if (m === selectedEl) continue
    const r = m.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const box = document.createElement('div')
    Object.assign(box.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483645',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      border: '1.5px dashed #8b5cf6',
      boxSizing: 'border-box',
      borderRadius: '2px',
    })
    document.documentElement.appendChild(box)
    highlightEls.push(box)
  }
}

// A small transient toast for keyboard-triggered actions (copy/paste style).
let toastEl: HTMLDivElement | null = null

function flashToast(text: string) {
  if (!toastEl) {
    toastEl = document.createElement('div')
    Object.assign(toastEl.style, {
      position: 'fixed',
      top: '16px',
      left: '16px',
      zIndex: '2147483647',
      background: '#171717',
      color: '#fafafa',
      font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      padding: '6px 10px',
      borderRadius: '6px',
      pointerEvents: 'none',
      display: 'none',
    })
    document.documentElement.appendChild(toastEl)
  }
  toastEl.textContent = text
  toastEl.style.display = 'block'
  clearTimeout((toastEl as any)._t)
  ;(toastEl as any)._t = setTimeout(() => {
    if (toastEl) toastEl.style.display = 'none'
  }, 1000)
}

// "C" / "V": copy the selected element's computed style, paste it onto
// whatever's currently hovered.
let styleClipboard: Record<string, string> | null = null

function copyStyleFromSelected() {
  if (!selectedEl) return
  const s = getComputedStyle(selectedEl)
  const snap: Record<string, string> = {}
  for (const p of STYLE_PROPS) snap[p] = s[p as any] as string
  styleClipboard = snap
  flashToast('Style copied — hover a target and press V')
}

function pasteStyleToHovered() {
  if (!styleClipboard || !hoverEl) return
  const id = registerEl(hoverEl)
  const before = buildPayload(hoverEl)
  const changes: { prop: string; from: string; to: string }[] = []
  for (const [prop, value] of Object.entries(styleClipboard)) {
    if (before.styles[prop] === value) continue
    applyStyle(id, toKebabCase(prop), value)
    changes.push({ prop, from: before.styles[prop], to: value })
  }
  if (!changes.length) return
  chrome.runtime.sendMessage({
    type: 'PTR_STYLE_PASTED',
    payload: { target: buildPayload(hoverEl), changes },
  })
  flashToast('Style pasted')
}

// Position and rotation both live in `transform`, which sidesteps the page's
// own margins/layout. They're stored decomposed so the panel can offer them
// as separate fields the way Figma does, then recomposed into one value.
type TransformParts = { dx: number; dy: number; rotate: number }
const transforms = new Map<number, TransformParts>()

function getTransformParts(id: number): TransformParts {
  return transforms.get(id) ?? { dx: 0, dy: 0, rotate: 0 }
}

function composeTransform(t: TransformParts): string {
  const parts: string[] = []
  if (t.dx || t.dy) parts.push(`translate(${t.dx}px, ${t.dy}px)`)
  if (t.rotate) parts.push(`rotate(${t.rotate}deg)`)
  return parts.length ? parts.join(' ') : 'none'
}

function setTransform(id: number, next: Partial<TransformParts>): { from: string; to: string } {
  const cur = getTransformParts(id)
  const merged = { ...cur, ...next }
  transforms.set(id, merged)
  const from = composeTransform(cur)
  const to = composeTransform(merged)
  applyStyle(id, 'transform', to)
  return { from, to }
}

/** Only an out-of-flow element (position: absolute/fixed) has an X/Y that
 * means anything to nudge — a normal flow child's position is decided by
 * layout, not by an offset sitting on top of it. */
function isOutOfFlow(el: Element): boolean {
  const pos = getComputedStyle(el).position
  return pos === 'absolute' || pos === 'fixed'
}

function nudgeSelected(dx: number, dy: number) {
  if (!selectedEl) return
  const id = registerEl(selectedEl)
  const before = buildPayload(selectedEl)
  const cur = getTransformParts(id)
  const { from, to } = setTransform(id, { dx: cur.dx + dx, dy: cur.dy + dy })
  chrome.runtime.sendMessage({
    type: 'PTR_NUDGED',
    payload: { elementId: id, value: to, from, target: before },
  })
}

/** Figma's Escape: clear the selection outright. (Stepping *up* a level is
 * Shift+Return there, not Escape — see selectParent.) */
function deselectAll() {
  selectedEl = null
  hideBox(selectBox)
  clearGridOverlay()
  chrome.runtime.sendMessage({ type: 'PTR_DESELECTED' })
  if (extraSelectedIds.size) {
    extraSelectedIds = new Set()
    drawExtraBoxes()
  }
  broadcastMultiSelection()
}

/** Figma's Shift+Return (and backslash): select the parent layer. */
function selectParent(): boolean {
  const parent = selectedEl?.parentElement
  if (!parent || parent === document.documentElement) return false
  selectElement(parent)
  return true
}

// Figma's Enter/Return: dive into the first child of the current selection.
function selectFirstChild(): boolean {
  const child = selectedEl?.children[0]
  if (!child) return false
  selectElement(child)
  return true
}

/** Figma's Tab / Shift+Tab: move to the next or previous sibling layer,
 * stepping over Pointer's own overlay nodes and non-visual tags. */
function selectSibling(dir: 'next' | 'prev'): boolean {
  if (!selectedEl) return false
  let sib = dir === 'next' ? selectedEl.nextElementSibling : selectedEl.previousElementSibling
  while (sib && (SKIP_TAGS.has(sib.tagName) || isPointerUi(sib))) {
    sib = dir === 'next' ? sib.nextElementSibling : sib.previousElementSibling
  }
  if (!sib) return false
  selectElement(sib)
  return true
}

// ---------- the pressed-keys overlay ----------
// A read-out of the shortcut that just fired, bottom-centre over the page.
// It only appears for combinations Pointer actually acted on, so it doubles
// as confirmation that the shortcut registered — the thing you're left
// guessing about when a key does nothing.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const KEY_SYMBOLS: Record<string, string> = {
  Enter: '↩',
  Escape: 'esc',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'space',
}

function keyHintFor(e: KeyboardEvent): string[] {
  const parts: string[] = []
  if (e.ctrlKey) parts.push(IS_MAC ? '⌃' : 'Ctrl')
  if (e.altKey) parts.push(IS_MAC ? '⌥' : 'Alt')
  if (e.shiftKey) parts.push(IS_MAC ? '⇧' : 'Shift')
  if (e.metaKey) parts.push(IS_MAC ? '⌘' : 'Win')
  const key = KEY_SYMBOLS[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
  parts.push(key)
  return parts
}

let keyHintEl: HTMLDivElement | null = null
let keyHintTimer: number | null = null

function showKeyHint(e: KeyboardEvent) {
  if (!keyHintEl) {
    keyHintEl = document.createElement('div')
    keyHintEl.dataset.pointerUi = '1'
    Object.assign(keyHintEl.style, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      display: 'flex',
      gap: '4px',
      alignItems: 'center',
      padding: '6px 8px',
      borderRadius: '8px',
      background: 'rgba(23,23,23,0.92)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 120ms ease',
    })
    document.documentElement.appendChild(keyHintEl)
  }
  keyHintEl.textContent = ''
  for (const part of keyHintFor(e)) {
    const cap = document.createElement('span')
    cap.textContent = part
    Object.assign(cap.style, {
      font: '600 12px/1 ui-sans-serif, -apple-system, system-ui, sans-serif',
      color: '#fafafa',
      background: 'rgba(255,255,255,0.14)',
      borderRadius: '4px',
      padding: '5px 7px',
      minWidth: '12px',
      textAlign: 'center',
    })
    keyHintEl.appendChild(cap)
  }
  keyHintEl.style.opacity = '1'
  if (keyHintTimer != null) window.clearTimeout(keyHintTimer)
  keyHintTimer = window.setTimeout(() => {
    if (keyHintEl) keyHintEl.style.opacity = '0'
  }, 900)
}

function hideKeyHint() {
  if (keyHintTimer != null) window.clearTimeout(keyHintTimer)
  keyHintTimer = null
  keyHintEl?.remove()
  keyHintEl = null
}

/**
 * Figma's macOS bindings, as documented, with three deliberate departures:
 *
 *  - Arrow keys reorder among siblings instead of nudging by a pixel. In a
 *    DOM there's nowhere for a nudge to go — layout puts a normal-flow
 *    element wherever the flow dictates — so an offset would be a visual
 *    hack sitting on top of it. Elements taken out of flow still nudge.
 *  - Alt+H highlights everything sharing the selection's classes. It has no
 *    Figma counterpart, and bare H is Figma's Hand tool.
 *  - Bare C/V/etc. stay untouched: those pick tools on a canvas Pointer
 *    doesn't have, and swallowing them would only break the page's own keys.
 *
 * Returns whether the key was acted on, so the caller can show the key
 * overlay for exactly the combinations that did something.
 */
function handleShortcut(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey

  // --- selection ---
  // Figma: Return selects the child, Shift+Return (or \) the parent, Tab and
  // Shift+Tab the siblings, Escape deselects. Escape used to walk *up* the
  // tree here, which is Shift+Return's job.
  if (e.key === 'Enter' && !mod && selectedEl) {
    e.preventDefault()
    return e.shiftKey ? selectParent() : selectFirstChild()
  }
  if (e.key === '\\' && !mod && selectedEl) {
    e.preventDefault()
    return selectParent()
  }
  if (e.key === 'Tab' && !mod && selectedEl) {
    e.preventDefault()
    return selectSibling(e.shiftKey ? 'prev' : 'next')
  }
  if (e.key === 'Escape' && selectedEl) {
    e.preventDefault()
    deselectAll()
    return true
  }

  // --- history ---
  // Held by the panel (it's what the Undo/Redo buttons drive), so these just
  // ask it to act.
  if (e.key.toLowerCase() === 'z' && mod) {
    e.preventDefault()
    chrome.runtime.sendMessage({ type: e.shiftKey ? 'PTR_REQUEST_REDO' : 'PTR_REQUEST_UNDO' })
    return true
  }

  // --- auto layout (Figma: Shift+A) ---
  if (e.key.toLowerCase() === 'a' && e.shiftKey && !mod && !e.altKey) {
    e.preventDefault()
    chrome.runtime.sendMessage({ type: 'PTR_REQUEST_AUTOLAYOUT' })
    return true
  }

  // --- ordering ---
  // Figma: bare [ and ] jump to the very back/front, Cmd+[ and Cmd+] move
  // one step. Pointer has no z-stacking of its own, so both act on the
  // element's position among its siblings.
  if ((e.key === '[' || e.key === ']') && !e.altKey && selectedEl) {
    e.preventDefault()
    const id = registerEl(selectedEl)
    const target = buildPayload(selectedEl)
    const back = e.key === '['
    const r = mod ? moveElement(id, back ? 'prev' : 'next') : moveToEdge(id, back ? 'back' : 'front')
    if (!r.ok) return false
    chrome.runtime.sendMessage({
      type: 'PTR_MOVED',
      payload: { elementId: id, target, from: r.from, to: r.to, parentDesc: r.parentDesc },
    })
    return true
  }

  if (e.key.startsWith('Arrow') && selectedEl && !e.altKey && !mod) {
    e.preventDefault()
    if (isOutOfFlow(selectedEl)) {
      const step = e.shiftKey ? 10 : 1
      const deltas: Record<string, [number, number]> = {
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
      }
      const d = deltas[e.key]
      if (!d) return false
      nudgeSelected(d[0], d[1])
      return true
    }
    const earlier = e.key === 'ArrowUp' || e.key === 'ArrowLeft'
    const later = e.key === 'ArrowDown' || e.key === 'ArrowRight'
    if (!earlier && !later) return false
    const id = registerEl(selectedEl)
    const target = buildPayload(selectedEl)
    const r = e.shiftKey
      ? moveToEdge(id, earlier ? 'back' : 'front')
      : moveElement(id, earlier ? 'prev' : 'next')
    if (!r.ok) return false
    chrome.runtime.sendMessage({
      type: 'PTR_MOVED',
      payload: { elementId: id, target, from: r.from, to: r.to, parentDesc: r.parentDesc },
    })
    return true
  }

  // --- copy/paste properties (Figma: Cmd+Opt+C / Cmd+Opt+V) ---
  if (e.key.toLowerCase() === 'c' && mod && e.altKey && selectedEl) {
    e.preventDefault()
    copyStyleFromSelected()
    return true
  }
  if (e.key.toLowerCase() === 'v' && mod && e.altKey && hoverEl) {
    e.preventDefault()
    pasteStyleToHovered()
    return true
  }

  if (e.key.toLowerCase() === 'h' && e.altKey && !mod) {
    e.preventDefault()
    toggleHighlightSiblings()
    return true
  }

  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEl) {
    e.preventDefault()
    const id = registerEl(selectedEl)
    const target = buildPayload(selectedEl)
    const r = deleteElement(id)
    if (!r.ok) return false
    chrome.runtime.sendMessage({
      type: 'PTR_DELETED',
      payload: { elementId: id, target, desc: r.desc, inserted: r.inserted },
    })
    return true
  }

  if (e.key.toLowerCase() === 'd' && mod && selectedEl) {
    e.preventDefault()
    const r = duplicateElement(registerEl(selectedEl))
    if (!r.ok) return false
    chrome.runtime.sendMessage({
      type: 'PTR_DUPLICATED',
      payload: { payload: r.payload, html: r.html, parentDesc: r.parentDesc },
    })
    return true
  }

  return false
}

function onKeyDown(e: KeyboardEvent) {
  if (!active) return
  const target = e.target as HTMLElement | null
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
    return
  // Option on its own isn't a shortcut, it's the measuring modifier: bring
  // the overlay up where the cursor already is instead of waiting for it to
  // move. No key hint for it — nothing was "done".
  if (e.key === 'Alt' || ((e.key === 'Meta' || e.key === 'Control') && e.altKey)) {
    updateMeasureOverlay(lastPointer.x, lastPointer.y, e.metaKey || e.ctrlKey)
    return
  }
  if (handleShortcut(e)) showKeyHint(e)
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key === 'Alt' || e.key === 'Meta' || e.key === 'Control') hideMeasure()
}

// The cursor left the page — into the side panel, another window, wherever.
// Whatever was hovered is no longer under the mouse, so the hover outline
// would just linger. The selection is a deliberate click; it stays.
function onMouseLeave() {
  hoverEl = null
  hideBox(hoverBox)
  hideBox(hoverLabel as any)
  hideMeasure()
}

/**
 * Figma's Option-hover measuring, which always runs *from* the current
 * selection:
 *
 *   - cursor anywhere inside the selection → its padding and item gaps
 *   - cursor on anything else             → the distance between the two
 *   - ⌘/Ctrl held                          → measure to the nested element
 *                                            under the cursor rather than to
 *                                            its top-level peer
 *
 * Returns whether it took over the hover, so plain hovering can carry on
 * when Option isn't held.
 */
function updateMeasureOverlay(x: number, y: number, deep: boolean): boolean {
  if (!active || commentMode) return false
  // Nothing selected means nothing to measure from — Figma stays quiet too,
  // rather than reporting on whatever the pointer is grazing.
  if (!selectedEl) {
    hideMeasure()
    return true
  }
  hidePadBand()
  hideBox(hoverLabel)
  const r = selectedEl.getBoundingClientRect()
  if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
    drawSpacingOverlay(selectedEl)
    return true
  }
  const el = document.elementFromPoint(x, y)
  if (!el || isPointerUi(el) || el === selectedEl) {
    hideMeasure()
    return true
  }
  drawDistanceOverlay(selectedEl, measureTarget(el, deep))
  return true
}

function onMouseMove(e: MouseEvent) {
  if (!active && !commentMode) return
  lastPointer = { x: e.clientX, y: e.clientY }
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (!el) return
  if (isPointerUi(el)) return
  if (editingEl) return

  if (e.altKey && updateMeasureOverlay(e.clientX, e.clientY, e.metaKey || e.ctrlKey)) {
    hoverEl = el
    return
  }
  hideMeasure()
  updatePaddingHover(e.clientX, e.clientY)
  if (el === hoverEl || el === hoverBox || el === hoverLabel) return
  hoverEl = el
  ensureOverlay()
  positionBox(hoverBox!, el)
  hoverLabel!.textContent = shortDescriptor(el)
  const r = el.getBoundingClientRect()
  Object.assign(hoverLabel!.style, {
    display: 'block',
    top: `${Math.max(4, r.top - 22)}px`,
    left: `${Math.max(4, r.left)}px`,
  })
}

// Right-click (the secondary mouse button) cycles through whatever is
// stacked at the same point, deepest-first after the topmost, so elements
// hidden behind another one can still be picked without moving the mouse.
let stackPoint: { x: number; y: number } | null = null
let stackIndex = 0

function elementAtWithCycle(x: number, y: number): Element | null {
  const stack = document
    .elementsFromPoint(x, y)
    .filter((el) => el !== hoverBox && el !== selectBox && el !== hoverLabel && !isPointerUi(el))
  if (!stack.length) return null
  const samePoint = stackPoint && stackPoint.x === x && stackPoint.y === y
  stackIndex = samePoint ? (stackIndex + 1) % stack.length : 0
  stackPoint = { x, y }
  return stack[stackIndex]
}

function onContextMenu(e: MouseEvent) {
  if (!active) return
  e.preventDefault()
  const el = elementAtWithCycle(e.clientX, e.clientY)
  if (el) selectElement(el)
}

// ---------- free drag ----------
// Dragging the already-selected element moves it with `transform`, the same
// mechanism as arrow-key nudging, so both share one offset per element and
// one revert path. A small threshold keeps ordinary clicks from registering
// as drags.
const DRAG_THRESHOLD = 3
let dragState: {
  id: number
  startX: number
  startY: number
  baseX: number
  baseY: number
  moved: boolean
} | null = null

// Dragging a normal flow child reorders it among its siblings — live, as
// you drag past them — instead of nudging an X/Y that layout would just
// override anyway. Only an out-of-flow element (position: absolute/fixed)
// gets the real XY drag above.
let reorderDragState: {
  id: number
  startX: number
  startY: number
  startParent: Element
  startIndex: number
  moved: boolean
} | null = null

/** Which sibling the cursor is nearest to, and whether the dragged element
 * should land before or after it — compared along whichever axis the
 * container actually lays its children out on. */
function findReorderTarget(
  el: Element,
  parent: Element,
  x: number,
  y: number
): { target: Element; position: 'before' | 'after' } | null {
  const siblings = Array.from(parent.children).filter((c) => c !== el && !isPointerUi(c))
  if (!siblings.length) return null
  const cs = getComputedStyle(parent)
  const horizontal = cs.display.includes('flex') && !cs.flexDirection.startsWith('column')
  let best: { target: Element; dist: number; before: boolean } | null = null
  for (const sib of siblings) {
    const r = sib.getBoundingClientRect()
    const mid = horizontal ? r.left + r.width / 2 : r.top + r.height / 2
    const pos = horizontal ? x : y
    const dist = Math.abs(pos - mid)
    if (!best || dist < best.dist) best = { target: sib, dist, before: pos < mid }
  }
  return best && { target: best.target, position: best.before ? 'before' : 'after' }
}

function onMouseDown(e: MouseEvent) {
  if (!active || commentMode || e.button !== 0 || e.altKey) return
  if (!selectedEl || editingEl) return
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (!el || isPointerUi(el)) return
  if (el !== selectedEl && !selectedEl.contains(el)) return
  const id = registerEl(selectedEl)
  if (isOutOfFlow(selectedEl)) {
    const base = getTransformParts(id)
    dragState = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      baseX: base.dx,
      baseY: base.dy,
      moved: false,
    }
    return
  }
  const parent = selectedEl.parentElement
  if (!parent) return
  reorderDragState = {
    id,
    startX: e.clientX,
    startY: e.clientY,
    startParent: parent,
    startIndex: siblingIndex(selectedEl),
    moved: false,
  }
}

function onDragMove(e: MouseEvent) {
  if (dragState) {
    const dx = e.clientX - dragState.startX
    const dy = e.clientY - dragState.startY
    if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    dragState.moved = true
    e.preventDefault()
    setTransform(dragState.id, { dx: dragState.baseX + dx, dy: dragState.baseY + dy })
    if (selectBox && selectedEl) positionBox(selectBox, selectedEl)
    return
  }
  if (reorderDragState) {
    const dx = e.clientX - reorderDragState.startX
    const dy = e.clientY - reorderDragState.startY
    if (!reorderDragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    reorderDragState.moved = true
    e.preventDefault()
    const el = getEl(reorderDragState.id)
    const parent = el?.parentElement
    if (!el || !parent) return
    const drop = findReorderTarget(el, parent, e.clientX, e.clientY)
    if (drop) reparentElement(reorderDragState.id, registerEl(drop.target), drop.position)
  }
}

function onMouseUp() {
  if (dragState) {
    const { id, moved, baseX, baseY } = dragState
    dragState = null
    if (!moved) return
    const cur = getTransformParts(id)
    const el = getEl(id)
    if (!el) return
    chrome.runtime.sendMessage({
      type: 'PTR_NUDGED',
      payload: {
        elementId: id,
        value: composeTransform(cur),
        from: composeTransform({ ...cur, dx: baseX, dy: baseY }),
        target: buildPayload(el),
      },
    })
    // Swallow the click that ends the drag so it doesn't re-select.
    document.addEventListener('click', (ev) => ev.stopPropagation(), {
      capture: true,
      once: true,
    })
    return
  }
  if (reorderDragState) {
    const { id, moved, startParent, startIndex } = reorderDragState
    reorderDragState = null
    if (!moved) return
    const el = getEl(id)
    if (!el) return
    const finalIndex = siblingIndex(el)
    if (el.parentElement === startParent && finalIndex === startIndex) return // ended up back where it started
    chrome.runtime.sendMessage({
      type: 'PTR_MOVED',
      payload: {
        elementId: id,
        target: buildPayload(el),
        from: startIndex,
        to: finalIndex,
        parentDesc: shortDescriptor(el.parentElement ?? startParent),
      },
    })
    document.addEventListener('click', (ev) => ev.stopPropagation(), {
      capture: true,
      once: true,
    })
  }
}

function onClick(e: MouseEvent) {
  if (!active && !commentMode) return
  const el = document.elementFromPoint(e.clientX, e.clientY)
  // Pins, resize handles and padding bands have their own handlers.
  if (isPointerUi(el)) return
  // Clicking inside text being edited just moves the caret; clicking
  // anywhere else finishes that edit first, then selects as usual.
  if (editingEl) {
    if (el && editingEl.contains(el)) return
    exitTextEdit(true)
  }
  e.preventDefault()
  e.stopPropagation()
  stackPoint = null
  if (!el) return
  if (commentMode) {
    // Picking a target for a new comment: tag the exact node right away so
    // later lookups never rely on reconstructing a selector against a
    // possibly-changed DOM (that's what caused pins to land on the wrong
    // element before). Report it to the panel, don't select for editing.
    const pendingId = crypto.randomUUID()
    el.setAttribute('data-pointer-cid', pendingId)
    chrome.runtime.sendMessage({
      type: 'PTR_COMMENT_TARGET',
      payload: {
        id: pendingId,
        frameToken: FRAME_TOKEN,
        selector: cssSelector(el),
        descriptor: shortDescriptor(el),
      },
    })
    setCommentMode(false)
    return
  }
  if (e.shiftKey) toggleMultiSelect(el)
  else selectElement(el)
}

function setCommentMode(on: boolean) {
  commentMode = on
  if (on) {
    ensureOverlay()
    document.addEventListener('mousemove', onMouseMove, true)
    document.addEventListener('click', onClick, true)
    setCursorOverride(true)
  } else if (!active) {
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('click', onClick, true)
    setCursorOverride(false)
    hideBox(hoverBox)
    hideBox(hoverLabel as any)
  }
}

function onScrollOrResize() {
  hidePadBand()
  if (selectedEl && selectBox) positionBox(selectBox, selectedEl)
  if (selectedEl) drawGridOverlay(selectedEl)
  clearHighlight()
  hideBox(hoverBox)
  hideBox(hoverLabel as any)
  hideMeasure()
  drawExtraBoxes()
}

// Forces the crosshair cursor everywhere while Inspect is on. Setting
// `document.documentElement.style.cursor` alone isn't enough: cursor is
// inherited, but any element with its own `cursor` (buttons, links —
// basically everything the page wants you to know is clickable) overrides
// that inherited value. A page-wide !important rule beats those; pins keep
// their own pointer cursor via a more specific selector on top of it.
let cursorOverrideStyle: HTMLStyleElement | null = null

function setCursorOverride(on: boolean) {
  if (on) {
    if (cursorOverrideStyle) return
    cursorOverrideStyle = document.createElement('style')
    cursorOverrideStyle.textContent =
      '*, *::before, *::after { cursor: crosshair !important; }' +
      ' [data-pointer-pin] { cursor: pointer !important; }' +
      ' [data-ptr-cursor="ew"] { cursor: ew-resize !important; }' +
      ' [data-ptr-cursor="ns"] { cursor: ns-resize !important; }' +
      ' [data-ptr-cursor="nwse"] { cursor: nwse-resize !important; }' +
      ' [data-ptr-cursor="nesw"] { cursor: nesw-resize !important; }' +
      ' [data-ptr-cursor="text"], [data-ptr-cursor="text"] * { cursor: text !important; }'
    document.documentElement.appendChild(cursorOverrideStyle)
  } else {
    cursorOverrideStyle?.remove()
    cursorOverrideStyle = null
  }
}

// ---------- direct manipulation on the page (Figma-style) ----------
// Resize handles on the selection, draggable padding bands, and in-place
// text editing on double-click. Everything goes through the same pristine
// snapshots as panel edits (applyStyle / setTransform / text pristine), so
// Changes-tab revert and Clear all already cover it, and the panel is
// notified so its fields, history and the prompt stay in sync.

const pf = (v: string) => parseFloat(v) || 0

/** Our own overlay nodes (handles, bands, pins): never selectable, never
 * hover targets, never drag starts. */
function isPointerUi(el: Element | null): boolean {
  return (
    !!el &&
    el instanceof HTMLElement &&
    (el.dataset.pointerUi !== undefined || el.dataset.pointerPin !== undefined)
  )
}

function makeUiNode(cursor: string, extra: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const n = document.createElement('div')
  n.dataset.pointerUi = '1'
  if (cursor) n.dataset.ptrCursor = cursor
  Object.assign(n.style, {
    position: 'fixed',
    zIndex: '2147483646',
    display: 'none',
    boxSizing: 'border-box',
    ...extra,
  })
  document.documentElement.appendChild(n)
  return n
}

// --- resize handles ---
type HandleSide = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLE_DEFS: { side: HandleSide; cursor: string; w: number; h: number }[] = [
  { side: 'nw', cursor: 'nwse', w: 8, h: 8 },
  { side: 'ne', cursor: 'nesw', w: 8, h: 8 },
  { side: 'sw', cursor: 'nesw', w: 8, h: 8 },
  { side: 'se', cursor: 'nwse', w: 8, h: 8 },
  { side: 'n', cursor: 'ns', w: 16, h: 5 },
  { side: 's', cursor: 'ns', w: 16, h: 5 },
  { side: 'w', cursor: 'ew', w: 5, h: 16 },
  { side: 'e', cursor: 'ew', w: 5, h: 16 },
]
const handles: { side: HandleSide; w: number; h: number; el: HTMLDivElement }[] = []
let sizeLabel: HTMLDivElement | null = null

function ensureHandles() {
  if (handles.length) return
  for (const d of HANDLE_DEFS) {
    const el = makeUiNode(d.cursor, {
      width: `${d.w}px`,
      height: `${d.h}px`,
      background: '#fff',
      border: '1.5px solid #3b82f6',
      borderRadius: '2px',
      pointerEvents: 'auto',
      zIndex: '2147483647',
    })
    el.addEventListener('mousedown', (e) => startResize(e, d.side))
    handles.push({ side: d.side, w: d.w, h: d.h, el })
  }
  sizeLabel = makeUiNode('', {
    background: '#3b82f6',
    color: '#fff',
    font: 'bold 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '1px 6px',
    borderRadius: '4px',
    pointerEvents: 'none',
    zIndex: '2147483647',
    whiteSpace: 'nowrap',
  })
}

function positionHandles(el: Element) {
  ensureHandles()
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  for (const h of handles) {
    let x = cx
    let y = cy
    if (h.side.includes('w')) x = r.left
    if (h.side.includes('e')) x = r.right
    if (h.side.includes('n')) y = r.top
    if (h.side.includes('s')) y = r.bottom
    Object.assign(h.el.style, {
      display: 'block',
      left: `${x - h.w / 2}px`,
      top: `${y - h.h / 2}px`,
    })
  }
}

function hideHandles() {
  for (const h of handles) h.el.style.display = 'none'
  if (sizeLabel) sizeLabel.style.display = 'none'
}

function showSizeLabel(el: Element) {
  if (!sizeLabel) return
  const r = el.getBoundingClientRect()
  sizeLabel.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`
  Object.assign(sizeLabel.style, {
    display: 'block',
    left: `${r.left + r.width / 2 - 28}px`,
    top: `${r.bottom + 8}px`,
  })
}

let resizeState: {
  id: number
  side: HandleSide
  startX: number
  startY: number
  startW: number
  startH: number
  startDx: number
  startDy: number
  // padding+border to subtract when the element sizes its content box
  chromeW: number
  chromeH: number
  from: Record<string, string>
} | null = null

function startResize(e: MouseEvent, side: HandleSide) {
  if (!selectedEl || e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  exitTextEdit(true)
  hidePadBand()
  const el = selectedEl
  const id = registerEl(el)
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const contentBox = cs.boxSizing !== 'border-box'
  const t = getTransformParts(id)
  resizeState = {
    id,
    side,
    startX: e.clientX,
    startY: e.clientY,
    startW: r.width,
    startH: r.height,
    startDx: t.dx,
    startDy: t.dy,
    chromeW: contentBox
      ? pf(cs.paddingLeft) + pf(cs.paddingRight) + pf(cs.borderLeftWidth) + pf(cs.borderRightWidth)
      : 0,
    chromeH: contentBox
      ? pf(cs.paddingTop) + pf(cs.paddingBottom) + pf(cs.borderTopWidth) + pf(cs.borderBottomWidth)
      : 0,
    from: { width: cs.width, height: cs.height, transform: composeTransform(t), flexGrow: cs.flexGrow },
  }
  // A Fill-sized flex child ignores an explicit width; pin it so the drag
  // actually sticks (this is what the panel's "Fixed" does too).
  if (pf(cs.flexGrow) > 0 && (side.includes('e') || side.includes('w'))) applyStyle(id, 'flex-grow', '0')
  window.addEventListener('mousemove', onResizeMove, true)
  window.addEventListener('mouseup', onResizeUp, true)
}

function onResizeMove(e: MouseEvent) {
  const s = resizeState
  if (!s) return
  e.preventDefault()
  const dx = e.clientX - s.startX
  const dy = e.clientY - s.startY
  let w = s.startW
  let h = s.startH
  let tx = s.startDx
  let ty = s.startDy
  if (s.side.includes('e')) w = s.startW + dx
  // Dragging the left/top edge keeps the opposite edge where it is, like
  // Figma: shrink/grow, then shift by the same amount.
  if (s.side.includes('w')) {
    w = s.startW - dx
    tx = s.startDx + dx
  }
  if (s.side.includes('s')) h = s.startH + dy
  if (s.side.includes('n')) {
    h = s.startH - dy
    ty = s.startDy + dy
  }
  w = Math.max(1, Math.round(w))
  h = Math.max(1, Math.round(h))
  if (s.side.includes('e') || s.side.includes('w')) applyStyle(s.id, 'width', `${Math.max(0, w - s.chromeW)}px`)
  if (s.side.includes('n') || s.side.includes('s')) applyStyle(s.id, 'height', `${Math.max(0, h - s.chromeH)}px`)
  if (tx !== s.startDx || ty !== s.startDy) setTransform(s.id, { dx: tx, dy: ty })
  const el = getEl(s.id)
  if (el) showSizeLabel(el)
}

function onResizeUp() {
  const s = resizeState
  resizeState = null
  window.removeEventListener('mousemove', onResizeMove, true)
  window.removeEventListener('mouseup', onResizeUp, true)
  if (sizeLabel) sizeLabel.style.display = 'none'
  if (!s) return
  const el = getEl(s.id)
  if (!el) return
  const cs = getComputedStyle(el)
  const now: Record<string, string> = {
    width: cs.width,
    height: cs.height,
    transform: composeTransform(getTransformParts(s.id)),
    flexGrow: cs.flexGrow,
  }
  const changes = Object.keys(now)
    .filter((k) => now[k] !== s.from[k])
    .map((k) => ({ prop: k, from: s.from[k], to: now[k] }))
  if (changes.length) {
    chrome.runtime.sendMessage({
      type: 'PTR_STYLES_CHANGED',
      payload: { target: buildPayload(el), changes },
    })
  }
}

// --- padding bands ---
type PadSide = 'top' | 'right' | 'bottom' | 'left'
const OPPOSITE: Record<PadSide, PadSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
let padBand: HTMLDivElement | null = null
let padBadge: HTMLDivElement | null = null
let padHoverSide: PadSide | null = null
let padDrag: {
  id: number
  side: PadSide
  startPos: number
  startVal: number
  startOpp: number
  alt: boolean
  from: Record<string, string>
} | null = null

function ensurePadUi() {
  if (padBand) return
  padBand = makeUiNode('ns', {
    background:
      'repeating-linear-gradient(45deg, rgba(59,130,246,0.38) 0 2px, rgba(59,130,246,0.10) 2px 7px)',
    pointerEvents: 'auto',
  })
  padBand.addEventListener('mousedown', startPadDrag)
  padBand.addEventListener('mouseleave', () => {
    if (!padDrag) hidePadBand()
  })
  padBadge = makeUiNode('', {
    background: '#3b82f6',
    color: '#fff',
    font: 'bold 10px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '1px 5px',
    borderRadius: '3px',
    pointerEvents: 'none',
    zIndex: '2147483647',
  })
}

function hidePadBand() {
  padHoverSide = null
  if (padBand) padBand.style.display = 'none'
  if (padBadge) padBadge.style.display = 'none'
}

/** Geometry of one padding band of the selected element, in viewport px. */
function padBandRect(el: Element, side: PadSide) {
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const t = pf(cs.paddingTop)
  const rt = pf(cs.paddingRight)
  const b = pf(cs.paddingBottom)
  const l = pf(cs.paddingLeft)
  const val = { top: t, right: rt, bottom: b, left: l }[side]
  const rect =
    side === 'top'
      ? { left: r.left, top: r.top, width: r.width, height: t }
      : side === 'bottom'
        ? { left: r.left, top: r.bottom - b, width: r.width, height: b }
        : side === 'left'
          ? { left: r.left, top: r.top + t, width: l, height: Math.max(0, r.height - t - b) }
          : { left: r.right - rt, top: r.top + t, width: rt, height: Math.max(0, r.height - t - b) }
  return { rect, val }
}

function showPadBand(el: Element, side: PadSide) {
  ensurePadUi()
  const { rect, val } = padBandRect(el, side)
  padHoverSide = side
  padBand!.dataset.ptrCursor = side === 'top' || side === 'bottom' ? 'ns' : 'ew'
  Object.assign(padBand!.style, {
    display: 'block',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
  padBadge!.textContent = `${Math.round(val)}`
  Object.assign(padBadge!.style, {
    display: 'block',
    left: `${rect.left + rect.width / 2 - 10}px`,
    top: `${rect.top + rect.height / 2 - 9}px`,
  })
}

// Hovering inside the selected element's padding lights that band up
// (hatched, with its value) and turns the cursor into a resize arrow; the
// band itself then takes the mousedown to start the drag.
function updatePaddingHover(x: number, y: number) {
  if (!selectedEl || padDrag || resizeState || editingEl) return
  const el = selectedEl
  const r = el.getBoundingClientRect()
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) {
    hidePadBand()
    return
  }
  const cs = getComputedStyle(el)
  // Padding is an auto-layout property in Figma, and its drag handles only
  // exist on auto-layout frames. Offering them on every element that happens
  // to have padding is what made this feel like poking around an inspector
  // rather than working on a canvas. The numeric fields in the Element panel
  // still edit padding anywhere, exactly as Figma's own inspector does.
  if (!cs.display.includes('flex') && !cs.display.includes('grid')) {
    hidePadBand()
    return
  }
  const t = pf(cs.paddingTop)
  const rt = pf(cs.paddingRight)
  const b = pf(cs.paddingBottom)
  const l = pf(cs.paddingLeft)
  let side: PadSide | null = null
  if (t > 0 && y - r.top <= t) side = 'top'
  else if (b > 0 && r.bottom - y <= b) side = 'bottom'
  else if (l > 0 && x - r.left <= l) side = 'left'
  else if (rt > 0 && r.right - x <= rt) side = 'right'
  if (!side) {
    hidePadBand()
    return
  }
  if (side !== padHoverSide) showPadBand(el, side)
}

function startPadDrag(e: MouseEvent) {
  if (!selectedEl || !padHoverSide || e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  const el = selectedEl
  const id = registerEl(el)
  const cs = getComputedStyle(el)
  const side = padHoverSide
  const prop = (s: PadSide) => `padding${s[0].toUpperCase()}${s.slice(1)}` as keyof CSSStyleDeclaration
  padDrag = {
    id,
    side,
    startPos: side === 'top' || side === 'bottom' ? e.clientY : e.clientX,
    startVal: pf(cs[prop(side)] as string),
    startOpp: pf(cs[prop(OPPOSITE[side])] as string),
    alt: e.altKey,
    from: {
      paddingTop: cs.paddingTop,
      paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
    },
  }
  window.addEventListener('mousemove', onPadMove, true)
  window.addEventListener('mouseup', onPadUp, true)
}

function onPadMove(e: MouseEvent) {
  const d = padDrag
  if (!d) return
  e.preventDefault()
  const pos = d.side === 'top' || d.side === 'bottom' ? e.clientY : e.clientX
  const delta = pos - d.startPos
  // Dragging a band inward (away from its edge) grows that padding.
  const grows = d.side === 'top' || d.side === 'left' ? delta : -delta
  const v = Math.max(0, Math.round(d.startVal + grows))
  applyStyle(d.id, `padding-${d.side}`, `${v}px`)
  // Alt: the opposite side follows, Figma-style.
  if (d.alt || e.altKey) applyStyle(d.id, `padding-${OPPOSITE[d.side]}`, `${v}px`)
  const el = getEl(d.id)
  if (el) showPadBand(el, d.side)
}

function onPadUp() {
  const d = padDrag
  padDrag = null
  window.removeEventListener('mousemove', onPadMove, true)
  window.removeEventListener('mouseup', onPadUp, true)
  hidePadBand()
  if (!d) return
  const el = getEl(d.id)
  if (!el) return
  const cs = getComputedStyle(el)
  const now: Record<string, string> = {
    paddingTop: cs.paddingTop,
    paddingRight: cs.paddingRight,
    paddingBottom: cs.paddingBottom,
    paddingLeft: cs.paddingLeft,
  }
  const changes = Object.keys(now)
    .filter((k) => now[k] !== d.from[k])
    .map((k) => ({ prop: k, from: d.from[k], to: now[k] }))
  if (changes.length) {
    chrome.runtime.sendMessage({
      type: 'PTR_STYLES_CHANGED',
      payload: { target: buildPayload(el), changes },
    })
  }
}

// --- in-place text editing ---
let editingEl: HTMLElement | null = null
let editingFrom = ''

function onDblClick(e: MouseEvent) {
  if (!active) return
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (!(el instanceof HTMLElement) || isPointerUi(el)) return
  // Only a text leaf: editing a container's joined text would wipe its
  // children (see buildPayload).
  if (el.children.length > 0 || !(el.textContent || '').trim()) return
  e.preventDefault()
  e.stopPropagation()
  if (editingEl && editingEl !== el) exitTextEdit(true)
  if (el !== selectedEl) selectElement(el)
  startTextEdit(el, e.clientX, e.clientY)
}

function startTextEdit(el: HTMLElement, x: number, y: number) {
  const id = registerEl(el)
  const p = ensurePristine(id)
  if (p.text === null) p.text = el.innerText // so Changes-tab revert works
  editingEl = el
  editingFrom = el.innerText
  el.setAttribute('contenteditable', 'true')
  el.dataset.ptrCursor = 'text'
  el.focus()
  // Caret where you double-clicked, not at the start.
  const range = document.caretRangeFromPoint?.(x, y)
  if (range) {
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
  el.addEventListener('keydown', onEditKeyDown)
  el.addEventListener('blur', onEditBlur)
  hidePadBand()
}

function onEditKeyDown(e: KeyboardEvent) {
  // Keep Pointer's own shortcuts (arrows, Delete, Cmd+D…) out of the text.
  e.stopPropagation()
  if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault()
    exitTextEdit(true)
  } else if (e.key === 'Enter') {
    // A line break would insert a child element and stop this being a text
    // leaf; keep in-place edits single-line (use the panel for more).
    e.preventDefault()
  }
}

function onEditBlur() {
  exitTextEdit(true)
}

function exitTextEdit(commit: boolean) {
  const el = editingEl
  if (!el) return
  editingEl = null
  el.removeEventListener('keydown', onEditKeyDown)
  el.removeEventListener('blur', onEditBlur)
  el.removeAttribute('contenteditable')
  delete el.dataset.ptrCursor
  window.getSelection()?.removeAllRanges()
  const to = el.innerText
  if (commit && to !== editingFrom) {
    chrome.runtime.sendMessage({
      type: 'PTR_TEXT_EDITED',
      payload: { target: buildPayload(el), from: editingFrom, to },
    })
  }
  if (selectedEl === el && selectBox) positionBox(selectBox, el)
}


function setActive(on: boolean) {
  // Host chrome never inspects; the app's iframe does.
  if (on && IS_HOST_CHROME) return
  active = on
  setCursorOverride(on)
  if (on) {
    ensureOverlay()
    document.documentElement.addEventListener('mouseleave', onMouseLeave)
    document.addEventListener('mousemove', onMouseMove, true)
    document.addEventListener('mousemove', onDragMove, true)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('dblclick', onDblClick, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
  } else {
    document.documentElement.removeEventListener('mouseleave', onMouseLeave)
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('mousemove', onDragMove, true)
    document.removeEventListener('mousedown', onMouseDown, true)
    document.removeEventListener('mouseup', onMouseUp, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('contextmenu', onContextMenu, true)
    document.removeEventListener('dblclick', onDblClick, true)
    document.removeEventListener('keydown', onKeyDown, true)
    exitTextEdit(true)
    hideKeyHint()
    hideHandles()
    hidePadBand()
    resizeState = null
    padDrag = null
    document.removeEventListener('keyup', onKeyUp, true)
    dragState = null
    reorderDragState = null
    window.removeEventListener('scroll', onScrollOrResize, true)
    window.removeEventListener('resize', onScrollOrResize)
    hideBox(hoverBox)
    hideBox(hoverLabel as any)
    hideMeasure()
    clearGridOverlay()
    clearHighlight()
  }
}

// ---------- export selection to Figma (as a design tree for the Pointer plugin) ----------
// An SVG paste puts everything into one flat bag of absolutely-positioned
// shapes — Figma's SVG importer has no concept of "this frame has padding
// 24 and gap 16", so every container without its own paint (the vast
// majority of real layout divs) silently vanished, and what was left had
// no auto layout at all. This exports a real nested tree instead — one
// JSON object per DOM element, preserving the full parent/child structure
// and each flex container's layout — which the companion Figma plugin
// (figma-plugin/ in this repo) rebuilds as native frames with auto layout,
// not shapes glued together by coordinates.

export type DesignColor = { r: number; g: number; b: number; a: number }

export type DesignSizing = 'FIXED' | 'FILL' | 'HUG'

export type DesignLayout = {
  direction: 'HORIZONTAL' | 'VERTICAL'
  gap: number
  padding: [number, number, number, number] // top right bottom left
  primary: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'
  counter: 'MIN' | 'CENTER' | 'MAX'
  wrap: boolean
}

export type DesignText = {
  characters: string
  fontFamily: string
  fontWeight: number
  italic: boolean
  fontSize: number
  lineHeight: number | null // null = the font's natural line height
  letterSpacing: number
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'
  case: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE'
  color: DesignColor
}

export type DesignNode = {
  type: 'FRAME' | 'TEXT' | 'IMAGE' | 'VECTOR'
  name: string
  x: number
  y: number
  width: number
  height: number
  opacity?: number
  cornerRadius?: [number, number, number, number] // TL TR BR BL
  fill?: DesignColor
  stroke?: DesignColor
  strokeWeight?: number
  clip?: boolean
  layout?: DesignLayout
  // How this node should behave inside ITS parent's auto layout, if any.
  sizing?: { h: DesignSizing; v: DesignSizing }
  text?: DesignText
  image?: { dataUrl: string | null }
  vector?: { svg: string }
  children?: DesignNode[]
}

let colorCanvasCtx: CanvasRenderingContext2D | null = null

function figmaColor(value: string): DesignColor | null {
  const v = value.trim()
  if (!v || v === 'transparent') return null

  // The common case getComputedStyle actually returns for background-color
  // etc. Cheap to check first, and avoids the canvas round-trip.
  const m = v.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\)/)
  if (m) {
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1
    if (a <= 0) return null
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a }
  }

  // Modern wide-gamut syntaxes (oklch(), lab(), color(), color-mix() with
  // those) come back from getComputedStyle as-is in Chrome instead of being
  // converted to rgb() — the regex above won't match, and without this the
  // color would silently be treated as "no paint" (this is why a chip using
  // a Tailwind oklch swatch lost its fill on export). A 2D canvas always
  // renders any valid CSS color into sRGB, regardless of the function used
  // to specify it, so painting one pixel and reading it back resolves any
  // of these reliably.
  try {
    if (!colorCanvasCtx) {
      colorCanvasCtx = document.createElement('canvas').getContext('2d', {
        willReadFrequently: true,
      })
    }
    if (!colorCanvasCtx) return null
    colorCanvasCtx.clearRect(0, 0, 1, 1)
    colorCanvasCtx.fillStyle = '#000'
    colorCanvasCtx.fillStyle = v
    if (colorCanvasCtx.fillStyle === '#000000' && v !== '#000' && !/^#0{3,6}$/i.test(v)) {
      // fillStyle didn't change, meaning the browser rejected `v` outright.
      return null
    }
    colorCanvasCtx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = colorCanvasCtx.getImageData(0, 0, 1, 1).data
    if (a === 0) return null
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 }
  } catch {
    return null
  }
}

function cornerRadii(style: CSSStyleDeclaration): [number, number, number, number] {
  return [
    parseFloat(style.borderTopLeftRadius) || 0,
    parseFloat(style.borderTopRightRadius) || 0,
    parseFloat(style.borderBottomRightRadius) || 0,
    parseFloat(style.borderBottomLeftRadius) || 0,
  ]
}

function mapJustify(v: string): DesignLayout['primary'] {
  switch (v) {
    case 'center':
      return 'CENTER'
    case 'flex-end':
    case 'end':
      return 'MAX'
    case 'space-between':
      return 'SPACE_BETWEEN'
    default:
      return 'MIN'
  }
}

function mapAlign(v: string): DesignLayout['counter'] {
  switch (v) {
    case 'center':
      return 'CENTER'
    case 'flex-end':
    case 'end':
      return 'MAX'
    default:
      return 'MIN'
  }
}

function mapTextAlign(v: string): DesignText['align'] {
  switch (v) {
    case 'center':
      return 'CENTER'
    case 'right':
    case 'end':
      return 'RIGHT'
    case 'justify':
      return 'JUSTIFIED'
    default:
      return 'LEFT'
  }
}

function mapTextCase(v: string): DesignText['case'] {
  switch (v) {
    case 'uppercase':
      return 'UPPER'
    case 'lowercase':
      return 'LOWER'
    case 'capitalize':
      return 'TITLE'
    default:
      return 'ORIGINAL'
  }
}

/** FILL if this element grows on the main axis or is sized ~100% of its parent, else FIXED. */
/**
 * How a child should size itself inside its parent's auto layout.
 *
 * This used to be `flexGrow > 0 ? FILL : FIXED`, applied to *both* axes from
 * the same test — so anything that wasn't explicitly growing got pinned to
 * the pixel size it happened to have on the page. Pinned text is what breaks
 * first: Figma re-measures it with its own font, the measurement differs by
 * a hair, and the text wraps or clips. Hugging and filling are what keep a
 * layout alive, so they're used wherever the page is really doing them —
 * which is exactly the question sizeModeFor already answers.
 */
function sizingFor(el: HTMLElement, axis: 'width' | 'height', canHug: boolean): DesignSizing {
  const mode = sizeModeFor(el, axis)
  if (mode === 'fill') return 'FILL'
  // Only text and auto-layout frames can hug in Figma; a plain frame has no
  // content to hug, so it keeps the size it was measured at.
  if (mode === 'hug' && canHug) return 'HUG'
  return 'FIXED'
}

/** Children stack consistently along this axis — the spacing between them and
 * the space left around them, measured rather than read off the CSS. Margins,
 * `space-y-*` utilities and collapsed margins all land in the real geometry
 * but not in `gap`, so measuring is what actually reproduces the layout. */
function measureStack(
  children: DesignNode[],
  dir: 'VERTICAL' | 'HORIZONTAL',
  size: { width: number; height: number },
  // Room left past the last child along the stacking direction is only
  // padding if something actually claims it — a container sized by its
  // content, or a child stretching to fill. Otherwise it's just slack, and
  // recording it would show up in Figma as an absurd 200px pad after a row
  // of two small chips. Across the stack there's no such ambiguity: a
  // filling child's measured size already has the real padding subtracted
  // from it, so dropping it there would make every such child too wide.
  keepTrailing: boolean
): { gap: number; padding: [number, number, number, number] } | null {
  const pos = dir === 'VERTICAL' ? 'y' : 'x'
  const len = dir === 'VERTICAL' ? 'height' : 'width'
  const crossPos = dir === 'VERTICAL' ? 'x' : 'y'
  const crossLen = dir === 'VERTICAL' ? 'width' : 'height'
  const sorted = children.slice().sort((a, b) => a[pos] - b[pos])

  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i][pos] - (sorted[i - 1][pos] + sorted[i - 1][len])
    if (gap < -0.5) return null // they overlap: not a stack
    gaps.push(Math.max(0, gap))
  }
  // A single inconsistent gap means the spacing is doing something auto
  // layout can't express, so the frame keeps its absolute positioning.
  if (gaps.length && Math.max(...gaps) - Math.min(...gaps) > 1) return null

  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const before = first[pos]
  const after = keepTrailing ? size[len] - (last[pos] + last[len]) : 0
  const crossBefore = Math.min(...sorted.map((c) => c[crossPos]))
  const crossAfter = size[crossLen] - Math.max(...sorted.map((c) => c[crossPos] + c[crossLen]))
  const round = (n: number) => Math.max(0, Math.round(n))
  return {
    gap: gaps.length ? Math.round(gaps[0]) : 0,
    padding:
      dir === 'VERTICAL'
        ? [round(before), round(crossAfter), round(after), round(crossBefore)]
        : [round(crossBefore), round(after), round(crossAfter), round(before)],
  }
}

/** Fetch every <img> in the subtree and convert it to a data URI — the plugin
 * runs inside Figma's sandbox and can't fetch arbitrary URLs itself. */
async function inlineImages(root: Element): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const imgs: HTMLImageElement[] = []
  if (root instanceof HTMLImageElement) imgs.push(root)
  imgs.push(...Array.from(root.querySelectorAll('img')))
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.src
      if (!src || src.startsWith('data:') || map.has(src)) return
      try {
        const blob = await (await fetch(src)).blob()
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(fr.result as string)
          fr.onerror = reject
          fr.readAsDataURL(blob)
        })
        map.set(src, dataUrl)
      } catch {
        // Cross-origin without CORS headers — the plugin falls back to a
        // gray placeholder rect for this one image.
      }
    })
  )
  return map
}

/** One DesignNode per contiguous run of an element's own (non-descendant)
 * text, sized to the run's full wrapped bounding box (via Range) so the
 * plugin can hand Figma's own text engine that box and let IT rewrap —
 * far more reliable than us pre-computing line breaks by hand. */
function textNodeFor(node: Text, style: CSSStyleDeclaration, parentRect: DOMRect): DesignNode | null {
  const range = document.createRange()
  range.selectNodeContents(node)
  const r = range.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  const characters = (node.textContent || '').trim()
  if (!characters) return null
  const color = figmaColor(style.color) ?? { r: 0, g: 0, b: 0, a: 1 }
  const lh = style.lineHeight === 'normal' ? null : parseFloat(style.lineHeight)
  // One client rect per line box, so this is the page telling us whether the
  // text wrapped. It decides everything about how the text should size in
  // Figma: a single line that's pinned to its measured width clips or wraps
  // the moment Figma re-measures it in a slightly different font, so it must
  // hug instead; a paragraph that really did wrap needs to keep filling its
  // container's width and let Figma recompute the height.
  const lines = range.getClientRects().length
  return {
    type: 'TEXT',
    name: characters.slice(0, 24),
    x: r.left - parentRect.left,
    y: r.top - parentRect.top,
    width: r.width,
    height: r.height,
    sizing: lines > 1 ? { h: 'FILL', v: 'HUG' } : { h: 'HUG', v: 'HUG' },
    text: {
      characters,
      fontFamily: style.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      fontWeight: fontWeightNumber(style.fontWeight),
      italic: style.fontStyle === 'italic',
      fontSize: parseFloat(style.fontSize) || 16,
      lineHeight: Number.isNaN(lh as number) ? null : lh,
      letterSpacing: parseFloat(style.letterSpacing) || 0,
      align: mapTextAlign(style.textAlign),
      case: mapTextCase(style.textTransform),
      color,
    },
  }
}

function fontWeightNumber(computed: string): number {
  const n = parseInt(computed, 10)
  return Number.isNaN(n) ? 400 : n
}

const TREE_EXPORT_MAX_NODES = 1500

function walkDesignTree(
  el: Element,
  parentRect: DOMRect | null,
  imgData: Map<string, string>,
  budget: { count: number }
): DesignNode | null {
  if (budget.count >= TREE_EXPORT_MAX_NODES) return null
  if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return null
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return null

  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  budget.count++
  const x = parentRect ? rect.left - parentRect.left : 0
  const y = parentRect ? rect.top - parentRect.top : 0
  const { name } = layerName(el)

  if (el instanceof SVGElement) {
    return { type: 'VECTOR', name, x, y, width: rect.width, height: rect.height, vector: { svg: el.outerHTML } }
  }

  if (el instanceof HTMLImageElement && el.src) {
    return {
      type: 'IMAGE',
      name,
      x,
      y,
      width: rect.width,
      height: rect.height,
      image: { dataUrl: imgData.get(el.src) ?? null },
    }
  }

  const node: DesignNode = { type: 'FRAME', name, x, y, width: rect.width, height: rect.height }

  const bg = figmaColor(style.backgroundColor)
  if (bg) node.fill = bg

  const borderWidth = parseFloat(style.borderTopWidth) || 0
  if (borderWidth > 0 && style.borderTopStyle !== 'none') {
    const bc = figmaColor(style.borderTopColor)
    if (bc) {
      node.stroke = bc
      node.strokeWeight = borderWidth
    }
  }

  const radii = cornerRadii(style)
  if (radii.some((r) => r > 0)) node.cornerRadius = radii

  const opacity = parseFloat(style.opacity)
  if (!Number.isNaN(opacity) && opacity < 1) node.opacity = opacity

  if (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden') {
    node.clip = true
  }

  const children: DesignNode[] = []
  // Children that auto layout can't describe at all, so their presence has
  // to keep the frame on absolute positioning.
  let hasOutOfFlowChild = false
  for (const child of Array.from(el.childNodes)) {
    if (budget.count >= TREE_EXPORT_MAX_NODES) break
    if (child.nodeType === Node.TEXT_NODE && (child.textContent || '').trim()) {
      const t = textNodeFor(child as Text, style, rect)
      if (t) {
        budget.count++
        children.push(t)
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const sub = walkDesignTree(child as Element, rect, imgData, budget)
      if (sub) {
        const childEl = child as HTMLElement
        const childStyle = getComputedStyle(childEl)
        if (childStyle.position === 'absolute' || childStyle.position === 'fixed') {
          hasOutOfFlowChild = true
        }
        // Only text and auto-layout frames have something to hug.
        const canHug = !!sub.layout || sub.type === 'TEXT'
        sub.sizing =
          childEl instanceof HTMLElement
            ? { h: sizingFor(childEl, 'width', canHug), v: sizingFor(childEl, 'height', canHug) }
            : { h: 'FIXED', v: 'FIXED' }
        children.push(sub)
      }
    }
  }

  const size = { width: rect.width, height: rect.height }
  const hugsWidth = el instanceof HTMLElement && sizeModeFor(el, 'width') === 'hug'
  const hugsHeight = el instanceof HTMLElement && sizeModeFor(el, 'height') === 'hug'
  const keepTrailingFor = (dir: 'VERTICAL' | 'HORIZONTAL') => {
    const axis = dir === 'VERTICAL' ? 'v' : 'h'
    return (
      (dir === 'VERTICAL' ? hugsHeight : hugsWidth) ||
      children.some((c) => c.sizing?.[axis] === 'FILL')
    )
  }

  const isFlex = style.display.includes('flex')
  if (isFlex) {
    const direction = style.flexDirection.startsWith('column') ? 'VERTICAL' : 'HORIZONTAL'
    // Prefer what the children actually measure: `gap` is frequently unset
    // while the real spacing comes from margins or a `space-y-*` utility,
    // and CSS padding misses margins on the first/last child.
    const measured =
      !hasOutOfFlowChild && children.length && style.flexWrap !== 'wrap'
        ? measureStack(children, direction, size, keepTrailingFor(direction))
        : null
    node.layout = {
      direction,
      gap: measured?.gap ?? (parseFloat(style.columnGap) || parseFloat(style.rowGap) || 0),
      padding: measured?.padding ?? [
        parseFloat(style.paddingTop) || 0,
        parseFloat(style.paddingRight) || 0,
        parseFloat(style.paddingBottom) || 0,
        parseFloat(style.paddingLeft) || 0,
      ],
      primary: mapJustify(style.justifyContent),
      counter: mapAlign(style.alignItems),
      wrap: style.flexWrap === 'wrap',
    }
  } else if (children.length && !hasOutOfFlowChild) {
    // A plain block container whose children simply stack *is* an auto layout
    // in Figma's vocabulary. Exporting it as a bare frame instead pinned
    // every child to the pixel size and position it happened to have, which
    // is what made text and nested boxes break the moment anything reflowed.
    // Layouts that genuinely need absolute positioning fail the stacking
    // test below and keep their coordinates.
    const vertical = measureStack(children, 'VERTICAL', size, keepTrailingFor('VERTICAL'))
    const horizontal =
      children.length > 1 ? measureStack(children, 'HORIZONTAL', size, keepTrailingFor('HORIZONTAL')) : null
    // With one child either reading works; vertical matches how block
    // layout actually flows, so it wins ties.
    const pick = vertical ? { dir: 'VERTICAL' as const, m: vertical } : horizontal ? { dir: 'HORIZONTAL' as const, m: horizontal } : null
    if (pick) {
      node.layout = {
        direction: pick.dir,
        gap: pick.m.gap,
        padding: pick.m.padding,
        primary: 'MIN',
        counter: 'MIN',
        wrap: false,
      }
    }
  }

  if (children.length) node.children = children
  return node
}

async function buildFigmaTree(root: Element): Promise<{ pointerExport: 1; root: DesignNode | null }> {
  const imgData = await inlineImages(root)
  const tree = walkDesignTree(root, null, imgData, { count: 0 })
  return { pointerExport: 1, root: tree }
}


// ---------- messages from the side panel ----------

// Messages that must run in every frame (activation, global resets). All
// other messages are frame-scoped: only the frame whose token matches
// responds — or the top frame when no token is given (e.g. before any
// selection was made). Without this, every frame would answer and Chrome
// would surface whichever response came first.
const BROADCAST_TYPES = new Set([
  'PTR_PING',
  'PTR_SET_ACTIVE',
  'PTR_COMMENT_MODE',
  'PTR_RESET_ALL',
  'PTR_SHOW_COMMENTS',
])

chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: any) => {
  if (BROADCAST_TYPES.has(msg.type)) {
    switch (msg.type) {
      case 'PTR_PING':
        break
      case 'PTR_SET_ACTIVE':
        setActive(!!msg.on)
        if (!msg.on) {
          hideBox(selectBox)
          selectedEl = null
        }
        break
      case 'PTR_COMMENT_MODE':
        setCommentMode(!!msg.on)
        break
      case 'PTR_RESET_ALL':
        resetAll()
        for (const name of Array.from(tokenPristine.keys())) resetToken(name)
        break
      case 'PTR_SHOW_COMMENTS':
        commentsVisible = !!msg.on
        localStorage.setItem(COMMENTS_VISIBLE_KEY, commentsVisible ? '1' : '0')
        renderPins()
        break
    }
    // Every frame executes, but only the top frame answers, so the panel
    // gets exactly one response.
    if (IS_TOP) sendResponse({ ok: true, active })
    return false
  }

  // Frame-scoped messages below.
  const mine = msg.frameToken ? msg.frameToken === FRAME_TOKEN : IS_TOP
  if (!mine) return false

  switch (msg.type) {
    case 'PTR_APPLY_STYLE':
      sendResponse(applyStyle(msg.elementId, msg.prop, msg.value))
      break
    case 'PTR_RESET_STYLE':
      sendResponse(resetStyle(msg.elementId, msg.prop))
      break
    case 'PTR_SET_TEXT':
      sendResponse({ ok: setText(msg.elementId, msg.value) })
      break
    case 'PTR_RESET_TEXT':
      sendResponse({ ok: resetText(msg.elementId) })
      break
    case 'PTR_GET_TREE':
      sendResponse({ ok: true, tree: buildLayerTree() })
      break
    case 'PTR_HOVER_ID': {
      const el = msg.elementId != null ? getEl(msg.elementId) : null
      ensureOverlay()
      if (el) {
        positionBox(hoverBox!, el)
        hoverLabel!.textContent = shortDescriptor(el)
        const r = el.getBoundingClientRect()
        Object.assign(hoverLabel!.style, {
          display: 'block',
          top: `${Math.max(4, r.top - 22)}px`,
          left: `${Math.max(4, r.left)}px`,
        })
      } else {
        hideBox(hoverBox)
        hideBox(hoverLabel as any)
      }
      sendResponse({ ok: true })
      break
    }
    case 'PTR_DESELECT':
      selectedEl = null
      hideBox(selectBox)
      clearGridOverlay()
      sendResponse({ ok: true })
      break
    case 'PTR_RESELECT_ID': {
      const el = getEl(msg.elementId)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        selectElement(el)
      }
      sendResponse({ ok: !!el })
      break
    }
    case 'PTR_TOGGLE_SELECT': {
      const el = getEl(msg.elementId)
      if (el) toggleMultiSelect(el)
      sendResponse({ ok: !!el })
      break
    }
    case 'PTR_MOVE_ELEMENT':
      sendResponse(moveElement(msg.elementId, msg.dir))
      break
    case 'PTR_MOVE_TO_INDEX':
      sendResponse(moveElementToIndex(msg.elementId, msg.index))
      break
    case 'PTR_RESET_MOVE':
      sendResponse({ ok: resetMove(msg.elementId) })
      break
    case 'PTR_REPARENT_ELEMENT':
      sendResponse(reparentElement(msg.elementId, msg.targetId, msg.position))
      break
    case 'PTR_PLACE_ELEMENT':
      sendResponse(placeElement(msg.elementId, msg.parentId, msg.index))
      break
    case 'PTR_INSERT_ELEMENT':
      sendResponse(insertElement(msg.kind, msg.targetId ?? null, msg.position))
      break
    case 'PTR_REMOVE_INSERTED':
      sendResponse({ ok: removeInserted(msg.elementId) })
      break
    case 'PTR_DELETE_ELEMENT':
      sendResponse(deleteElement(msg.elementId))
      break
    case 'PTR_RESTORE_ELEMENT':
      sendResponse({ ok: restoreElement(msg.elementId) })
      break
    case 'PTR_DUPLICATE_ELEMENT':
      sendResponse(duplicateElement(msg.elementId))
      break
    case 'PTR_CREATE_AUTOLAYOUT':
      sendResponse(createAutoLayout(msg.elementIds))
      break
    case 'PTR_UNGROUP':
      sendResponse({ ok: ungroup(msg.elementId) })
      break
    case 'PTR_SET_TRANSFORM': {
      const r = setTransform(msg.elementId, msg.parts)
      const el = getEl(msg.elementId)
      if (el && selectBox && selectedEl === el) positionBox(selectBox, el)
      sendResponse({ ok: !!el, ...r })
      break
    }
    case 'PTR_SELECT_COMMENT': {
      selectedCommentId = msg.id ?? null
      renderPins()
      const el = msg.id ? document.querySelector(`[data-pointer-cid="${msg.id}"]`) : null
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      sendResponse({ ok: true })
      break
    }
    case 'PTR_GET_TOKENS':
      sendResponse({ ok: true, tokens: getTokens() })
      break
    case 'PTR_SET_TOKEN':
      setToken(msg.name, msg.value)
      sendResponse({ ok: true })
      break
    case 'PTR_RESET_TOKEN':
      resetToken(msg.name)
      sendResponse({ ok: true })
      break
    case 'PTR_GET_COMMENTS':
      if (commentsLoaded) {
        sendResponse({ ok: true, comments: loadComments(), visible: commentsVisible })
      } else {
        initComments().then(() =>
          sendResponse({ ok: true, comments: loadComments(), visible: commentsVisible })
        )
        return true
      }
      break
    case 'PTR_ADD_COMMENT': {
      const comments = loadComments()
      comments.push(msg.comment)
      saveComments(comments)
      renderPins()
      sendResponse({ ok: true, comments })
      break
    }
    case 'PTR_DELETE_COMMENT': {
      const comments = loadComments().filter((c) => c.id !== msg.id)
      saveComments(comments)
      renderPins()
      sendResponse({ ok: true, comments })
      break
    }
    case 'PTR_EXPORT_DESIGN': {
      const el = getEl(msg.elementId)
      if (!el) {
        sendResponse({ ok: false })
        break
      }
      buildFigmaTree(el)
        .then((design) => sendResponse({ ok: true, design }))
        .catch(() => sendResponse({ ok: false }))
      return true // keep the channel open for the async response
    }
    case 'PTR_REVEAL': {
      const el =
        document.querySelector(`[data-pointer-cid="${msg.id}"]`) ||
        (() => {
          try {
            return document.querySelector(msg.selector)
          } catch {
            return null
          }
        })()
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      sendResponse({ ok: !!el })
      break
    }
  }
  return false
})
