// Pointer content script: runs inside the localhost page.
// Handles hover highlighting, element selection, live style edits with
// true revert (restores the element's pristine state), and resolving
// the selected DOM element back to its source file via React fiber.

type SourceInfo = { fileName: string; lineNumber: number } | null

// With all_frames enabled, one copy of this script runs per frame (the app
// may live inside an iframe, e.g. hosted platforms like Urdi). Each copy
// tags what it sends with a unique token so the panel can route follow-up
// messages (style edits, exports) back to the frame that owns the element.
const FRAME_TOKEN = crypto.randomUUID()
const IS_TOP = window === window.top

export type SelectionPayload = {
  frameToken: string
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
  /** Position among siblings, so reordering controls can show "2 of 5". */
  index: number
  siblingCount: number
  /** True for elements Pointer created (insert or duplicate). */
  isNew: boolean
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
  'transform',
  'flexWrap',
  'gridTemplateColumns',
  'alignSelf',
  'flexGrow',
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
    frameToken: FRAME_TOKEN,
    elementId: registerEl(el),
    index: el.parentElement ? Array.from(el.parentElement.children).indexOf(el) : 0,
    siblingCount: el.parentElement ? el.parentElement.children.length : 1,
    isNew: el.hasAttribute('data-pointer-new'),
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
  clearHighlight()
  drawGridOverlay(el)
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
    pin.title = `${c.author}: ${c.text}`
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
  edgeLines: HTMLDivElement[]
  edgeLabels: HTMLDivElement[]
} = { hLine: null, vLine: null, hLabel: null, vLabel: null, edgeLines: [], edgeLabels: [] }

function ensureMeasure() {
  if (measure.hLine) return
  measure.hLine = makeMeasureLine()
  measure.vLine = makeMeasureLine()
  measure.hLabel = makeMeasureLabel()
  measure.vLabel = makeMeasureLabel()
  for (let i = 0; i < 4; i++) {
    measure.edgeLines.push(makeMeasureLine())
    measure.edgeLabels.push(makeMeasureLabel())
  }
}

