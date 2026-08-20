// Pointer content script: runs inside the localhost page.
// Handles hover highlighting, element selection, live style edits with
// true revert (restores the element's pristine state), and resolving
// the selected DOM element back to its source file via React fiber.

type SourceInfo = { fileName: string; lineNumber: number } | null

export type SelectionPayload = {
  elementId: number
  tag: string
  id: string
  classes: string[]
  selector: string
  text: string
  componentChain: string[]
  source: SourceInfo
  styles: Record<string, string>
  rect: { width: number; height: number }
}

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
  'opacity',
  'boxShadow',
  'width',
  'height',
] as const

let active = false
let hoverEl: Element | null = null
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
}

function hideBox(box: HTMLDivElement | null) {
  if (box) box.style.display = 'none'
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

function buildPayload(el: Element): SelectionPayload {
  const computed = window.getComputedStyle(el)
  const styles: Record<string, string> = {}
  for (const p of STYLE_PROPS) styles[p] = computed[p as any] as string
  const { source, chain } = resolveSource(el)
  const rect = el.getBoundingClientRect()
  return {
    elementId: registerEl(el),
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    classes: Array.from(el.classList),
    selector: cssSelector(el),
    text: (el.textContent || '').trim().slice(0, 120),
    componentChain: chain,
    source,
    styles,
    rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
  }
}

function selectElement(el: Element) {
  selectedEl = el
  ensureOverlay()
  positionBox(selectBox!, el)
  chrome.runtime.sendMessage({ type: 'PTR_SELECTED', payload: buildPayload(el) })
}

// ---------- edit operations ----------

function applyStyle(id: number, prop: string, value: string): boolean {
  const el = getEl(id)
  if (!el) return false
  const p = ensurePristine(id)
  if (!p.inline.has(prop)) p.inline.set(prop, el.style.getPropertyValue(prop))
  el.style.setProperty(prop, value)
  if (selectedEl === el && selectBox) positionBox(selectBox, el)
  return true
}

function resetStyle(id: number, prop: string): boolean {
  const el = getEl(id)
  if (!el) return false
  const original = pristine.get(id)?.inline.get(prop)
  if (original) el.style.setProperty(prop, original)
  else el.style.removeProperty(prop)
  pristine.get(id)?.inline.delete(prop)
  if (selectedEl === el && selectBox) positionBox(selectBox, el)
  return true
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
  author: string
  createdAt: number
}

const COMMENTS_KEY = () => `__pointer_comments__:${location.pathname}`
const COMMENTS_VISIBLE_KEY = '__pointer_comments_visible__'

let commentMode = false
let commentsVisible = localStorage.getItem(COMMENTS_VISIBLE_KEY) !== '0'
const pinEls: HTMLDivElement[] = []

function loadComments(): PointerComment[] {
  try {
    return JSON.parse(localStorage.getItem(COMMENTS_KEY()) || '[]')
  } catch {
    return []
  }
}

function saveComments(comments: PointerComment[]) {
  localStorage.setItem(COMMENTS_KEY(), JSON.stringify(comments))
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

function renderPins() {
  clearPins()
  if (!commentsVisible) return
  const comments = loadComments()
  comments.forEach((c, i) => {
    const el = resolveCommentEl(c)
    if (!el) return
    if (!el.hasAttribute('data-pointer-cid')) el.setAttribute('data-pointer-cid', c.id)
    const r = el.getBoundingClientRect()
    const pin = document.createElement('div')
    pin.textContent = String(i + 1)
    pin.title = `${c.author}: ${c.text}`
    Object.assign(pin.style, {
      position: 'fixed',
      top: `${r.top - 10}px`,
      left: `${r.left + r.width - 10}px`,
      zIndex: '2147483647',
      width: '20px',
      height: '20px',
      borderRadius: '50% 50% 50% 4px',
      background: '#7c3aed',
      color: '#fff',
      font: 'bold 11px/20px system-ui, sans-serif',
      textAlign: 'center',
      pointerEvents: 'none',
      boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
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

function onMouseMove(e: MouseEvent) {
  if (!active && !commentMode) return
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (!el || el === hoverEl || el === hoverBox || el === hoverLabel) return
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
    .filter((el) => el !== hoverBox && el !== selectBox && el !== hoverLabel)
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

function onClick(e: MouseEvent) {
  if (!active && !commentMode) return
  e.preventDefault()
  e.stopPropagation()
  stackPoint = null
  const el = document.elementFromPoint(e.clientX, e.clientY)
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
        selector: cssSelector(el),
        descriptor: shortDescriptor(el),
      },
    })
    setCommentMode(false)
    return
  }
  selectElement(el)
}

function setCommentMode(on: boolean) {
  commentMode = on
  if (on) {
    ensureOverlay()
    document.addEventListener('mousemove', onMouseMove, true)
    document.addEventListener('click', onClick, true)
    document.documentElement.style.cursor = 'crosshair'
  } else if (!active) {
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('click', onClick, true)
    document.documentElement.style.cursor = ''
    hideBox(hoverBox)
    hideBox(hoverLabel as any)
  }
}

function onScrollOrResize() {
  if (selectedEl && selectBox) positionBox(selectBox, selectedEl)
  hideBox(hoverBox)
  hideBox(hoverLabel as any)
}

function setActive(on: boolean) {
  active = on
  if (on) {
    ensureOverlay()
    document.addEventListener('mousemove', onMouseMove, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('contextmenu', onContextMenu, true)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    document.documentElement.style.cursor = 'crosshair'
  } else {
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('contextmenu', onContextMenu, true)
    window.removeEventListener('scroll', onScrollOrResize, true)
    window.removeEventListener('resize', onScrollOrResize)
    document.documentElement.style.cursor = ''
    hideBox(hoverBox)
    hideBox(hoverLabel as any)
  }
}

// ---------- export selection to Figma (as pasteable SVG) ----------
// Figma's paste handler accepts raw SVG markup on the clipboard and turns
// it into real, editable layers — <text> becomes an editable text layer,
// shapes become vectors. We rebuild the selected subtree as SVG rather
// than just serializing outerHTML, since Figma can't parse arbitrary HTML/CSS.

function toHex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
}

// Returns null for fully transparent / keyword values we don't paint (e.g. "transparent").
function parseCssColor(value: string): { hex: string; alpha: number } | null {
  const v = value.trim()
  if (!v || v === 'transparent') return null
  const m = v.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\)/)
  if (!m) return null
  const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1
  if (alpha <= 0) return null
  return {
    hex: `#${toHex2(+m[1])}${toHex2(+m[2])}${toHex2(+m[3])}`,
    alpha,
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Groups the visual lines of a wrapped text node using Range.getClientRects(),
// which returns one rect per rendered line. We walk word-by-word, growing a
// Range, and start a new line whenever the rect's top jumps — a cheap
// approximation that works well for normal left-to-right UI copy.
function getTextLines(node: Text): { text: string; rect: DOMRect }[] {
  const full = node.textContent || ''
  if (!full.trim()) return []
  const words = full.split(/(\s+)/) // keep separators so offsets line up
  const lines: { text: string; rect: DOMRect }[] = []
  let offset = 0
  let lineStart = 0
  let lineTop: number | null = null
  const range = document.createRange()

  const flush = (endOffset: number, rect: DOMRect) => {
    const text = full.slice(lineStart, endOffset)
    if (text.trim()) lines.push({ text, rect })
    lineStart = endOffset
  }

  for (const word of words) {
    const start = offset
    const end = offset + word.length
    offset = end
    if (!word.trim()) continue // whitespace-only chunk, don't measure
    try {
      range.setStart(node, start)
      range.setEnd(node, end)
    } catch {
      continue
    }
    const rects = range.getClientRects()
    if (!rects.length) continue
    const rect = rects[0]
    if (lineTop === null) {
      lineTop = rect.top
    } else if (Math.abs(rect.top - lineTop) > 2) {
      // New visual line: close out the previous one using its own last rect.
      range.setStart(node, lineStart)
      range.setEnd(node, start)
      const prevRects = range.getClientRects()
      if (prevRects.length) flush(start, prevRects[prevRects.length - 1])
      lineTop = rect.top
    }
  }
  range.setStart(node, lineStart)
  range.setEnd(node, full.length)
  const finalRects = range.getClientRects()
  if (finalRects.length) flush(full.length, finalRects[finalRects.length - 1])
  return lines
}

function fontWeightNumber(computed: string): number {
  const n = parseInt(computed, 10)
  return Number.isNaN(n) ? 400 : n
}

function svgTextElement(
  text: string,
  x: number,
  y: number,
  style: CSSStyleDeclaration
): string {
  const color = parseCssColor(style.color) ?? { hex: '#000000', alpha: 1 }
  const fontSize = parseFloat(style.fontSize) || 16
  const family = style.fontFamily.split(',')[0].replace(/["']/g, '').trim()
  const weight = fontWeightNumber(style.fontWeight)
  const anchorMap: Record<string, string> = {
    center: 'middle',
    right: 'end',
    left: 'start',
    justify: 'start',
  }
  const anchor = anchorMap[style.textAlign] || 'start'
  // Bake in text-transform: it only changes rendering, not textContent, so
  // without this the exported layer would show the original casing instead
  // of what's actually visible on the page (e.g. an uppercase button label).
  let display = text
  if (style.textTransform === 'uppercase') display = display.toUpperCase()
  else if (style.textTransform === 'lowercase') display = display.toLowerCase()
  else if (style.textTransform === 'capitalize')
    display = display.replace(/\b\w/g, (c) => c.toUpperCase())
  // y is the top of the line box (from getClientRects), so anchor text
  // there directly instead of guessing a baseline offset per font.
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" dominant-baseline="text-before-edge" font-family="${esc(
    family
  )}" font-size="${fontSize.toFixed(1)}" font-weight="${weight}" fill="${color.hex}" fill-opacity="${color.alpha}" text-anchor="${anchor}">${esc(display)}</text>`
}

function elementToSvg(el: Element, originX: number, originY: number, out: string[]) {
  if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return

  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const x = rect.left - originX
  const y = rect.top - originY

  // Pass inline SVG icons through as-is, positioned via a translated group.
  if (el instanceof SVGElement) {
    out.push(`<g transform="translate(${x.toFixed(1)}, ${y.toFixed(1)})">${el.outerHTML}</g>`)
    return
  }

  if (el instanceof HTMLImageElement && el.src) {
    out.push(
      `<image x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${rect.width.toFixed(
        1
      )}" height="${rect.height.toFixed(1)}" href="${esc(el.src)}" preserveAspectRatio="none" />`
    )
    return
  }

  // Background + border, drawn at the literal border-box rect. SVG strokes
  // are centered on the path rather than inset like CSS borders, but that's
  // a sub-pixel difference — not worth risking distortion for elements
  // whose border width differs per side (a shrink hack here previously
  // threw off padding/gap-sensitive layouts).
  const bg = parseCssColor(style.backgroundColor)
  const borderWidth = parseFloat(style.borderTopWidth) || 0
  const hasBorder = borderWidth > 0 && style.borderTopStyle !== 'none'
  const borderColor = hasBorder ? parseCssColor(style.borderTopColor) : null
  const radius = parseFloat(style.borderTopLeftRadius) || 0
  const opacity = parseFloat(style.opacity)

  if (bg || borderColor) {
    const attrs = [
      `x="${x.toFixed(1)}"`,
      `y="${y.toFixed(1)}"`,
      `width="${rect.width.toFixed(1)}"`,
      `height="${rect.height.toFixed(1)}"`,
    ]
    if (radius > 0) attrs.push(`rx="${radius.toFixed(1)}"`, `ry="${radius.toFixed(1)}"`)
    attrs.push(bg ? `fill="${bg.hex}" fill-opacity="${bg.alpha}"` : `fill="none"`)
    if (borderColor) {
      attrs.push(
        `stroke="${borderColor.hex}" stroke-opacity="${borderColor.alpha}" stroke-width="${borderWidth}"`
      )
    }
    if (!Number.isNaN(opacity) && opacity < 1) attrs.push(`opacity="${opacity}"`)
    out.push(`<rect ${attrs.join(' ')} />`)
  }

  // Direct text nodes only (not text belonging to nested elements, which
  // get handled when we recurse into them below).
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && (child.textContent || '').trim()) {
      for (const line of getTextLines(child as Text)) {
        const lineX = line.rect.left - originX
        const lineY = line.rect.top - originY
        let textX = lineX
        if (style.textAlign === 'center') textX = lineX + line.rect.width / 2
        else if (style.textAlign === 'right') textX = lineX + line.rect.width
        out.push(svgTextElement(line.text.trim(), textX, lineY, style))
      }
    }
  }

  for (const child of Array.from(el.children)) {
    elementToSvg(child, originX, originY, out)
  }
}

function buildFigmaSvg(root: Element): string {
  const rect = root.getBoundingClientRect()
  const out: string[] = []
  elementToSvg(root, rect.left, rect.top, out)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width.toFixed(
    1
  )}" height="${rect.height.toFixed(1)}" viewBox="0 0 ${rect.width.toFixed(
    1
  )} ${rect.height.toFixed(1)}">\n${out.join('\n')}\n</svg>`
}

// ---------- messages from the side panel ----------

chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: any) => {
  switch (msg.type) {
    case 'PTR_PING':
      sendResponse({ ok: true, active })
      break
    case 'PTR_SET_ACTIVE':
      setActive(!!msg.on)
      if (!msg.on) {
        hideBox(selectBox)
        selectedEl = null
      }
      sendResponse({ ok: true })
      break
    case 'PTR_APPLY_STYLE':
      sendResponse({ ok: applyStyle(msg.elementId, msg.prop, msg.value) })
      break
    case 'PTR_RESET_STYLE':
      sendResponse({ ok: resetStyle(msg.elementId, msg.prop) })
      break
    case 'PTR_SET_TEXT':
      sendResponse({ ok: setText(msg.elementId, msg.value) })
      break
    case 'PTR_RESET_TEXT':
      sendResponse({ ok: resetText(msg.elementId) })
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
    case 'PTR_RESET_ALL':
      resetAll()
      for (const name of Array.from(tokenPristine.keys())) resetToken(name)
      sendResponse({ ok: true })
      break
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
    case 'PTR_COMMENT_MODE':
      setCommentMode(!!msg.on)
      sendResponse({ ok: true })
      break
    case 'PTR_GET_COMMENTS':
      sendResponse({ ok: true, comments: loadComments(), visible: commentsVisible })
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
    case 'PTR_SHOW_COMMENTS':
      commentsVisible = !!msg.on
      localStorage.setItem(COMMENTS_VISIBLE_KEY, commentsVisible ? '1' : '0')
      renderPins()
      sendResponse({ ok: true })
      break
    case 'PTR_EXPORT_SVG': {
      const el = getEl(msg.elementId)
      if (!el) {
        sendResponse({ ok: false })
        break
      }
      sendResponse({ ok: true, svg: buildFigmaSvg(el) })
      break
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
