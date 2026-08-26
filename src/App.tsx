import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Copy,
  Check,
  Undo2,
  Redo2,
  RotateCcw,
  MessageSquarePlus,
  Trash2,
  Settings,
  X,
  Download,
  ArrowRight,
  Layers,
  Keyboard,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  Square,
  Circle,
  Type,
  Rows3,
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  type SelectionPayload,
  type Edit,
  type TokenEdit,
  type PointerComment,
  sendToPage,
  generatePrompt,
} from '@/lib/pointer'

type StyleField = {
  prop: string
  label: string
  type: 'color' | 'text' | 'select' | 'unit'
  options?: string[]
  /** Keyword the browser reports that really means zero (e.g. letter-spacing: normal). */
  zeroKeyword?: string
}

const UNITS = ['px', 'rem', 'em', '%']

// Splits "16px" into { num: "16", unit: "px" }. Non-numeric values
// (e.g. "normal") return null so the field can fall back gracefully.
function parseUnit(value: string): { num: string; unit: string } | null {
  const m = value.match(/^(-?[\d.]+)(px|rem|em|%)?$/)
  if (!m) return null
  return { num: m[1], unit: m[2] ?? 'px' }
}

const GROUPS: { title: string; fields: StyleField[] }[] = [
  {
    title: 'Color',
    fields: [
      { prop: 'color', label: 'Text color', type: 'color' },
      { prop: 'backgroundColor', label: 'Background', type: 'color' },
      { prop: 'borderColor', label: 'Border color', type: 'color' },
    ],
  },
  {
    title: 'Typography',
    fields: [
      { prop: 'fontSize', label: 'Size', type: 'unit' },
      {
        prop: 'fontWeight',
        label: 'Weight',
        type: 'select',
        options: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
      },
      {
        prop: 'lineHeight',
        label: 'Line height',
        type: 'select',
        options: ['normal', '1', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.75', '2'],
      },
      {
        prop: 'letterSpacing',
        label: 'Letter spacing',
        type: 'unit',
        zeroKeyword: 'normal',
      },
      {
        prop: 'textAlign',
        label: 'Align',
        type: 'select',
        options: ['left', 'center', 'right', 'justify'],
      },
    ],
  },
  {
    title: 'Spacing',
    fields: [
      { prop: 'paddingTop', label: 'Padding top', type: 'unit' },
      { prop: 'paddingRight', label: 'Padding right', type: 'unit' },
      { prop: 'paddingBottom', label: 'Padding bottom', type: 'unit' },
      { prop: 'paddingLeft', label: 'Padding left', type: 'unit' },
      { prop: 'gap', label: 'Gap', type: 'unit' },
    ],
  },
  {
    title: 'Border',
    fields: [
      { prop: 'borderRadius', label: 'Radius', type: 'unit' },
      { prop: 'borderWidth', label: 'Width', type: 'unit' },
    ],
  },
]

const toKebab = (p: string) => p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())

type ColorFormat = 'hex' | 'rgb'

type ParsedColor = {
  r: number
  g: number
  b: number
  alpha: number
  /** No paint at all — must not be shown as a solid color. */
  transparent: boolean
  /** Value we couldn't interpret (gradients, images, unusual syntaxes). */
  unknown: boolean
}

const NO_COLOR: ParsedColor = { r: 0, g: 0, b: 0, alpha: 0, transparent: true, unknown: false }

function parseColor(value: string): ParsedColor {
  const v = (value || '').trim()
  if (!v || v === 'transparent' || v === 'none') return NO_COLOR

  const hex = v.match(/^#([0-9a-f]{3,8})$/i)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return { r, g, b, alpha, transparent: alpha === 0, unknown: false }
  }

  // getComputedStyle normalizes to rgb()/rgba(); modern space-separated
  // syntax (`rgb(0 0 0 / 50%)`) is handled by the loose split below.
  const rgb = v.match(/^rgba?\(([^)]+)\)$/i)
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean)
    const r = parseFloat(parts[0])
    const g = parseFloat(parts[1])
    const b = parseFloat(parts[2])
    let alpha = 1
    if (parts[3] != null) {
      alpha = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
    }
    if ([r, g, b].some(Number.isNaN)) return { ...NO_COLOR, unknown: true, transparent: false }
    return { r, g, b, alpha, transparent: alpha === 0, unknown: false }
  }

  return { r: 0, g: 0, b: 0, alpha: 1, transparent: false, unknown: true }
}

function toHex(c: ParsedColor): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

/** Hex for <input type="color">, which only accepts 6-digit hex. */
function swatchHex(value: string): string {
  const c = parseColor(value)
  return c.transparent || c.unknown ? '#ffffff' : toHex(c)
}

/**
 * What the text field shows. Transparent and unrecognized values are shown
 * verbatim rather than coerced into a color — showing `#000000` for an
 * element that has no background is what made selections look wrong.
 */
function formatColor(value: string, format: ColorFormat): string {
  const c = parseColor(value)
  if (c.transparent) return 'transparent'
  if (c.unknown) return value
  if (format === 'rgb') {
    return c.alpha < 1
      ? `rgba(${c.r}, ${c.g}, ${c.b}, ${Number(c.alpha.toFixed(3))})`
      : `rgb(${c.r}, ${c.g}, ${c.b})`
  }
  if (c.alpha < 1) {
    return toHex(c) + Math.round(c.alpha * 255).toString(16).padStart(2, '0')
  }
  return toHex(c)
}

// Checkerboard behind the swatch so "no color" reads as empty, not black.
const CHECKER =
  'repeating-conic-gradient(#cbd5e1 0% 25%, #ffffff 0% 50%) 50% / 8px 8px'

type Token = { name: string; value: string }

/** `--card-bg` → `Card bg`, so the list reads like a palette, not like CSS. */
function tokenLabel(name: string): string {
  const clean = name.replace(/^--/, '').replace(/[-_]/g, ' ').trim()
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

function groupTokens(tokens: Token[]): { title: string; items: Token[] }[] {
  const groups: Record<string, Token[]> = {
    Colors: [],
    Spacing: [],
    Radius: [],
    Typography: [],
    Other: [],
  }
  for (const t of tokens) {
    const n = t.name.toLowerCase()
    const parsed = parseColor(t.value)
    if (!parsed.unknown && !parsed.transparent) groups.Colors.push(t)
    else if (/radius|rounded/.test(n)) groups.Radius.push(t)
    else if (/font|text|leading|tracking|letter/.test(n)) groups.Typography.push(t)
    else if (/space|spacing|gap|gutter|size|width|height|padding|margin/.test(n))
      groups.Spacing.push(t)
    else groups.Other.push(t)
  }
  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([title, items]) => ({ title, items }))
}