function hideMeasure() {
  if (!measure.hLine) return
  hideBox(measure.hLine)
  hideBox(measure.vLine)
  hideBox(measure.hLabel)
  hideBox(measure.vLabel)
  for (const l of measure.edgeLines) hideBox(l)
  for (const l of measure.edgeLabels) hideBox(l)
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

// Alt+Shift + hover: this element's padding on all four sides.
function drawPaddingOverlay(el: Element) {
  ensureMeasure()
  ensureOverlay()
  positionBox(hoverBox!, el)
  const r = el.getBoundingClientRect()
  const s = getComputedStyle(el)
  const pt = parseFloat(s.paddingTop) || 0
  const pr = parseFloat(s.paddingRight) || 0
  const pb = parseFloat(s.paddingBottom) || 0
  const pl = parseFloat(s.paddingLeft) || 0

  const edges: [number, number, number, number, number][] = [
    [r.left, r.top, r.width, pt, pt], // top
    [r.left, r.bottom - pb, r.width, pb, pb], // bottom
    [r.left, r.top + pt, pl, Math.max(0, r.height - pt - pb), pl], // left
    [r.right - pr, r.top + pt, pr, Math.max(0, r.height - pt - pb), pr], // right
  ]

  edges.forEach(([x, y, w, h, value], i) => {
    const line = measure.edgeLines[i]
    const label = measure.edgeLabels[i]
    if (value <= 0 || w <= 0 || h <= 0) {
      hideBox(line)
      hideBox(label)
      return
    }
    Object.assign(line.style, {
      display: 'block',
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
      background: 'rgba(244, 63, 94, 0.25)',
    })
    placeLabel(label, x + w / 2 - 8, y + h / 2 - 8, `${Math.round(value)}`)
  })
}

// Alt+Ctrl + hover: distance from this element to each viewport edge.
function drawViewportOverlay(el: Element) {
  ensureMeasure()
  ensureOverlay()
  positionBox(hoverBox!, el)
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2

  placeVLine(measure.edgeLines[0], 0, r.top, cx)
  placeLabel(measure.edgeLabels[0], cx + 4, r.top / 2 - 8, `${Math.round(r.top)}`)
  placeVLine(measure.edgeLines[1], r.bottom, vh, cx)
  placeLabel(measure.edgeLabels[1], cx + 4, r.bottom + (vh - r.bottom) / 2 - 8, `${Math.round(vh - r.bottom)}`)
  placeHLine(measure.edgeLines[2], 0, r.left, cy)
  placeLabel(measure.edgeLabels[2], r.left / 2 - 12, cy - 18, `${Math.round(r.left)}`)
  placeHLine(measure.edgeLines[3], r.right, vw, cy)
  placeLabel(measure.edgeLabels[3], r.right + (vw - r.right) / 2 - 12, cy - 18, `${Math.round(vw - r.right)}`)
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

// Arrow keys nudge the selected element via `transform: translate(...)`,
// which works regardless of the underlying layout method (flex/grid/static)
// without fighting margins the page's own CSS might rely on.
const nudgeOffsets = new Map<number, { dx: number; dy: number }>()

function nudgeSelected(dx: number, dy: number) {
  if (!selectedEl) return
  const id = registerEl(selectedEl)
  const before = buildPayload(selectedEl)
  const cur = nudgeOffsets.get(id) ?? { dx: 0, dy: 0 }
  const next = { dx: cur.dx + dx, dy: cur.dy + dy }
  nudgeOffsets.set(id, next)
  const value = `translate(${next.dx}px, ${next.dy}px)`
  applyStyle(id, 'transform', value)
  chrome.runtime.sendMessage({
    type: 'PTR_NUDGED',
    payload: {
      elementId: id,
      value,
      from: cur.dx === 0 && cur.dy === 0 ? 'none' : `translate(${cur.dx}px, ${cur.dy}px)`,
      target: before,
    },
  })
}

function selectParent() {
  if (!selectedEl?.parentElement) return
  if (selectedEl.parentElement === document.body) return
  selectElement(selectedEl.parentElement)
}

function selectFirstChild() {
  if (!selectedEl) return
  const child = selectedEl.children[0]
  if (child) selectElement(child)
}

function onKeyDown(e: KeyboardEvent) {
  if (!active) return
  const target = e.target as HTMLElement | null
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
    return

  if (e.key === 'Tab' && selectedEl) {
    e.preventDefault()
    if (e.shiftKey) selectFirstChild()
    else selectParent()
    return
  }
  if (e.key.startsWith('Arrow') && selectedEl && !e.altKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault()
    const step = e.shiftKey ? 10 : 1
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
    }
    const d = deltas[e.key]
    if (d) nudgeSelected(d[0], d[1])
    return
  }
  if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && selectedEl) {
    copyStyleFromSelected()
    return
  }
  if ((e.key === 'v' || e.key === 'V') && !e.metaKey && !e.ctrlKey && hoverEl) {
    pasteStyleToHovered()
    return
  }
  if (e.key === 'h' || e.key === 'H') {
    toggleHighlightSiblings()
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEl) {
    e.preventDefault()
    const id = registerEl(selectedEl)
    const target = buildPayload(selectedEl)
    const r = deleteElement(id)
    if (r.ok) {
      chrome.runtime.sendMessage({
        type: 'PTR_DELETED',
        payload: { elementId: id, target, desc: r.desc, inserted: r.inserted },
      })
    }
    return
  }
  if ((e.key === 'd' || e.key === 'D') && (e.metaKey || e.ctrlKey) && selectedEl) {
    e.preventDefault()
    const r = duplicateElement(registerEl(selectedEl))
    if (r.ok) {
      chrome.runtime.sendMessage({
        type: 'PTR_DUPLICATED',
        payload: { payload: r.payload, html: r.html, parentDesc: r.parentDesc },
      })
    }
    return
  }
  // Reorder the selection among its siblings, which is how you move an
  // element left/right (or up/down) inside a flex or grid layout.
  if ((e.key === '[' || e.key === ']') && selectedEl) {
    e.preventDefault()
    const id = registerEl(selectedEl)
    const target = buildPayload(selectedEl)
    const r = moveElement(id, e.key === '[' ? 'prev' : 'next')
    if (r.ok) {
      chrome.runtime.sendMessage({
        type: 'PTR_MOVED',
        payload: { elementId: id, target, from: r.from, to: r.to, parentDesc: r.parentDesc },
      })
    }
  }
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key === 'Alt' || e.key === 'Shift' || e.key === 'Control') hideMeasure()
}

