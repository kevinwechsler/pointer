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
      { prop: 'letterSpacing', label: 'Letter spacing', type: 'unit' },
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

function rgbToHex(value: string): string {
  const v = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(v)) return v
  const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return '#000000'
  return (
    '#' +
    [m[1], m[2], m[3]]
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')
  )
}

function hexToRgbString(value: string): string {
  const m = value.trim().match(/^#?([0-9a-f]{6})$/i)
  if (!m) return value
  const n = m[1]
  const r = parseInt(n.slice(0, 2), 16)
  const g = parseInt(n.slice(2, 4), 16)
  const b = parseInt(n.slice(4, 6), 16)
  return `rgb(${r}, ${g}, ${b})`
}

type ColorFormat = 'hex' | 'rgb'

function formatColor(value: string, format: ColorFormat): string {
  return format === 'rgb' ? hexToRgbString(rgbToHex(value)) : rgbToHex(value)
}

// One history entry per user action, so it can be undone/redone on the page.
type HistoryOp = {
  elementId: number
  kind: 'style' | 'text'
  prop: string // css prop (camelCase) or 'text'
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
    selector: string
    descriptor: string
  } | null>(null)
  const [newCommentText, setNewCommentText] = useState('')

  // Design tokens
  const [tokens, setTokens] = useState<{ name: string; value: string }[]>([])
  const [tokenDraft, setTokenDraft] = useState<Record<string, string>>({})
  const [tokenEdits, setTokenEdits] = useState<TokenEdit[]>([])

  useEffect(() => {
    const listener = (msg: any) => {
      if (msg.type === 'PTR_SELECTED') {
        setSelection(msg.payload)
        setDraft({ ...msg.payload.styles })
        setText(msg.payload.text)
      }
      if (msg.type === 'PTR_COMMENT_TARGET') {
        setPendingTarget(msg.payload)
        setPicking(false)
      }
      if (msg.type === 'PTR_NUDGED') {
        const { elementId, value, target } = msg.payload
        const from =
          target.styles.transform && target.styles.transform !== 'none'
            ? target.styles.transform
            : 'none'
        pushHistory({ elementId, kind: 'style', prop: 'transform', from, to: value })
        upsertEdit(target, 'style', 'transform', from, value)
        if (selection?.elementId === elementId) setDraft((d) => ({ ...d, transform: value }))
      }
      if (msg.type === 'PTR_STYLE_PASTED') {
        const { target, changes } = msg.payload as {
          target: SelectionPayload
          changes: { prop: string; from: string; to: string }[]
        }
        for (const c of changes) {
          pushHistory({ elementId: target.elementId, kind: 'style', prop: c.prop, from: c.from, to: c.to })
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
      const c = await sendToPage({ type: 'PTR_GET_COMMENTS' })
      setComments(c.comments ?? [])
      setCommentsVisible(c.visible ?? true)
      const t = await sendToPage({ type: 'PTR_GET_TOKENS' })
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

  function upsertEdit(target: SelectionPayload, kind: 'style' | 'text', prop: string, from: string, to: string) {
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
        { id: crypto.randomUUID(), target, kind, prop, from, to },
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
        elementId: selection.elementId,
        prop: toKebab(prop),
        value,
      })
    } catch {
      return
    }
    if (record && from !== value) {
      pushHistory({ elementId: selection.elementId, kind: 'style', prop, from, to: value })
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
        elementId: selection.elementId,
        prop: toKebab(prop),
      })
    } catch {
      return
    }
    setDraft((d) => ({ ...d, [prop]: original }))
    pushHistory({ elementId: selection.elementId, kind: 'style', prop, from, to: original })
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
        elementId: selection.elementId,
        value: text,
      })
    } catch {
      return
    }
    pushHistory({
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
      await sendToPage({ type: 'PTR_RESET_TEXT', elementId: selection.elementId })
    } catch {
      return
    }
    pushHistory({
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
      if (edit.kind === 'text') {
        await sendToPage({ type: 'PTR_RESET_TEXT', elementId: edit.target.elementId })
        if (selection?.elementId === edit.target.elementId) setText(edit.from)
      } else {
        await sendToPage({
          type: 'PTR_RESET_STYLE',
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

  async function goToElement(elementId: number) {
    try {
      await sendToPage({ type: 'PTR_RESELECT_ID', elementId })
      setActiveTab('element')
    } catch {
      setError('Could not reach the page. Reload the localhost tab and try again.')
    }
  }

  // Apply one history op in a given direction and sync panel state.
  async function applyOp(op: HistoryOp, value: string) {
    try {
      if (op.kind === 'text') {
        await sendToPage({ type: 'PTR_SET_TEXT', elementId: op.elementId, value })
        if (selection?.elementId === op.elementId) setText(value)
      } else {
        await sendToPage({
          type: 'PTR_APPLY_STYLE',
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
      const r = await sendToPage({ type: 'PTR_EXPORT_SVG', elementId: selection.elementId })
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
      const r = await sendToPage({ type: 'PTR_ADD_COMMENT', comment })
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
      const r = await sendToPage({ type: 'PTR_DELETE_COMMENT', id })
      setComments(r.comments ?? [])
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

  // Only plain hex/rgb can be previewed in a native <input type="color">;
  // oklch/hsl and other modern syntaxes are edited as text only.
  const isPreviewableColor = (v: string) => /^#|^rgb/.test(v.trim())

  async function applyToken(name: string, value: string) {
    const original = tokens.find((t) => t.name === name)?.value ?? ''
    setTokenDraft((d) => ({ ...d, [name]: value }))
    try {
      await sendToPage({ type: 'PTR_SET_TOKEN', name, value })
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
      await sendToPage({ type: 'PTR_RESET_TOKEN', name })
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
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={rgbToHex(value)}
              onChange={(e) => applyStyle(f.prop, e.target.value)}
              className="size-8 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
            />
            <Input
              value={formatColor(value, colorFormat)}
              onChange={(e) => applyStyle(f.prop, e.target.value)}
              className={
                'h-8 font-mono text-xs' +
                (edited ? ' border-primary bg-primary/5' : '')
              }
            />
          </div>
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
            const parsed = parseUnit(value)
            // Values like "normal" can't be split into number+unit; fall back
            // to a plain text input for those.
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
                        onClick={() => goToElement(group[0].target.elementId)}
                      >
                        <ArrowRight className="size-3.5" />
                      </Button>
                    </CardHeader>
                    <CardContent className="space-y-1.5 p-3 pt-0">
                      {group.map((e) => (
                        <div key={e.id} className="flex items-center justify-between gap-2 text-xs">
                          <p className="min-w-0 truncate text-muted-foreground">
                            {e.kind === 'text' ? 'text' : e.prop}:{' '}
                            <span className="line-through">{e.from}</span> →{' '}
                            <span className="font-medium text-foreground">{e.to}</span>
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
                  className="cursor-pointer"
                  onClick={() =>
                    sendToPage({ type: 'PTR_REVEAL', id: c.id, selector: c.selector }).catch(
                      () => {}
                    )
                  }
                >
                  <CardContent className="flex items-start justify-between gap-2 p-3">
                    <div className="min-w-0 flex-1 space-y-1 text-xs">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Badge variant="secondary" className="shrink-0">
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
          <div className="space-y-2 p-4">
            {tokens.length === 0 ? (
              <p className="pt-6 text-center text-sm text-muted-foreground">
                No CSS variables found on :root of this page.
              </p>
            ) : (
              tokens.map((t) => {
                const value = tokenDraft[t.name] ?? t.value
                const edited = tokenEdits.some((e) => e.name === t.name)
                return (
                  <div key={t.name} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="truncate font-mono text-[11px] text-muted-foreground">
                        {t.name}
                      </Label>
                      {edited && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-5"
                          title="Reset this change"
                          onClick={() => resetTokenEdit(t.name)}
                        >
                          <RotateCcw className="size-3" />
                        </Button>
                      )}
                    </div>
                    {isPreviewableColor(value) ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="color"
                          value={value.startsWith('#') ? value.slice(0, 7) : rgbToHex(value)}
                          onChange={(e) => applyToken(t.name, e.target.value)}
                          className="size-8 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
                        />
                        <Input
                          value={formatColor(value, colorFormat)}
                          onChange={(e) => applyToken(t.name, e.target.value)}
                          className={
                            'h-8 font-mono text-xs' +
                            (edited ? ' border-primary bg-primary/5' : '')
                          }
                        />
                      </div>
                    ) : (
                      (() => {
                        const parsed = parseUnit(value)
                        if (!parsed)
                          return (
                            <Input
                              value={value}
                              onChange={(e) => applyToken(t.name, e.target.value)}
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
                        )
                      })()
                    )}
                  </div>
                )
              })
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