function ColorField({
  value,
  format,
  edited,
  onChange,
}: {
  value: string
  format: ColorFormat
  edited: boolean
  onChange: (v: string) => void
}) {
  const parsed = parseColor(value)
  return (
    <div className="flex items-center gap-1.5">
      <div
        className="relative size-8 shrink-0 overflow-hidden rounded border"
        style={{ background: CHECKER }}
        title={parsed.transparent ? 'No color set' : value}
      >
        <div className="absolute inset-0" style={{ background: parsed.transparent ? 'transparent' : value }} />
        <input
          type="color"
          value={swatchHex(value)}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </div>
      <Input
        value={formatColor(value, format)}
        onChange={(e) => onChange(e.target.value)}
        className={
          'h-8 font-mono text-xs' +
          (edited ? ' border-primary bg-primary/5' : '') +
          (parsed.transparent ? ' text-muted-foreground' : '')
        }
      />
    </div>
  )
}

// One history entry per user action, so it can be undone/redone on the page.
type HistoryOp = {
  frameToken: string
  elementId: number
  kind: 'style' | 'text' | 'move'
  prop: string // css prop (camelCase), 'text', or 'order'
  from: string
  to: string
}

export default function App() {
  const [active, setActive] = useState(false)
  const [selection, setSelection] = useState<SelectionPayload | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [edits, setEdits] = useState<Edit[]>([])
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)
  const [figmaCopied, setFigmaCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [colorFormat, setColorFormat] = useState<ColorFormat>('hex')
  const [activeTab, setActiveTab] = useState('element')

  // Last frame the user interacted with; frame-scoped requests that aren't
  // tied to a specific element (tokens, comments) go to this frame.
  const lastFrameRef = useRef<string | null>(null)

  // Undo/redo stack. historyRef holds ops; index points AFTER the last applied op.
  const historyRef = useRef<HistoryOp[]>([])
  const [historyIndex, setHistoryIndex] = useState(0)

  // Comments
  const [comments, setComments] = useState<PointerComment[]>([])
  const [commentsVisible, setCommentsVisible] = useState(true)
  const [author, setAuthor] = useState('')
  const [picking, setPicking] = useState(false)
  const [pendingTarget, setPendingTarget] = useState<{
    id: string
    frameToken: string
    selector: string
    descriptor: string
  } | null>(null)
  const [newCommentText, setNewCommentText] = useState('')
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null)

  // Design tokens
  const [tokens, setTokens] = useState<{ name: string; value: string }[]>([])
  const [tokenDraft, setTokenDraft] = useState<Record<string, string>>({})
  const [tokenEdits, setTokenEdits] = useState<TokenEdit[]>([])
  const [advancedTokens, setAdvancedTokens] = useState(false)

  // Keep a port open to the background for as long as this panel lives, so
  // it can switch inspect off when the panel closes by any means.
  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'pointer-panel' })
    return () => port.disconnect()
  }, [])

  useEffect(() => {
    const listener = (msg: any) => {
      if (msg.type === 'PTR_SELECTED') {
        lastFrameRef.current = msg.payload.frameToken
        setSelection(msg.payload)
        setDraft({ ...msg.payload.styles })
        setText(msg.payload.text)
      }
      if (msg.type === 'PTR_COMMENT_CLICKED') {
        lastFrameRef.current = msg.payload.frameToken
        setSelectedCommentId(msg.payload.id)
        setActiveTab('comments')
        loadCommentsAndTokens()
      }
      if (msg.type === 'PTR_DELETED') {
        const { elementId, target, inserted } = msg.payload
        if (inserted) {
          // It was an element Pointer added; drop its insert edit instead of
          // recording a deletion the codebase knows nothing about.
          setEdits((prev) => prev.filter((e) => e.target.elementId !== elementId))
        } else {
          upsertEdit(target, 'remove', 'element', 'present', 'removed')
        }
        setSelection(null)
      }
      if (msg.type === 'PTR_DUPLICATED') {
        const { payload, html, parentDesc } = msg.payload
        if (payload) upsertEdit(payload, 'insert', 'element', '', html, parentDesc)
      }
      if (msg.type === 'PTR_MOVED') {
        const { elementId, target, from, to, parentDesc } = msg.payload
        pushHistory({
          frameToken: target.frameToken,
          elementId,
          kind: 'move',
          prop: 'order',
          from: String(from),
          to: String(to),
        })
        upsertEdit(target, 'move', 'order', String(from), String(to), parentDesc)
      }
      if (msg.type === 'PTR_COMMENT_TARGET') {
        lastFrameRef.current = msg.payload.frameToken
        setPendingTarget(msg.payload)
        setPicking(false)
      }
      if (msg.type === 'PTR_NUDGED') {
        const { elementId, value, target } = msg.payload
        const from =
          target.styles.transform && target.styles.transform !== 'none'
            ? target.styles.transform
            : 'none'
        pushHistory({ frameToken: target.frameToken, elementId, kind: 'style', prop: 'transform', from, to: value })
        upsertEdit(target, 'style', 'transform', from, value)
        if (selection?.elementId === elementId) setDraft((d) => ({ ...d, transform: value }))
      }
      if (msg.type === 'PTR_STYLE_PASTED') {
        const { target, changes } = msg.payload as {
          target: SelectionPayload
          changes: { prop: string; from: string; to: string }[]
        }
        for (const c of changes) {
          pushHistory({ frameToken: target.frameToken, elementId: target.elementId, kind: 'style', prop: c.prop, from: c.from, to: c.to })
          upsertEdit(target, 'style', c.prop, c.from, c.to)
        }
        if (selection?.elementId === target.elementId) {
          setDraft((d) => {
            const next = { ...d }
            for (const c of changes) next[c.prop] = c.to
            return next
          })
        }
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    chrome.storage?.local
      .get('author')
      .then((r) => setAuthor((r.author as string) ?? ''))
      .catch(() => {})
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  async function loadCommentsAndTokens() {
    try {
      const frameToken = lastFrameRef.current ?? undefined
      const c = await sendToPage({ type: 'PTR_GET_COMMENTS', frameToken })
      setComments(c.comments ?? [])
      setCommentsVisible(c.visible ?? true)
      const t = await sendToPage({ type: 'PTR_GET_TOKENS', frameToken })
      const list = t.tokens ?? []
      setTokens(list)
      setTokenDraft((prev) => {
        const d: Record<string, string> = {}
        for (const tok of list) d[tok.name] = prev[tok.name] ?? tok.value
        return d
      })
      setError(null)
    } catch {
      setError(
        'Could not reach the page. Make sure the active tab is a localhost app, then reload it and try again.'
      )
    }
  }

  async function toggleActive(on: boolean) {
    try {
      await sendToPage({ type: 'PTR_SET_ACTIVE', on })
      setActive(on)
      setError(null)
      if (!on) setSelection(null)
    } catch {
      setError(
        'Could not reach the page. Make sure the active tab is a localhost app, then reload it and try again.'
      )
    }
  }

  function pushHistory(op: HistoryOp) {
    historyRef.current = historyRef.current.slice(0, historyIndex)
    historyRef.current.push(op)
    setHistoryIndex(historyRef.current.length)
  }

  function upsertEdit(
    target: SelectionPayload,
    kind: Edit['kind'],
    prop: string,
    from: string,
    to: string,
    detail?: string
  ) {
    setEdits((prev) => {
      const key = target.elementId + '|' + prop
      const existing = prev.find((e) => e.target.elementId + '|' + e.prop === key)
      if (existing) {
        if (existing.from === to) {
          // Back to the original value: the edit disappears.
          return prev.filter((e) => e !== existing)
        }
        return prev.map((e) => (e === existing ? { ...e, to } : e))
      }
      if (from === to) return prev
      return [
        ...prev,
        { id: crypto.randomUUID(), target, kind, prop, from, to, detail },
      ]
    })
  }

  async function applyStyle(prop: string, value: string, record = true) {
    if (!selection) return
    const from = draft[prop] ?? selection.styles[prop]
    setDraft((d) => ({ ...d, [prop]: value }))
    try {
      await sendToPage({
        type: 'PTR_APPLY_STYLE',
        frameToken: selection.frameToken,
        elementId: selection.elementId,
        prop: toKebab(prop),
        value,
      })
    } catch {
      return
    }
    if (record && from !== value) {
      pushHistory({ frameToken: selection.frameToken, elementId: selection.elementId, kind: 'style', prop, from, to: value })
      upsertEdit(selection, 'style', prop, selection.styles[prop], value)
    }
  }

  async function resetStyle(prop: string) {
    if (!selection) return
    const from = draft[prop]
    const original = selection.styles[prop]
    try {
      await sendToPage({
        type: 'PTR_RESET_STYLE',
        frameToken: selection.frameToken,
        elementId: selection.elementId,
        prop: toKebab(prop),
      })
    } catch {
      return
    }
    setDraft((d) => ({ ...d, [prop]: original }))
    pushHistory({ frameToken: selection.frameToken, elementId: selection.elementId, kind: 'style', prop, from, to: original })
    setEdits((prev) =>
      prev.filter(
        (e) => !(e.target.elementId === selection.elementId && e.prop === prop)
      )
    )
  }

  async function applyText() {
    if (!selection) return
    const current =
      edits.find(
        (e) => e.kind === 'text' && e.target.elementId === selection.elementId
      )?.to ?? selection.text
    if (text === current) return
    try {
      await sendToPage({
        type: 'PTR_SET_TEXT',
        frameToken: selection.frameToken,
        elementId: selection.elementId,
        value: text,
      })
    } catch {
      return
    }
    pushHistory({
      frameToken: selection.frameToken,
      elementId: selection.elementId,
      kind: 'text',
      prop: 'text',
      from: current,
      to: text,
    })
    upsertEdit(selection, 'text', 'text', selection.text, text)
  }

  async function resetTextEdit() {
    if (!selection) return
    try {
      await sendToPage({ type: 'PTR_RESET_TEXT', frameToken: selection.frameToken, elementId: selection.elementId })
    } catch {
      return
    }
    pushHistory({
      frameToken: selection.frameToken,
      elementId: selection.elementId,
      kind: 'text',
      prop: 'text',
      from: text,
      to: selection.text,
    })
    setText(selection.text)
    setEdits((prev) =>
      prev.filter(
        (e) => !(e.kind === 'text' && e.target.elementId === selection.elementId)
      )
    )
  }

  // Revert one edit from the Changes tab, regardless of which element is
  // currently selected in the Element tab (unlike resetStyle/resetTextEdit,
  // which only work against the live `selection`).
  async function revertEdit(edit: Edit) {
    try {
      if (edit.kind === 'insert') {
        await sendToPage({
          type: 'PTR_REMOVE_INSERTED',
          frameToken: edit.target.frameToken,
          elementId: edit.target.elementId,
        })
        if (selection?.elementId === edit.target.elementId) setSelection(null)
      } else if (edit.kind === 'move') {
        await sendToPage({
          type: 'PTR_RESET_MOVE',
          frameToken: edit.target.frameToken,
          elementId: edit.target.elementId,
        })
      } else if (edit.kind === 'text') {
        await sendToPage({ type: 'PTR_RESET_TEXT', frameToken: edit.target.frameToken, elementId: edit.target.elementId })
        if (selection?.elementId === edit.target.elementId) setText(edit.from)
      } else {
        await sendToPage({
          type: 'PTR_RESET_STYLE',
          frameToken: edit.target.frameToken,
          elementId: edit.target.elementId,
          prop: toKebab(edit.prop),
        })
        if (selection?.elementId === edit.target.elementId)
          setDraft((d) => ({ ...d, [edit.prop]: edit.from }))
      }
    } catch {
      return
    }
    setEdits((prev) => prev.filter((e) => e.id !== edit.id))
  }

  async function moveSelected(dir: 'prev' | 'next') {
    if (!selection) return
    try {
      const r = await sendToPage({
        type: 'PTR_MOVE_ELEMENT',
        frameToken: selection.frameToken,
        elementId: selection.elementId,
        dir,
      })
      if (!r?.ok) return
      pushHistory({
        frameToken: selection.frameToken,
        elementId: selection.elementId,
        kind: 'move',
        prop: 'order',
        from: String(r.from),
        to: String(r.to),
      })
      upsertEdit(selection, 'move', 'order', String(r.from), String(r.to), r.parentDesc)
    } catch {
      setError('Could not reach the page. Reload the localhost tab and try again.')
    }
  }

  async function deleteSelected() {
    if (!selection) return
    try {
      const r = await sendToPage({
        type: 'PTR_DELETE_ELEMENT',
        frameToken: selection.frameToken,
        elementId: selection.elementId,
      })
      if (!r?.ok) return
      if (r.inserted) {
        setEdits((prev) => prev.filter((e) => e.target.elementId !== selection.elementId))
      } else {
        upsertEdit(selection, 'remove', 'element', 'present', 'removed')
      }
      setSelection(null)
    } catch {
      setError('Could not reach the page. Reload the localhost tab and try again.')
    }
  }

  async function duplicateSelected() {
    if (!selection) return
    try {
      const r = await sendToPage({
        type: 'PTR_DUPLICATE_ELEMENT',
        frameToken: selection.frameToken,
        elementId: selection.elementId,
      })
      if (r?.ok && r.payload) upsertEdit(r.payload, 'insert', 'element', '', r.html, r.parentDesc)
    } catch {
      setError('Could not reach the page. Reload the localhost tab and try again.')
    }
  }

  async function insertNew(kind: 'layout' | 'rect' | 'circle' | 'text', position: 'inside' | 'after') {
    try {
      const r = await sendToPage({
        type: 'PTR_INSERT_ELEMENT',
        frameToken: selection?.frameToken ?? lastFrameRef.current ?? undefined,
        targetId: selection?.elementId ?? null,
        kind,
        position,
      })
      if (!r?.ok || !r.payload) return
      // Inserts are tracked as their own edit kind and reverted from the
      // Changes tab; they deliberately stay out of undo/redo, which would
      // otherwise need to resurrect a destroyed node.
      upsertEdit(r.payload, 'insert', 'element', '', r.html, r.parentDesc)
      setActiveTab('element')
    } catch {
      setError('Could not reach the page. Reload the localhost tab and try again.')
    }
  }

  async function selectComment(id: string | null) {
    setSelectedCommentId(id)
    try {
      await sendToPage({
        type: 'PTR_SELECT_COMMENT',
        frameToken: lastFrameRef.current ?? undefined,
        id,
      })
    } catch {}
  }

  async function goToElement(frameToken: string, elementId: number) {
    try {
      await sendToPage({ type: 'PTR_RESELECT_ID', frameToken, elementId })
      setActiveTab('element')
    } catch {
      setError('Could not reach the page. Reload the localhost tab and try again.')
    }
  }

  // Apply one history op in a given direction and sync panel state.
  async function applyOp(op: HistoryOp, value: string) {
    try {
      if (op.kind === 'move') {
        // Undo/redo of a reorder is just the same step in the other
        // direction — derived from whether we're heading back to `from`.
        const undoing = value === op.from
        const wentForward = Number(op.to) > Number(op.from)
        const dir = undoing === wentForward ? 'prev' : 'next'
        await sendToPage({
          type: 'PTR_MOVE_ELEMENT',
          frameToken: op.frameToken,
          elementId: op.elementId,
          dir,
        })
      } else if (op.kind === 'text') {
        await sendToPage({ type: 'PTR_SET_TEXT', frameToken: op.frameToken, elementId: op.elementId, value })
        if (selection?.elementId === op.elementId) setText(value)
      } else {
        await sendToPage({
          type: 'PTR_APPLY_STYLE',
          frameToken: op.frameToken,
          elementId: op.elementId,
          prop: toKebab(op.prop),
          value,
        })
        if (selection?.elementId === op.elementId)
          setDraft((d) => ({ ...d, [op.prop]: value }))
      }
    } catch {
      return
    }
    setEdits((prev) => {
      const existing = prev.find(
        (e) => e.target.elementId === op.elementId && e.prop === op.prop
      )
      if (existing) {
        if (existing.from === value) return prev.filter((e) => e !== existing)
        return prev.map((e) => (e === existing ? { ...e, to: value } : e))
      }
      return prev
    })
  }

  async function undo() {
    if (historyIndex === 0) return
    const op = historyRef.current[historyIndex - 1]
    await applyOp(op, op.from)
    setHistoryIndex(historyIndex - 1)
  }

  async function redo() {
    if (historyIndex >= historyRef.current.length) return
    const op = historyRef.current[historyIndex]
    await applyOp(op, op.to)
    setHistoryIndex(historyIndex + 1)
  }

  async function clearAll() {
    try {
      await sendToPage({ type: 'PTR_RESET_ALL' })
    } catch {
      return
    }
    setEdits([])
    setTokenEdits([])
    setTokenDraft(() => {
      const d: Record<string, string> = {}
      for (const t of tokens) d[t.name] = t.value
      return d
    })
    historyRef.current = []
    setHistoryIndex(0)
    if (selection) {
      setDraft({ ...selection.styles })
      setText(selection.text)
    }
  }

  // Above this, the prompt is unwieldy to review before sending — offer a
  // file instead of a giant clipboard blob. Not a hard OS/clipboard limit.
  const PROMPT_DOWNLOAD_THRESHOLD = 20_000

  async function copyForFigma() {
    if (!selection) return
    try {
      const r = await sendToPage({ type: 'PTR_EXPORT_SVG', frameToken: selection.frameToken, elementId: selection.elementId })
      if (!r?.svg) throw new Error('no svg')
      await navigator.clipboard.writeText(r.svg)
      setFigmaCopied(true)
      setTimeout(() => setFigmaCopied(false), 1500)
    } catch {
      setError('Could not export this element. Reload the localhost tab and try again.')
    }
  }

  async function copyPrompt() {
    await navigator.clipboard.writeText(generatePrompt(edits, tokenEdits))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function downloadPrompt() {
    const blob = new Blob([generatePrompt(edits, tokenEdits)], {
      type: 'text/markdown',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pointer-changes.md'
    a.click()
    URL.revokeObjectURL(url)
  }

  // ----- comments -----

  async function startPicking() {
    try {
      await sendToPage({ type: 'PTR_COMMENT_MODE', on: true })
      setPicking(true)
      setPendingTarget(null)
    } catch {
      setError('Could not reach the page. Reload the localhost tab and try again.')
    }
  }

  async function saveComment() {
    if (!pendingTarget || !newCommentText.trim()) return
    const comment: PointerComment = {
      id: pendingTarget.id,
      selector: pendingTarget.selector,
      descriptor: pendingTarget.descriptor,
      text: newCommentText.trim(),
      author: author.trim() || 'anonymous',
      createdAt: Date.now(),
    }
    try {
      const r = await sendToPage({ type: 'PTR_ADD_COMMENT', frameToken: pendingTarget.frameToken, comment })
      setComments(r.comments ?? [])
    } catch {
      return
    }
    chrome.storage?.local.set({ author: author.trim() })
    setPendingTarget(null)
    setNewCommentText('')
  }

  async function deleteComment(id: string) {
    try {
      const r = await sendToPage({ type: 'PTR_DELETE_COMMENT', frameToken: lastFrameRef.current ?? undefined, id })
      setComments(r.comments ?? [])
      if (selectedCommentId === id) setSelectedCommentId(null)
    } catch {}
  }

  async function closePointer() {
    try {
      await sendToPage({ type: 'PTR_SET_ACTIVE', on: false })
    } catch {}
    window.close()
  }

  async function toggleCommentsVisible(on: boolean) {
    setCommentsVisible(on)
    try {
      await sendToPage({ type: 'PTR_SHOW_COMMENTS', on })
    } catch {}
  }

  // ----- design tokens -----

  async function applyToken(name: string, value: string) {
    const original = tokens.find((t) => t.name === name)?.value ?? ''
    setTokenDraft((d) => ({ ...d, [name]: value }))
    try {
      await sendToPage({ type: 'PTR_SET_TOKEN', frameToken: lastFrameRef.current ?? undefined, name, value })
    } catch {
      return
    }
    setTokenEdits((prev) => {
      const existing = prev.find((t) => t.name === name)
      if (existing) {
        if (existing.from === value) return prev.filter((t) => t !== existing)
        return prev.map((t) => (t === existing ? { ...t, to: value } : t))
      }
      if (original === value) return prev
      return [...prev, { name, from: original, to: value }]
    })
  }

  async function resetTokenEdit(name: string) {
    const original = tokens.find((t) => t.name === name)?.value ?? ''
    try {
      await sendToPage({ type: 'PTR_RESET_TOKEN', frameToken: lastFrameRef.current ?? undefined, name })
    } catch {
      return
    }
    setTokenDraft((d) => ({ ...d, [name]: original }))
    setTokenEdits((prev) => prev.filter((t) => t.name !== name))
  }

  const promptLength = generatePrompt(edits, tokenEdits).length

  const isEdited = (prop: string) =>
    !!selection &&
    edits.some((e) => e.target.elementId === selection.elementId && e.prop === prop)

  const textEdited = isEdited('text')

  function renderField(f: StyleField) {
    const edited = isEdited(f.prop)
    const value = draft[f.prop] ?? ''
    return (
      <div key={f.prop} className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-muted-foreground">{f.label}</Label>
          {edited && (
            <Button
              variant="ghost"
              size="icon"
              className="size-5"
              title="Reset this change"
              onClick={() => resetStyle(f.prop)}
            >
              <RotateCcw className="size-3" />
            </Button>
          )}
        </div>
        {f.type === 'color' ? (
          <ColorField
            value={value}
            format={colorFormat}
            edited={edited}
            onChange={(v) => applyStyle(f.prop, v)}
          />
        ) : f.type === 'select' ? (
          <Select value={value} onValueChange={(v) => applyStyle(f.prop, v)}>
            <SelectTrigger
              className={
                'h-8 w-full font-mono text-xs' +
                (edited ? ' border-primary bg-primary/5' : '')
              }
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Current computed value may not be in the preset list (e.g. "24px"). */}
              {value && !f.options!.includes(value) && (
                <SelectItem value={value} className="font-mono text-xs">
                  {value}
                </SelectItem>
              )}
              {f.options!.map((o) => (
                <SelectItem key={o} value={o} className="font-mono text-xs">
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : f.type === 'unit' ? (
          (() => {
            // A keyword like letter-spacing's "normal" means zero, so show a
            // numeric control seeded at 0 instead of dropping to free text.
            const parsed =
              f.zeroKeyword && value.trim() === f.zeroKeyword
                ? { num: '0', unit: 'px' }
                : parseUnit(value)
            // Anything else we can't split into number+unit stays free text.
            if (!parsed)
              return (
                <Input
                  value={value}
                  onChange={(e) => applyStyle(f.prop, e.target.value)}
                  className={
                    'h-8 font-mono text-xs' +
                    (edited ? ' border-primary bg-primary/5' : '')
                  }
                />
              )
            return (
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  step="any"
                  value={parsed.num}
                  onChange={(e) => {
                    const n = e.target.value
                    if (n !== '' && !Number.isNaN(Number(n)))
                      applyStyle(f.prop, `${n}${parsed.unit}`)
                  }}
                  className={
                    'h-8 min-w-0 flex-1 font-mono text-xs' +
                    (edited ? ' border-primary bg-primary/5' : '')
                  }
                />
                <Select
                  value={parsed.unit}
                  onValueChange={(u) => applyStyle(f.prop, `${parsed.num}${u}`)}
                >
                  <SelectTrigger className="h-8 w-[64px] shrink-0 px-2 font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UNITS.map((u) => (
                      <SelectItem key={u} value={u} className="font-mono text-xs">
                        {u}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          })()
        ) : (
          <Input
            value={value}
            onChange={(e) => applyStyle(f.prop, e.target.value)}
            className={
              'h-8 font-mono text-xs' +
              (edited ? ' border-primary bg-primary/5' : '')
            }
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex h-screen w-full flex-col overflow-x-hidden bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="inspect" className="text-xs text-muted-foreground">
            Inspect
          </Label>
          <Switch id="inspect" checked={active} onCheckedChange={toggleActive} />
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="Undo"
            disabled={historyIndex === 0}
            onClick={undo}
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="Redo"
            disabled={historyIndex >= historyRef.current.length}
            onClick={redo}
          >
            <Redo2 className="size-4" />
          </Button>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" title="Settings">
                <Settings className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 space-y-4">
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Your name</Label>
                <Input
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  onBlur={() => chrome.storage?.local.set({ author: author.trim() })}
                  placeholder="e.g. Kevin"
                  className="h-8 text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  Shown as the author on comments you add.
                </p>
              </div>
              <Separator />
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Color format</Label>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant={colorFormat === 'hex' ? 'default' : 'outline'}
                    className="h-7 flex-1 text-xs"
                    onClick={() => setColorFormat('hex')}
                  >
                    Hex
                  </Button>
                  <Button
                    size="sm"
                    variant={colorFormat === 'rgb' ? 'default' : 'outline'}
                    className="h-7 flex-1 text-xs"
                    onClick={() => setColorFormat('rgb')}
                  >
                    RGB
                  </Button>
                </div>
              </div>
              <Separator />
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full">
                    <Keyboard className="size-3.5" />
                    Keyboard shortcuts
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[80vh] w-[calc(100vw-16px)] max-w-[calc(100vw-16px)] overflow-x-hidden overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Keyboard shortcuts</DialogTitle>
                  </DialogHeader>
                  <ShortcutsList />
                </DialogContent>
              </Dialog>
              <Separator />
              <Button variant="destructive" size="sm" className="w-full" onClick={closePointer}>
                <X className="size-4" />
                Close Pointer
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      </header>

      {error && (
        <p className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <Tabs
        value={activeTab}
        className="flex min-h-0 flex-1 flex-col"
        onValueChange={(v) => {
          setActiveTab(v)
          if (v !== 'element') loadCommentsAndTokens()
        }}
      >
        <TabsList
          variant="line"
          className="mx-4 mt-2 h-auto w-auto justify-start gap-2 overflow-x-auto px-0 pt-0 pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <TabsTrigger value="element" className="shrink-0">
            Element
          </TabsTrigger>
          <TabsTrigger value="insert" className="shrink-0">
            Insert
          </TabsTrigger>
          <TabsTrigger value="changes" className="shrink-0">
            Changes
            {edits.length + tokenEdits.length > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {edits.length + tokenEdits.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="comments" className="shrink-0">
            Comments
            {comments.length > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {comments.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="tokens" className="shrink-0">
            Tokens
          </TabsTrigger>
        </TabsList>

      <TabsContent value="element" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            {!selection ? (
              <p className="pt-8 text-center text-sm text-muted-foreground">
                {active
                  ? 'Click an element on the page to select it. If elements overlap, right-click the same spot repeatedly to cycle through them.'
                  : 'Turn on Inspect, then click an element on your localhost app.'}
              </p>
            ) : (
              <>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="font-mono text-sm">
                      &lt;{selection.tag}&gt;
                      {selection.id ? `#${selection.id}` : ''}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    {selection.componentChain.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {selection.componentChain.map((c) => (
                          <Badge key={c} variant="outline">
                            {c}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {selection.source ? (
                      <p className="font-mono text-muted-foreground break-all">
                        {selection.source.fileName.split('/').slice(-2).join('/')}:
                        {selection.source.lineNumber}
                      </p>
                    ) : (
                      <p className="text-muted-foreground">
                        No source info — will reference by selector.
                      </p>
                    )}
                    {selection.classes.length > 0 && (
                      <p className="font-mono text-muted-foreground break-all">
                        .{selection.classes.slice(0, 6).join(' .')}
                      </p>
                    )}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[11px] text-muted-foreground">
                          Order among siblings
                        </Label>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {selection.index + 1} of {selection.siblingCount}
                        </span>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1"
                          disabled={selection.index === 0}
                          onClick={() => moveSelected('prev')}
                        >
                          <ChevronLeft className="size-3.5" />
                          Earlier
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1"
                          disabled={selection.index >= selection.siblingCount - 1}
                          onClick={() => moveSelected('next')}
                        >
                          Later
                          <ChevronRight className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={duplicateSelected}
                      >
                        <CopyPlus className="size-3.5" />
                        Duplicate
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 text-destructive hover:text-destructive"
                        onClick={deleteSelected}
                      >
                        <Trash2 className="size-3.5" />
                        Delete
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={copyForFigma}
                    >
                      {figmaCopied ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Layers className="size-3.5" />
                      )}
                      {figmaCopied ? 'Copied — paste in Figma' : 'Copy for Figma'}
                    </Button>
                  </CardContent>
                </Card>

                {selection.text && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Text</Label>
                      {textEdited && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-5"
                          title="Reset this change"
                          onClick={resetTextEdit}
                        >
                          <RotateCcw className="size-3" />
                        </Button>
                      )}
                    </div>
                    <Textarea
                      value={text}
                      onChange={(e) => {
                        const v = e.target.value
                        setText(v)
                        // Live preview on every keystroke; the change is
                        // committed to history/prompt on blur (applyText).
                        if (selection)
                          sendToPage({
                            type: 'PTR_SET_TEXT',
                            frameToken: selection.frameToken,
                            elementId: selection.elementId,
                            value: v,
                          }).catch(() => {})
                      }}
                      onBlur={applyText}
                      rows={2}
                      className={
                        'text-sm' +
                        (textEdited ? ' border-primary bg-primary/5' : '')
                      }
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <Separator />
                  <p className="text-xs font-medium text-muted-foreground">
                    Layout of this container
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Controls how this element arranges its children — use it to try a row, a
                    column, or a wrapped grid.
                  </p>

                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Arrangement</Label>
                    <div className="grid grid-cols-3 gap-1">
                      {(
                        [
                          { label: 'Row', display: 'flex', dir: 'row', wrap: 'nowrap' },
                          { label: 'Column', display: 'flex', dir: 'column', wrap: 'nowrap' },
                          { label: 'Wrap', display: 'flex', dir: 'row', wrap: 'wrap' },
                        ] as const
                      ).map((opt) => {
                        const isActive =
                          draft.display?.includes('flex') &&
                          draft.flexDirection === opt.dir &&
                          (opt.wrap === 'wrap'
                            ? draft.flexWrap === 'wrap'
                            : draft.flexWrap !== 'wrap')
                        return (
                          <Button
                            key={opt.label}
                            size="sm"
                            variant={isActive ? 'default' : 'outline'}
                            className="h-7 text-xs"
                            onClick={() => {
                              applyStyle('display', opt.display)
                              applyStyle('flexDirection', opt.dir)
                              applyStyle('flexWrap', opt.wrap)
                            }}
                          >
                            {opt.label}
                          </Button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">
                      Grid columns — split children into rows
                    </Label>
                    <div className="grid grid-cols-6 gap-1">
                      {[1, 2, 3, 4, 5, 6].map((n) => {
                        const isActive =
                          draft.display?.includes('grid') &&
                          (draft.gridTemplateColumns ?? '').split(' ').length === n
                        return (
                          <Button
                            key={n}
                            size="sm"
                            variant={isActive ? 'default' : 'outline'}
                            className="h-7 px-0 text-xs"
                            onClick={() => {
                              applyStyle('display', 'grid')
                              applyStyle('gridTemplateColumns', `repeat(${n}, minmax(0, 1fr))`)
                            }}
                          >
                            {n}
                          </Button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    {renderField({
                      prop: 'justifyContent',
                      label: 'Justify',
                      type: 'select',
                      options: [
                        'flex-start',
                        'center',
                        'flex-end',
                        'space-between',
                        'space-around',
                        'space-evenly',
                      ],
                    })}
                    {renderField({
                      prop: 'alignItems',
                      label: 'Align',
                      type: 'select',
                      options: ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'],
                    })}
                  </div>
                </div>

                {GROUPS.map((group) => (
                  <div key={group.title} className="space-y-2">
                    <Separator />
                    <p className="text-xs font-medium text-muted-foreground">
                      {group.title}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {group.fields.map(renderField)}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="insert" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {selection
                  ? 'New elements are added inside the selected element, or right after it.'
                  : 'Nothing selected — new elements will be added at the end of the page. Select an element first to place them precisely.'}
              </p>
              {selection && (
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {selection.componentChain[0] ?? `<${selection.tag}>`}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-[11px] text-muted-foreground">Add</Label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { kind: 'layout', label: 'Layout', icon: Rows3 },
                    { kind: 'rect', label: 'Rectangle', icon: Square },
                    { kind: 'circle', label: 'Circle', icon: Circle },
                    { kind: 'text', label: 'Text', icon: Type },
                  ] as const
                ).map((item) => (
                  <div key={item.kind} className="space-y-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => insertNew(item.kind, 'inside')}
                    >
                      <item.icon className="size-3.5" />
                      {item.label}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-full text-[11px] text-muted-foreground"
                      disabled={!selection}
                      onClick={() => insertNew(item.kind, 'after')}
                    >
                      after selection
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Added elements are real, selectable elements — style them in the Element tab, then
              send everything to Claude with Copy prompt.
            </p>
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="changes" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-3 p-4">
            {edits.length === 0 && tokenEdits.length === 0 ? (
              <p className="pt-6 text-center text-sm text-muted-foreground">
                No changes yet. Edits you make in the Element and Tokens tabs
                show up here, grouped by element.
              </p>
            ) : (
              <>
                {Object.entries(
                  edits.reduce<Record<string, Edit[]>>((groups, e) => {
                    const key = String(e.target.elementId)
                    ;(groups[key] ??= []).push(e)
                    return groups
                  }, {})
                ).map(([elementId, group]) => (
                  <Card key={elementId}>
                    <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="font-mono text-xs">
                        {group[0].target.componentChain[0] ??
                          `<${group[0].target.tag}>`}
                      </CardTitle>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        title="Go to this element"
                        onClick={() => goToElement(group[0].target.frameToken, group[0].target.elementId)}
                      >
                        <ArrowRight className="size-3.5" />
                      </Button>
                    </CardHeader>
                    <CardContent className="space-y-1.5 p-3 pt-0">
                      {group.map((e) => (
                        <div key={e.id} className="flex items-center justify-between gap-2 text-xs">
                          <p className="min-w-0 truncate text-muted-foreground">
                            {e.kind === 'insert' ? (
                              <span className="font-medium text-foreground">
                                added new element
                              </span>
                            ) : e.kind === 'remove' ? (
                              <span className="font-medium text-destructive">
                                removed element
                              </span>
                            ) : e.kind === 'move' ? (
                              <>
                                order:{' '}
                                <span className="line-through">{e.from}</span> →{' '}
                                <span className="font-medium text-foreground">{e.to}</span>
                              </>
                            ) : (
                              <>
                                {e.kind === 'text' ? 'text' : e.prop}:{' '}
                                <span className="line-through">{e.from}</span> →{' '}
                                <span className="font-medium text-foreground">{e.to}</span>
                              </>
                            )}
                          </p>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-5 shrink-0"
                            title="Revert this change"
                            onClick={() => revertEdit(e)}
                          >
                            <RotateCcw className="size-3" />
                          </Button>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ))}

                {tokenEdits.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="font-mono text-xs">Design tokens</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1.5 p-3 pt-0">
                      {tokenEdits.map((t) => (
                        <div key={t.name} className="flex items-center justify-between gap-2 text-xs">
                          <p className="min-w-0 truncate text-muted-foreground">
                            {t.name}: <span className="line-through">{t.from}</span> →{' '}
                            <span className="font-medium text-foreground">{t.to}</span>
                          </p>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-5 shrink-0"
                            title="Revert this change"
                            onClick={() => resetTokenEdit(t.name)}
                          >
                            <RotateCcw className="size-3" />
                          </Button>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="comments" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label htmlFor="show-comments" className="text-xs text-muted-foreground">
                  Show pins
                </Label>
                <Switch
                  id="show-comments"
                  checked={commentsVisible}
                  onCheckedChange={toggleCommentsVisible}
                />
              </div>
              <Button size="sm" onClick={startPicking} disabled={picking}>
                <MessageSquarePlus className="size-4" />
                {picking ? 'Click an element…' : 'Add comment'}
              </Button>
            </div>

            {pendingTarget && (
              <Card>
                <CardContent className="space-y-2 p-3">
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {pendingTarget.descriptor}
                  </p>
                  <Textarea
                    autoFocus
                    value={newCommentText}
                    onChange={(e) => setNewCommentText(e.target.value)}
                    placeholder="Write your comment…"
                    rows={2}
                    className="text-sm"
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPendingTarget(null)
                        setNewCommentText('')
                      }}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={saveComment} disabled={!newCommentText.trim()}>
                      Save
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {comments.length === 0 && !pendingTarget ? (
              <p className="pt-6 text-center text-sm text-muted-foreground">
                No comments on this page yet.
              </p>
            ) : (
              comments.map((c, i) => (
                <Card
                  key={c.id}
                  ref={(node) => {
                    // Bring the pin's comment into view when a pin was clicked
                    // on the page rather than here in the list.
                    if (node && c.id === selectedCommentId)
                      node.scrollIntoView({ block: 'nearest' })
                  }}
                  className={
                    'cursor-pointer' +
                    (c.id === selectedCommentId ? ' border-primary bg-primary/5' : '')
                  }
                  onClick={() => selectComment(c.id)}
                >
                  <CardContent className="flex items-start justify-between gap-2 p-3">
                    <div className="min-w-0 flex-1 space-y-1 text-xs">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Badge
                          variant={c.id === selectedCommentId ? 'default' : 'secondary'}
                          className="shrink-0"
                        >
                          {i + 1}
                        </Badge>
                        <span className="shrink-0 font-medium">{c.author}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {new Date(c.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="break-words">{c.text}</p>
                      <p className="truncate font-mono text-muted-foreground">
                        {c.descriptor}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteComment(c.id)
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="tokens" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            {tokens.length === 0 ? (
              <p className="pt-6 text-center text-sm text-muted-foreground">
                No CSS variables found on :root of this page.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    {tokens.length} tokens
                  </p>
                  <div className="flex items-center gap-2">
                    <Label htmlFor="adv-tokens" className="text-[11px] text-muted-foreground">
                      Show names
                    </Label>
                    <Switch
                      id="adv-tokens"
                      checked={advancedTokens}
                      onCheckedChange={setAdvancedTokens}
                    />
                  </div>
                </div>

                {groupTokens(tokens).map((group) => (
                  <div key={group.title} className="space-y-2">
                    <Separator />
                    <p className="text-xs font-medium text-muted-foreground">{group.title}</p>

                    {group.title === 'Colors' ? (
                      <div className="grid grid-cols-2 gap-2">
                        {group.items.map((t) => {
                          const value = tokenDraft[t.name] ?? t.value
                          const edited = tokenEdits.some((e) => e.name === t.name)
                          return (
                            <div
                              key={t.name}
                              className={
                                'flex items-center gap-2 rounded-md border p-1.5' +
                                (edited ? ' border-primary bg-primary/5' : '')
                              }
                            >
                              <div
                                className="relative size-8 shrink-0 overflow-hidden rounded border"
                                style={{ background: CHECKER }}
                              >
                                <div className="absolute inset-0" style={{ background: value }} />
                                <input
                                  type="color"
                                  value={swatchHex(value)}
                                  onChange={(e) => applyToken(t.name, e.target.value)}
                                  className="absolute inset-0 cursor-pointer opacity-0"
                                />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-medium">
                                  {advancedTokens ? t.name : tokenLabel(t.name)}
                                </p>
                                <p className="truncate font-mono text-[10px] text-muted-foreground">
                                  {value}
                                </p>
                              </div>
                              {edited && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-5 shrink-0"
                                  title="Reset this change"
                                  onClick={() => resetTokenEdit(t.name)}
                                >
                                  <RotateCcw className="size-3" />
                                </Button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      group.items.map((t) => {
                        const value = tokenDraft[t.name] ?? t.value
                        const edited = tokenEdits.some((e) => e.name === t.name)
                        const parsed = parseUnit(value)
                        return (
                          <div key={t.name} className="space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <Label className="min-w-0 truncate text-[11px] text-muted-foreground">
                                {advancedTokens ? t.name : tokenLabel(t.name)}
                              </Label>
                              {edited && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-5 shrink-0"
                                  title="Reset this change"
                                  onClick={() => resetTokenEdit(t.name)}
                                >
                                  <RotateCcw className="size-3" />
                                </Button>
                              )}
                            </div>
                            {parsed ? (
                              <div className="flex items-center gap-1">
                                <Input
                                  type="number"
                                  step="any"
                                  value={parsed.num}
                                  onChange={(e) => {
                                    const n = e.target.value
                                    if (n !== '' && !Number.isNaN(Number(n)))
                                      applyToken(t.name, `${n}${parsed.unit}`)
                                  }}
                                  className={
                                    'h-8 min-w-0 flex-1 font-mono text-xs' +
                                    (edited ? ' border-primary bg-primary/5' : '')
                                  }
                                />
                                <Select
                                  value={parsed.unit}
                                  onValueChange={(u) => applyToken(t.name, `${parsed.num}${u}`)}
                                >
                                  <SelectTrigger className="h-8 w-[64px] shrink-0 px-2 font-mono text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {UNITS.map((u) => (
                                      <SelectItem key={u} value={u} className="font-mono text-xs">
                                        {u}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            ) : (
                              <Input
                                value={value}
                                onChange={(e) => applyToken(t.name, e.target.value)}
                                className={
                                  'h-8 font-mono text-xs' +
                                  (edited ? ' border-primary bg-primary/5' : '')
                                }
                              />
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </ScrollArea>
      </TabsContent>
      </Tabs>

      <div className="flex items-center gap-2 border-t p-3">
        {promptLength > PROMPT_DOWNLOAD_THRESHOLD ? (
          <Button className="flex-1" disabled={!edits.length && !tokenEdits.length} onClick={downloadPrompt}>
            <Download className="size-4" />
            Download .md
            <Badge variant="secondary" className="ml-1">
              {edits.length + tokenEdits.length}
            </Badge>
          </Button>
        ) : (
          <Button className="flex-1" disabled={!edits.length && !tokenEdits.length} onClick={copyPrompt}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? 'Copied' : 'Copy prompt'}
            {edits.length + tokenEdits.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {edits.length + tokenEdits.length}
              </Badge>
            )}
          </Button>
        )}
        <Button variant="outline" disabled={!edits.length && !tokenEdits.length} onClick={clearAll}>
          Clear all
        </Button>
      </div>
    </div>
  )
}

type ShortcutGroup = { title: string; note?: string; items: { keys: string; desc: string }[] }

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Selecting',
    items: [
      { keys: 'Click', desc: "Select the element under the cursor" },
      {
        keys: 'Right-click (repeat on the same spot)',
        desc: 'Cycle through elements stacked at that point, when one hides another',
      },
      { keys: 'Tab', desc: "Select the current element's parent" },
      { keys: 'Shift + Tab', desc: "Select the current element's first child" },
    ],
  },
  {
    title: 'Measuring',
    note: 'Hold while hovering — works like Figma’s measurement overlays.',
    items: [
      { keys: 'Alt + hover another element', desc: 'Show the gap between it and the current selection' },
      { keys: 'Alt + Shift + hover', desc: "Show the hovered element's padding on all four sides" },
      { keys: 'Alt + Ctrl + hover', desc: 'Show the distance from the hovered element to the viewport edges' },
    ],
  },
  {
    title: 'Editing',
    items: [
      { keys: 'Arrow keys', desc: 'Nudge the selected element 1px' },
      { keys: 'Shift + Arrow keys', desc: 'Nudge the selected element 10px' },
      {
        keys: '[',
        desc: 'Move the selected element earlier among its siblings (left/up in a layout)',
      },
      {
        keys: ']',
        desc: 'Move the selected element later among its siblings (right/down in a layout)',
      },
      { keys: 'Drag', desc: 'Drag the selected element to move it freely' },
      { keys: 'Delete / Backspace', desc: 'Remove the selected element' },
      { keys: 'Cmd/Ctrl + D', desc: 'Duplicate the selected element' },
      { keys: 'C', desc: "Copy the selected element's style" },
      { keys: 'V', desc: 'Paste the copied style onto whatever is hovered' },
    ],
  },
  {
    title: 'Canvas',
    items: [
      { keys: 'H', desc: 'Highlight every other element that shares the same classes as the selection' },
      { keys: '(automatic)', desc: 'Selecting a CSS grid container shows its column/row lines' },
    ],
  },
]

function ShortcutsList() {
  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-muted-foreground">
        These work on the page while <span className="font-medium text-foreground">Inspect</span>{' '}
        is turned on.
      </p>
      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title} className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{group.title}</p>
          {group.note && <p className="text-[11px] text-muted-foreground">{group.note}</p>}
          <div className="space-y-3">
            {group.items.map((item) => (
              <div key={item.keys} className="space-y-1">
                <div>
                  <kbd className="inline-block rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {item.keys}
                  </kbd>
                </div>
                <p className="text-xs break-words text-muted-foreground">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