function onMouseMove(e: MouseEvent) {
  if (!active && !commentMode) return
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (!el) return
  if (el instanceof HTMLElement && el.dataset.pointerPin) return

  if (active && !commentMode && e.altKey) {
    hoverEl = el
    hideBox(hoverLabel)
    if (e.ctrlKey) drawViewportOverlay(el)
    else if (e.shiftKey) drawPaddingOverlay(el)
    else if (selectedEl && el !== selectedEl) drawDistanceOverlay(selectedEl, el)
    else drawPaddingOverlay(el)
    return
  }
  hideMeasure()
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

function onMouseDown(e: MouseEvent) {
  if (!active || commentMode || e.button !== 0 || e.altKey) return
  if (!selectedEl) return
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (!el || (el !== selectedEl && !selectedEl.contains(el))) return
  const id = registerEl(selectedEl)
  const base = nudgeOffsets.get(id) ?? { dx: 0, dy: 0 }
  dragState = {
    id,
    startX: e.clientX,
    startY: e.clientY,
    baseX: base.dx,
    baseY: base.dy,
    moved: false,
  }
}

function onDragMove(e: MouseEvent) {
  if (!dragState) return
  const dx = e.clientX - dragState.startX
  const dy = e.clientY - dragState.startY
  if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
  dragState.moved = true
  e.preventDefault()
  const next = { dx: dragState.baseX + dx, dy: dragState.baseY + dy }
  nudgeOffsets.set(dragState.id, next)
  applyStyle(dragState.id, 'transform', `translate(${next.dx}px, ${next.dy}px)`)
  if (selectBox && selectedEl) positionBox(selectBox, selectedEl)
}

function onMouseUp() {
  if (!dragState) return
  const { id, moved, baseX, baseY } = dragState
  dragState = null
  if (!moved) return
  const offset = nudgeOffsets.get(id) ?? { dx: 0, dy: 0 }
  const el = getEl(id)
  if (!el) return
  chrome.runtime.sendMessage({
    type: 'PTR_NUDGED',
    payload: {
      elementId: id,
      value: `translate(${offset.dx}px, ${offset.dy}px)`,
      from: baseX === 0 && baseY === 0 ? 'none' : `translate(${baseX}px, ${baseY}px)`,
      target: buildPayload(el),
    },
  })
  // Swallow the click that ends the drag so it doesn't re-select.
  document.addEventListener('click', (ev) => ev.stopPropagation(), {
    capture: true,
    once: true,
  })
}

function onClick(e: MouseEvent) {
  if (!active && !commentMode) return
  const el = document.elementFromPoint(e.clientX, e.clientY)
  // Pins have their own click handler; let it run instead of selecting.
  if (el instanceof HTMLElement && el.dataset.pointerPin) return
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
  if (selectedEl) drawGridOverlay(selectedEl)
  clearHighlight()
  hideBox(hoverBox)
  hideBox(hoverLabel as any)
  hideMeasure()
}

function setActive(on: boolean) {
  active = on
  if (on) {
    ensureOverlay()
    document.addEventListener('mousemove', onMouseMove, true)
    document.addEventListener('mousemove', onDragMove, true)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    document.documentElement.style.cursor = 'crosshair'
  } else {
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('mousemove', onDragMove, true)
    document.removeEventListener('mousedown', onMouseDown, true)
    document.removeEventListener('mouseup', onMouseUp, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('contextmenu', onContextMenu, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('keyup', onKeyUp, true)
    dragState = null
    window.removeEventListener('scroll', onScrollOrResize, true)
    window.removeEventListener('resize', onScrollOrResize)
    document.documentElement.style.cursor = ''
    hideBox(hoverBox)
    hideBox(hoverLabel as any)
    hideMeasure()
    clearGridOverlay()
    clearHighlight()
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

// Real font metrics via a hidden canvas, so text can be positioned by its
// actual baseline. Figma's SVG importer anchors <text> strictly at the
// baseline and ignores dominant-baseline, so guessing (or relying on that
// attribute) shifts every text layer and makes the whole paste look like
// its spacing is wrong.
let metricsCtx: CanvasRenderingContext2D | null = null

function baselineWithinLine(style: CSSStyleDeclaration, lineBoxHeight: number): number {
  const fontSize = parseFloat(style.fontSize) || 16
  if (!metricsCtx) metricsCtx = document.createElement('canvas').getContext('2d')
  let ascent = fontSize * 0.8
  let descent = fontSize * 0.2
  if (metricsCtx) {
    try {
      metricsCtx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const m = metricsCtx.measureText('Mg')
      if (m.fontBoundingBoxAscent) ascent = m.fontBoundingBoxAscent
      if (m.fontBoundingBoxDescent) descent = m.fontBoundingBoxDescent
    } catch {
      // keep the estimate
    }
  }
  // The line box may be taller than the glyphs (line-height leading);
  // browsers center the glyph box inside it.
  const leading = Math.max(0, lineBoxHeight - (ascent + descent))
  return leading / 2 + ascent
}

function svgTextElement(
  text: string,
  x: number,
  baselineY: number,
  style: CSSStyleDeclaration
): string {
  const color = parseCssColor(style.color) ?? { hex: '#000000', alpha: 1 }
  const fontSize = parseFloat(style.fontSize) || 16
  const family = style.fontFamily.split(',')[0].replace(/["']/g, '').trim()
  const weight = fontWeightNumber(style.fontWeight)
  // Bake in text-transform: it only changes rendering, not textContent, so
  // without this the exported layer would show the original casing instead
  // of what's actually visible on the page (e.g. an uppercase button label).
  let display = text
  if (style.textTransform === 'uppercase') display = display.toUpperCase()
  else if (style.textTransform === 'lowercase') display = display.toLowerCase()
  else if (style.textTransform === 'capitalize')
    display = display.replace(/\b\w/g, (c) => c.toUpperCase())
  const attrs = [
    `x="${x.toFixed(1)}"`,
    `y="${baselineY.toFixed(1)}"`,
    `font-family="${esc(family)}"`,
    `font-size="${fontSize.toFixed(1)}"`,
    `font-weight="${weight}"`,
    `fill="${color.hex}"`,
    `fill-opacity="${color.alpha}"`,
  ]
  const ls = parseFloat(style.letterSpacing)
  if (!Number.isNaN(ls) && ls !== 0) attrs.push(`letter-spacing="${ls.toFixed(2)}"`)
  return `<text ${attrs.join(' ')}>${esc(display)}</text>`
}

function elementToSvg(
  el: Element,
  originX: number,
  originY: number,
  out: string[],
  imgData: Map<string, string>
) {
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
    // Figma won't fetch external URLs when pasting an SVG, so images must
    // travel embedded as data URIs (fetched beforehand by inlineImages).
    const href = imgData.get(el.src) ?? el.src
    out.push(
      `<image x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${rect.width.toFixed(
        1
      )}" height="${rect.height.toFixed(1)}" href="${esc(href)}" preserveAspectRatio="none" />`
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
  // get handled when we recurse into them below). Each rendered line is
  // placed at its measured left edge with a baseline computed from real
  // font metrics — the alignment is already baked into where the line
  // rect sits, so no SVG text-anchor tricks are needed.
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && (child.textContent || '').trim()) {
      for (const line of getTextLines(child as Text)) {
        const lineX = line.rect.left - originX
        const baselineY =
          line.rect.top - originY + baselineWithinLine(style, line.rect.height)
        out.push(svgTextElement(line.text.trim(), lineX, baselineY, style))
      }
    }
  }

  for (const child of Array.from(el.children)) {
    elementToSvg(child, originX, originY, out, imgData)
  }
}

// Fetch every <img> in the subtree and convert it to a data URI. Same-origin
// (localhost) images always work; cross-origin ones without CORS headers are
// left as URLs (Figma will drop them, but nothing else breaks).
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
        // leave as URL
      }
    })
  )
  return map
}

async function buildFigmaSvg(root: Element): Promise<string> {
  const rect = root.getBoundingClientRect()
  const imgData = await inlineImages(root)
  const out: string[] = []
  elementToSvg(root, rect.left, rect.top, out, imgData)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width.toFixed(
    1
  )}" height="${rect.height.toFixed(1)}" viewBox="0 0 ${rect.width.toFixed(
    1
  )} ${rect.height.toFixed(1)}">\n${out.join('\n')}\n</svg>`
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
    case 'PTR_MOVE_ELEMENT':
      sendResponse(moveElement(msg.elementId, msg.dir))
      break
    case 'PTR_RESET_MOVE':
      sendResponse({ ok: resetMove(msg.elementId) })
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
    case 'PTR_EXPORT_SVG': {
      const el = getEl(msg.elementId)
      if (!el) {
        sendResponse({ ok: false })
        break
      }
      buildFigmaSvg(el)
        .then((svg) => sendResponse({ ok: true, svg }))
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
