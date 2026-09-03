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
  MoreHorizontal,
  Image,
  PenTool,
  Frame,
  Diamond,
  ChevronDown,
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
  Plus,
  WrapText,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  ArrowDown,
  LayoutGrid,
  Eye,
  EyeOff,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  type LayerNode,
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

// ---------- Figma-style panel building blocks ----------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 p-4">
      <p className="text-xs font-semibold">{title}</p>
      {children}
    </div>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

/**
 * A number <Input> that stays editable while its text is momentarily
 * invalid (empty, a bare "-") instead of a controlled value snapping back
 * on every keystroke — which made deleting the last digit to retype it
 * impossible, since the input would immediately refill with the old value.
 * Blurring with nothing left types 0, same as retyping mid-edit is free to
 * override before that happens.
 */
function NumericInput({
  value,
  onChange,
  className,
  blank,
  ...rest
}: {
  value: number
  onChange: (n: number) => void
  className?: string
  /** Show empty (so a `placeholder` like "Mixed" reads through) instead of `value`. */
  blank?: boolean
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'>) {
  const [raw, setRaw] = useState(blank ? '' : String(value))
  const focused = useRef(false)
  // A field left blank on purpose (e.g. "Mixed" padding values) shouldn't
  // snap to 0 just for being blurred untouched — only once the user has
  // actually edited it.
  const dirty = useRef(false)

  useEffect(() => {
    if (!focused.current) {
      setRaw(blank ? '' : String(value))
      dirty.current = false
    }
  }, [value, blank])

  return (
    <Input
      type="number"
      step="any"
      value={raw}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => {
        const v = e.target.value
        setRaw(v)
        dirty.current = true
        if (v !== '' && v !== '-' && !Number.isNaN(Number(v))) onChange(Number(v))
      }}
      onBlur={() => {
        focused.current = false
        if (!dirty.current) return
        if (raw === '' || raw === '-' || Number.isNaN(Number(raw))) {
          setRaw('0')
          onChange(0)
        } else {
          setRaw(String(value))
        }
      }}
      className={className}
      {...rest}
    />
  )
}

function NumberField({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string
  value: number
  suffix?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="relative">
        <NumericInput value={value} onChange={onChange} className="h-8 font-mono text-xs" />
        {suffix && (
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-[11px] text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
    </div>
  )
}

/** Two sides at once (Figma's default padding view); shows "mixed" if they differ. */
function PaddingPairField({
  label,
  a,
  b,
  onChange,
}: {
  label: string
  a?: string
  b?: string
  onChange: (v: string) => void
}) {
  const pa = parseUnit(a ?? '')
  const pb = parseUnit(b ?? '')
  const same = pa && pb && pa.num === pb.num && pa.unit === pb.unit
  const unit = pa?.unit ?? 'px'
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="relative">
        <NumericInput
          value={same ? Number(pa!.num) : 0}
          blank={!same}
          placeholder={same ? undefined : 'Mixed'}
          onChange={(n) => onChange(`${n}${unit}`)}
          className="h-8 pr-7 font-mono text-xs"
        />
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-[11px] text-muted-foreground">
          {unit}
        </span>
      </div>
    </div>
  )
}

function OpacityField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const pct = Math.round((parseFloat(value) || 1) * 100)
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">Opacity</Label>
      <div className="relative">
        <NumericInput
          min={0}
          max={100}
          value={pct}
          onChange={(n) => onChange(String(Math.min(100, Math.max(0, n)) / 100))}
          className="h-8 font-mono text-xs"
        />
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-[11px] text-muted-foreground">
          %
        </span>
      </div>
    </div>
  )
}

const INSERT_KINDS = [
  { kind: 'layout', label: 'Auto layout', icon: Rows3 },
  { kind: 'rect', label: 'Rectangle', icon: Square },
  { kind: 'circle', label: 'Ellipse', icon: Circle },
  { kind: 'text', label: 'Text', icon: Type },
] as const

type ApplyFn = (prop: string, value: string) => void

// ---------- Position: align within parent ----------
// Figma's six alignment buttons. Horizontal alignment uses auto margins,
// which work for block children and for items in a horizontal auto layout;
// vertical alignment uses align-self, which works inside any flex container.
const H_ALIGN = [
  {
    label: 'Align left',
    icon: AlignStartVertical,
    isActive: (d: Record<string, string>) =>
      d.marginLeft !== 'auto' && d.marginRight === 'auto',
    apply: (a: ApplyFn) => {
      a('marginLeft', '0px')
      a('marginRight', 'auto')
    },
  },
  {
    label: 'Align horizontal center',
    icon: AlignCenterVertical,
    isActive: (d: Record<string, string>) => d.marginLeft === 'auto' && d.marginRight === 'auto',
    apply: (a: ApplyFn) => {
      a('marginLeft', 'auto')
      a('marginRight', 'auto')
    },
  },
  {
    label: 'Align right',
    icon: AlignEndVertical,
    isActive: (d: Record<string, string>) => d.marginLeft === 'auto' && d.marginRight !== 'auto',
    apply: (a: ApplyFn) => {
      a('marginLeft', 'auto')
      a('marginRight', '0px')
    },
  },
] as const

const V_ALIGN = [
  { label: 'Align top', icon: AlignStartHorizontal, value: 'flex-start' },
  { label: 'Align vertical center', icon: AlignCenterHorizontal, value: 'center' },
  { label: 'Align bottom', icon: AlignEndHorizontal, value: 'flex-end' },
] as const

// ---------- Layout: flow ----------
type Flow = 'vertical' | 'horizontal' | 'wrap' | 'grid' | 'none'

function currentFlow(d: Record<string, string>): Flow {
  if (d.display?.includes('grid')) return 'grid'
  if (!d.display?.includes('flex')) return 'none'
  if (d.flexWrap === 'wrap') return 'wrap'
  return d.flexDirection?.startsWith('column') ? 'vertical' : 'horizontal'
}

const FLOW_OPTIONS: { flow: Flow; label: string; icon: typeof ArrowDown }[] = [
  { flow: 'vertical', label: 'Vertical', icon: ArrowDown },
  { flow: 'horizontal', label: 'Horizontal', icon: ArrowRight },
  { flow: 'wrap', label: 'Wrap', icon: WrapText },
  { flow: 'grid', label: 'Grid', icon: LayoutGrid },
]

function applyFlow(flow: Flow, a: ApplyFn, d: Record<string, string>) {
  switch (flow) {
    case 'vertical':
      a('display', 'flex')
      a('flexDirection', 'column')
      a('flexWrap', 'nowrap')
      break
    case 'horizontal':
      a('display', 'flex')
      a('flexDirection', 'row')
      a('flexWrap', 'nowrap')
      break
    case 'wrap':
      a('display', 'flex')
      a('flexDirection', 'row')
      a('flexWrap', 'wrap')
      break
    case 'grid': {
      a('display', 'grid')
      const cols = trackCount(d.gridTemplateColumns)
      a('gridTemplateColumns', `repeat(${cols || 2}, minmax(0, 1fr))`)
      break
    }
    case 'none':
      a('display', 'block')
  }
}

/** Number of tracks in a resolved grid-template value ("100px 100px" → 2). */
function trackCount(value: string | undefined): number {
  if (!value || value === 'none') return 0
  return value.split(' ').filter(Boolean).length
}

const TYPOGRAPHY_FIELDS: StyleField[] = [
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
  { prop: 'letterSpacing', label: 'Letter spacing', type: 'unit', zeroKeyword: 'normal' },
  {
    prop: 'textAlign',
    label: 'Align',
    type: 'select',
    options: ['left', 'center', 'right', 'justify'],
  },
  {
    prop: 'textTransform',
    label: 'Case',
    type: 'select',
    options: ['none', 'uppercase', 'lowercase', 'capitalize'],
  },
]

// ---------- Layout: dimensions with Hug / Fixed / Fill ----------
type SizeMode = 'fixed' | 'hug' | 'fill'

/** Figma's Hug/Fixed/Fill, read back from the CSS that produces each. */
function currentSizeMode(axis: 'width' | 'height', inline: Record<string, string>): SizeMode {
  const v = (inline[axis] || '').trim()
  if (inline.flexGrow === '1' || inline.alignSelf === 'stretch' || v === '100%') return 'fill'
  if (v === 'fit-content' || v === 'max-content' || v === 'auto') return 'hug'
  if (v) return 'fixed'
  return 'hug'
}

/**
 * One Figma-style dimension control: the value on the left, the sizing
 * mode on the right, in a single field.
 */
function DimensionField({
  axis,
  label,
  selection,
  draft,
  onApply,
}: {
  axis: 'width' | 'height'
  label: string
  selection: SelectionPayload
  draft: Record<string, string>
  onApply: ApplyFn
}) {
  const mode = currentSizeMode(axis, selection.inline)
  const px = axis === 'width' ? selection.rect.width : selection.rect.height
  const shown = Math.round(parseFloat(draft[axis] ?? '') || px)
  return (
    <div className="flex h-8 items-center rounded-md border bg-background pl-2 focus-within:ring-1 focus-within:ring-ring">
      <span className="w-4 font-mono text-[11px] text-muted-foreground">{label}</span>
      <NumericInput
        value={shown}
        disabled={mode !== 'fixed'}
        onChange={(n) => onApply(axis, `${n}px`)}
        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-xs outline-none focus-visible:ring-0 disabled:bg-transparent disabled:text-muted-foreground"
      />
      <Select
        value={mode}
        onValueChange={(m: SizeMode) => {
          if (m === 'hug') {
            onApply(axis, 'fit-content')
            onApply('flexGrow', '0')
            if (axis === 'height') onApply('alignSelf', 'auto')
          } else if (m === 'fill') {
            // Fill along the parent's main axis is flex-grow; across it,
            // it's stretch. We set both so it reads as "fill" either way.
            onApply('flexGrow', '1')
            onApply('alignSelf', 'stretch')
            onApply(axis, 'auto')
          } else {
            onApply('flexGrow', '0')
            onApply('alignSelf', 'auto')
            onApply(axis, `${Math.round(px)}px`)
          }
        }}
      >
        <SelectTrigger className="h-full w-[68px] shrink-0 rounded-l-none border-0 border-l px-2 text-[11px] shadow-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="fixed" className="text-xs">
            Fixed
          </SelectItem>
          <SelectItem value="hug" className="text-xs">
            Hug
          </SelectItem>
          <SelectItem value="fill" className="text-xs">
            Fill
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

/** Figma's 3x3 alignment pad, driving justify-content + align-items. */
function AlignmentGrid({ draft, onApply }: { draft: Record<string, string>; onApply: ApplyFn }) {
  const isColumn = draft.flexDirection?.startsWith('column')
  const values = ['flex-start', 'center', 'flex-end']
  // On a column, the main axis runs vertically, so the pad's rows drive
  // justify-content and its columns drive align-items.
  const rowProp = isColumn ? 'justifyContent' : 'alignItems'
  const colProp = isColumn ? 'alignItems' : 'justifyContent'
  return (
    <div className="grid h-[76px] w-[76px] shrink-0 grid-cols-3 rounded-md border bg-muted/40 p-1">
      {values.map((rowVal) =>
        values.map((colVal) => {
          const isActive = draft[rowProp] === rowVal && draft[colProp] === colVal
          return (
            <button
              key={`${rowVal}-${colVal}`}
              type="button"
              onClick={() => {
                onApply(rowProp, rowVal)
                onApply(colProp, colVal)
              }}
              className="flex items-center justify-center rounded hover:bg-muted"
              title={`${colVal} / ${rowVal}`}
            >
              {isActive ? (
                <span className="flex gap-px">
                  <span className="h-3 w-0.5 rounded-full bg-primary" />
                  <span className="h-4 w-0.5 rounded-full bg-primary" />
                  <span className="h-3 w-0.5 rounded-full bg-primary" />
                </span>
              ) : (
                <span className="size-1 rounded-full bg-muted-foreground/40" />
              )}
            </button>
          )
        })
      )}
    </div>
  )
}

// ---------- Color: Figma-style picker ----------
type HSV = { h: number; s: number; v: number }

function rgbToHsv(r: number, g: number, b: number): HSV {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max ? d / max : 0, v: max }
}

function hsvToRgb({ h, s, v }: HSV): { r: number; g: number; b: number } {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) }
}

type ColorFmt = 'hex' | 'rgb' | 'hsl'

function rgbToHslString(r: number, g: number, b: number): string {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
    else if (max === gn) h = ((bn - rn) / d + 2) * 60
    else h = ((rn - gn) / d + 4) * 60
  }
  return `${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`
}

/** Compose the CSS value Pointer applies: opaque → hex, otherwise rgba(). */
function composeColor(rgb: { r: number; g: number; b: number }, alpha: number): string {
  if (alpha >= 1) return toHex({ ...rgb, alpha: 1, transparent: false, unknown: false })
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Number(alpha.toFixed(3))})`
}

/** Drag-to-pick surface: reports a 0–1 position on pointer down and move. */
function useDragPick(onPick: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null)
  const pick = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    onPick(
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    )
  }
  return {
    ref,
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      pick(e)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (e.buttons & 1) pick(e)
    },
  }
}

function ColorPicker({ value, onChange }: { value: string; onChange: (css: string) => void }) {
  const parsed = parseColor(value)
  const [hsv, setHsv] = useState<HSV>(() =>
    parsed.transparent || parsed.unknown ? { h: 0, s: 0, v: 1 } : rgbToHsv(parsed.r, parsed.g, parsed.b)
  )
  const [alpha, setAlpha] = useState(parsed.transparent ? 1 : parsed.alpha)
  const [fmt, setFmt] = useState<ColorFmt>('hex')
  const [textDraft, setTextDraft] = useState<string | null>(null)

  const rgb = hsvToRgb(hsv)
  const emit = (next: HSV, a: number) => {
    setHsv(next)
    setAlpha(a)
    onChange(composeColor(hsvToRgb(next), a))
  }

  const sv = useDragPick((x, y) => emit({ ...hsv, s: x, v: 1 - y }, alpha))
  const hue = useDragPick((x) => emit({ ...hsv, h: x * 360 }, alpha))
  const al = useDragPick((x) => emit(hsv, Number(x.toFixed(2))))

  const hueCss = `hsl(${hsv.h} 100% 50%)`
  const solid = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
  const textValue =
    textDraft ??
    (fmt === 'hex'
      ? toHex({ ...rgb, alpha: 1, transparent: false, unknown: false }).slice(1).toUpperCase()
      : fmt === 'rgb'
        ? `${rgb.r}, ${rgb.g}, ${rgb.b}`
        : rgbToHslString(rgb.r, rgb.g, rgb.b))

  const commitText = () => {
    if (textDraft == null) return
    const raw = textDraft.trim()
    let css = raw
    if (fmt === 'hex') css = '#' + raw.replace(/^#/, '')
    else if (fmt === 'rgb') css = `rgb(${raw})`
    else css = `hsl(${raw})`
    // Let the browser normalize whatever the user typed.
    const probe = document.createElement('span')
    probe.style.color = css
    if (probe.style.color) {
      document.body.appendChild(probe)
      const c = parseColor(getComputedStyle(probe).color)
      probe.remove()
      if (!c.unknown) emit(rgbToHsv(c.r, c.g, c.b), alpha)
    }
    setTextDraft(null)
  }

  return (
    <div className="w-60 space-y-2">
      <div
        {...sv}
        className="relative h-40 w-full cursor-crosshair touch-none rounded-md"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueCss})`,
        }}
      >
        <span
          className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ring-1 ring-black/30"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: solid }}
        />
      </div>

      <div
        {...hue}
        className="relative h-3 w-full cursor-pointer touch-none rounded-full"
        style={{
          background:
            'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
        }}
      >
        <span
          className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ring-1 ring-black/30"
          style={{ left: `${(hsv.h / 360) * 100}%`, background: hueCss }}
        />
      </div>

      <div
        {...al}
        className="relative h-3 w-full cursor-pointer touch-none rounded-full"
        style={{ background: CHECKER }}
      >
        <div
          className="absolute inset-0 rounded-full"
          style={{ background: `linear-gradient(to right, transparent, ${solid})` }}
        />
        <span
          className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ring-1 ring-black/30"
          style={{ left: `${alpha * 100}%`, background: composeColor(rgb, alpha) }}
        />
      </div>

      <div className="flex items-center gap-1">
        <Select value={fmt} onValueChange={(f: ColorFmt) => { setFmt(f); setTextDraft(null) }}>
          <SelectTrigger className="h-8 w-[64px] shrink-0 px-2 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hex" className="text-xs">Hex</SelectItem>
            <SelectItem value="rgb" className="text-xs">RGB</SelectItem>
            <SelectItem value="hsl" className="text-xs">HSL</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={textValue}
          onChange={(e) => setTextDraft(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => e.key === 'Enter' && commitText()}
          className="h-8 min-w-0 flex-1 font-mono text-xs uppercase"
        />
        <div className="relative w-[58px] shrink-0">
          <NumericInput
            min={0}
            max={100}
            value={Math.round(alpha * 100)}
            onChange={(n) => emit(hsv, Math.min(1, Math.max(0, n / 100)))}
            className="h-8 pr-5 font-mono text-xs"
          />
          <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-[11px] text-muted-foreground">
            %
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Figma's fill/stroke row: swatch (opens the picker), value, opacity, and an
 * eye to toggle the paint off without losing the color.
 */
function ColorRow({
  value,
  edited,
  onChange,
}: {
  value: string
  edited: boolean
  onChange: (v: string) => void
}) {
  const parsed = parseColor(value)
  const lastVisible = useRef<string>('#000000')
  if (!parsed.transparent && !parsed.unknown) lastVisible.current = value
  const visible = !parsed.transparent

  return (
    <div
      className={
        'flex h-8 items-center gap-1.5 rounded-md border bg-background px-1.5' +
        (edited ? ' border-primary bg-primary/5' : '')
      }
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="relative size-5 shrink-0 overflow-hidden rounded-sm border"
            style={{ background: CHECKER }}
            title={visible ? value : 'No color'}
          >
            <span
              className="absolute inset-0"
              style={{ background: visible ? value : 'transparent' }}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="left" className="w-auto p-3">
          <ColorPicker key={visible ? 'on' : 'off'} value={visible ? value : lastVisible.current} onChange={onChange} />
        </PopoverContent>
      </Popover>
      <input
        value={visible ? formatColor(value, 'hex').replace(/^#/, '').toUpperCase() : '—'}
        readOnly={!visible}
        onChange={(e) => {
          const raw = e.target.value.trim()
          if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw)) onChange('#' + raw)
        }}
        className="min-w-0 flex-1 bg-transparent font-mono text-xs uppercase outline-none"
      />
      <NumericInput
        min={0}
        max={100}
        value={visible ? Math.round(parsed.alpha * 100) : 0}
        disabled={!visible}
        onChange={(n) => onChange(composeColor(parsed, Math.min(1, Math.max(0, n / 100))))}
        className="h-auto w-8 border-0 bg-transparent p-0 text-right font-mono text-xs outline-none focus-visible:ring-0 disabled:bg-transparent disabled:text-muted-foreground"
      />
      <span className="text-[11px] text-muted-foreground">%</span>
      <button
        type="button"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title={visible ? 'Hide' : 'Show'}
        onClick={() => onChange(visible ? 'transparent' : lastVisible.current)}
      >
        {visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
      </button>
    </div>
  )
}

/** Compact color control for places that aren't a Fill/Stroke row (text color). */
function ColorField({
  value,
  edited,
  onChange,
}: {
  value: string
  format?: ColorFormat
  edited: boolean
  onChange: (v: string) => void
}) {
  return <ColorRow value={value} edited={edited} onChange={onChange} />
}

// ---------- Layers ----------

/** Ids of every ancestor of `targetId` (root → parent), or null if absent. */
function pathToNode(nodes: LayerNode[], targetId: number, trail: number[] = []): number[] | null {
  for (const n of nodes) {
    if (n.id === targetId) return trail
    const found = pathToNode(n.children, targetId, [...trail, n.id])
    if (found) return found
  }
  return null
}

// Figma's layer-panel icon vocabulary: T for text, a diamond for
// components, shape outlines for leaf shapes, a frame icon for containers.
function LayerIcon({ kind }: { kind: LayerNode['kind'] }) {
  const cls = 'size-3 shrink-0 text-muted-foreground'
  switch (kind) {
    case 'text':
      return <Type className={cls} />
    case 'image':
      return <Image className={cls} />
    case 'vector':
      return <PenTool className={cls} />
    case 'circle':
      return <Circle className={cls} />
    case 'rect':
      return <Square className={cls} />
    case 'component':
      return <Diamond className={cls} />
    case 'frame':
      return <Frame className={cls} />
  }
}

function LayerTree({
  nodes,
  depth,
  expanded,
  selectedId,
  onToggle,
  onSelect,
  onHover,
}: {
  nodes: LayerNode[]
  depth: number
  expanded: Set<number>
  selectedId: number | null
  onToggle: (id: number) => void
  onSelect: (id: number) => void
  onHover: (id: number | null) => void
}) {
  return (
    <>
      {nodes.map((n) => {
        const hasChildren = n.children.length > 0
        const open = expanded.has(n.id)
        const isSelected = n.id === selectedId
        return (
          <div key={n.id}>
            <div
              role="button"
              tabIndex={0}
              ref={(node) => {
                if (node && isSelected) node.scrollIntoView({ block: 'nearest' })
              }}
              onClick={() => onSelect(n.id)}
              onMouseEnter={() => onHover(n.id)}
              onMouseLeave={() => onHover(null)}
              className={
                'flex h-7 cursor-default items-center gap-1 rounded-sm pr-2 text-xs select-none ' +
                (isSelected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted')
              }
              style={{ paddingLeft: 4 + depth * 14 }}
            >
              <button
                type="button"
                className={
                  'flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground ' +
                  (hasChildren ? '' : 'invisible')
                }
                onClick={(e) => {
                  e.stopPropagation()
                  onToggle(n.id)
                }}
              >
                <ChevronRight
                  className={'size-3 transition-transform ' + (open ? 'rotate-90' : '')}
                />
              </button>
              <LayerIcon kind={n.kind} />
              <span className="truncate">{n.name}</span>
              {n.text && (
                <span className="truncate text-muted-foreground">{n.text}</span>
              )}
            </div>
            {hasChildren && open && (
              <LayerTree
                nodes={n.children}
                depth={depth + 1}
                expanded={expanded}
                selectedId={selectedId}
                onToggle={onToggle}
                onSelect={onSelect}
                onHover={onHover}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

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

  // Layers
  const [tree, setTree] = useState<LayerNode[]>([])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const tabsListRef = useRef<HTMLDivElement>(null)
  const tabsDrag = useRef<{ x: number; left: number; moved: boolean } | null>(null)

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
  const [paddingExpanded, setPaddingExpanded] = useState(false)

  // Keep a port open to the background for as long as this panel lives, so
  // it can switch inspect off when the panel closes by any means.
  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'pointer-panel' })
    // Inspect on by default — opening the panel means you're about to
    // inspect something. Silent on failure: the tab may not be a localhost
    // app, and the switch is right there to retry.
    sendToPage({ type: 'PTR_SET_ACTIVE', on: true })
      .then(() => setActive(true))
      .catch(() => {})
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
      if (msg.type === 'PTR_DESELECTED') {
        setSelection(null)
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
        if (selection?.elementId === elementId) setSelection((s) => (s ? { ...s, index: to } : s))
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

  async function loadTree() {
    try {
      const r = await sendToPage({ type: 'PTR_GET_TREE', frameToken: lastFrameRef.current ?? undefined })
      const nodes: LayerNode[] = r.tree ?? []
      setTree(nodes)
      setExpanded((prev) => {
        const next = new Set(prev)
        // First load: open the top level so the tree isn't a single row.
        if (prev.size === 0) nodes.forEach((n) => next.add(n.id))
        if (selection) pathToNode(nodes, selection.elementId)?.forEach((id) => next.add(id))
        return next
      })
    } catch {
      setError('Could not reach the page. Reload the localhost tab and try again.')
    }
  }

  // Keep the selected layer revealed as selection changes on the page.
  useEffect(() => {
    if (activeTab !== 'layers' || !selection) return
    const path = pathToNode(tree, selection.elementId)
    if (path) setExpanded((prev) => new Set([...prev, ...path]))
    else loadTree() // selection isn't in the tree we have (new element, other frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.elementId, activeTab])

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
      // The Back/Forward buttons read selection.index to decide when to
      // disable — without this they'd keep judging by the pre-move
      // position and could stay stuck disabled on the wrong side.
      setSelection((s) => (s ? { ...s, index: r.to } : s))
    } catch {
      setError('Could not reach the page. Reload the localhost tab and try again.')
    }
  }

  // Position and rotation are stored decomposed in the content script; the
  // panel sends only the parts it changed.
  async function setTransformPart(parts: { dx?: number; dy?: number; rotate?: number }) {
    if (!selection) return
    try {
      const r = await sendToPage({
        type: 'PTR_SET_TRANSFORM',
        frameToken: selection.frameToken,
        elementId: selection.elementId,
        parts,
      })
      if (!r?.ok) return
      pushHistory({
        frameToken: selection.frameToken,
        elementId: selection.elementId,
        kind: 'style',
        prop: 'transform',
        from: r.from,
        to: r.to,
      })
      upsertEdit(selection, 'style', 'transform', r.from, r.to)
      setDraft((d) => ({ ...d, transform: r.to }))
      setSelection((s) =>
        s ? { ...s, transform: { ...s.transform, ...parts } } : s
      )
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

  // Matches pressing Escape at the top of the hierarchy on the page — but
  // reachable from the panel itself, since Escape only fires when the page
  // (not the panel) has keyboard focus.
  async function deselect() {
    if (!selection) return
    try {
      await sendToPage({ type: 'PTR_DESELECT', frameToken: selection.frameToken })
    } catch {}
    setSelection(null)
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

  // Copies a design-tree JSON (frames/auto-layout/text, not shapes glued
  // together by SVG coordinates) for the companion Figma plugin — see
  // figma-plugin/ in this repo — to paste with real, editable layers.
  async function copyForFigma() {
    if (!selection) return
    try {
      const r = await sendToPage({
        type: 'PTR_EXPORT_DESIGN',
        frameToken: selection.frameToken,
        elementId: selection.elementId,
      })
      if (!r?.design) throw new Error('no design')
      await navigator.clipboard.writeText(JSON.stringify(r.design))
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
                <NumericInput
                  value={Number(parsed.num)}
                  onChange={(n) => applyStyle(f.prop, `${n}${parsed.unit}`)}
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
                <MoreHorizontal className="size-4" />
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
          if (v === 'layers') loadTree()
        }}
      >
        <TabsList
          ref={tabsListRef}
          variant="line"
          // Gray baseline under every tab so the row reads as continuing past
          // the edge. Drawn at the same offset as the active tab's black
          // indicator (an ::after at bottom:-5px on the trigger); that only
          // lines up if every trigger is the same height, which needs the
          // list's own height to stay a real value (triggers size to
          // `calc(100% - 1px)`) instead of auto.
          className="relative mx-4 mt-2 mb-1.5 w-auto cursor-grab justify-start gap-0 overflow-x-auto px-0 py-0 active:cursor-grabbing [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onPointerDown={(e) => {
            const el = tabsListRef.current
            if (!el) return
            tabsDrag.current = { x: e.clientX, left: el.scrollLeft, moved: false }
          }}
          onPointerMove={(e) => {
            const el = tabsListRef.current
            const d = tabsDrag.current
            if (!el || !d || !(e.buttons & 1)) return
            const dx = e.clientX - d.x
            if (Math.abs(dx) > 4) d.moved = true
            if (d.moved) el.scrollLeft = d.left - dx
          }}
          onPointerUp={() => {
            const d = tabsDrag.current
            tabsDrag.current = null
            // A real drag shouldn't also switch tabs on release.
            if (d?.moved)
              tabsListRef.current?.addEventListener(
                'click',
                (ev) => {
                  ev.stopPropagation()
                  ev.preventDefault()
                },
                { capture: true, once: true }
              )
          }}
        >
          <TabsTrigger value="element" className="shrink-0 px-2">
            Element
          </TabsTrigger>
          <TabsTrigger value="layers" className="shrink-0 px-2">
            Layers
          </TabsTrigger>
          <TabsTrigger value="changes" className="shrink-0 px-2">
            Changes
            {edits.length + tokenEdits.length > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {edits.length + tokenEdits.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="comments" className="shrink-0 px-2">
            Comments
            {comments.length > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {comments.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="tokens" className="shrink-0 px-2">
            Tokens
          </TabsTrigger>
          <div className="pointer-events-none absolute inset-x-0 -bottom-[5px] h-0.5 bg-border" />
        </TabsList>

      <TabsContent value="element" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          {!selection ? (
            <p className="p-4 pt-8 text-center text-sm text-muted-foreground">
              {active
                ? 'Click an element on the page to select it. If elements overlap, right-click the same spot repeatedly to cycle through them.'
                : 'Turn on Inspect, then click an element on your localhost app.'}
            </p>
          ) : (
            <div className="divide-y">
              {/* Identity + actions */}
              <div className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {selection.componentChain[0] ?? `<${selection.tag}>`}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {selection.source
                        ? `${selection.source.fileName.split('/').slice(-2).join('/')}:${selection.source.lineNumber}`
                        : selection.classes.length
                          ? '.' + selection.classes.slice(0, 3).join(' .')
                          : selection.selector}
                    </p>
                  </div>
                  {selection.isNew && (
                    <Badge variant="secondary" className="shrink-0">
                      New
                    </Badge>
                  )}
                </div>

                <div className="flex gap-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" className="flex-1">
                        <Plus className="size-3.5" />
                        Insert
                        <ChevronDown className="size-3.5 text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-52">
                      <DropdownMenuLabel className="text-[11px]">Inside this element</DropdownMenuLabel>
                      {INSERT_KINDS.map((k) => (
                        <DropdownMenuItem key={`in-${k.kind}`} onClick={() => insertNew(k.kind, 'inside')}>
                          <k.icon className="size-3.5" />
                          {k.label}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-[11px]">After this element</DropdownMenuLabel>
                      {INSERT_KINDS.map((k) => (
                        <DropdownMenuItem key={`af-${k.kind}`} onClick={() => insertNew(k.kind, 'after')}>
                          <k.icon className="size-3.5" />
                          {k.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button size="sm" variant="outline" onClick={duplicateSelected} title="Duplicate">
                    <CopyPlus className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    onClick={deleteSelected}
                    title="Delete"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={copyForFigma}
                    title="Copy for the Pointer Figma plugin (see figma-plugin/ in the repo)"
                  >
                    {figmaCopied ? <Check className="size-3.5" /> : <Layers className="size-3.5" />}
                  </Button>
                  <Button size="sm" variant="outline" onClick={deselect} title="Deselect (Esc)">
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>

              {/* Position */}
              <Section title="Position">
                <FieldRow label="Alignment">
                  <div className="flex gap-2">
                    <div className="flex flex-1 gap-0.5 rounded-md border p-0.5">
                      {H_ALIGN.map((opt) => (
                        <Button
                          key={opt.label}
                          size="sm"
                          variant={opt.isActive(draft) ? 'secondary' : 'ghost'}
                          className="h-6 flex-1 px-0"
                          title={opt.label}
                          onClick={() => opt.apply(applyStyle)}
                        >
                          <opt.icon className="size-3.5" />
                        </Button>
                      ))}
                    </div>
                    <div className="flex flex-1 gap-0.5 rounded-md border p-0.5">
                      {V_ALIGN.map((opt) => (
                        <Button
                          key={opt.label}
                          size="sm"
                          variant={draft.alignSelf === opt.value ? 'secondary' : 'ghost'}
                          className="h-6 flex-1 px-0"
                          title={opt.label}
                          onClick={() => applyStyle('alignSelf', opt.value)}
                        >
                          <opt.icon className="size-3.5" />
                        </Button>
                      ))}
                    </div>
                  </div>
                </FieldRow>

                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    label="X"
                    value={selection.rect.left}
                    onChange={(v) =>
                      setTransformPart({ dx: selection.transform.dx + (v - selection.rect.left) })
                    }
                  />
                  <NumberField
                    label="Y"
                    value={selection.rect.top}
                    onChange={(v) =>
                      setTransformPart({ dy: selection.transform.dy + (v - selection.rect.top) })
                    }
                  />
                  <NumberField
                    label="Rotation"
                    suffix="°"
                    value={selection.transform.rotate}
                    onChange={(v) => setTransformPart({ rotate: v })}
                  />
                  <FieldRow label={`Order · ${selection.index + 1} of ${selection.siblingCount}`}>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 flex-1 px-0"
                        title="Send backward"
                        disabled={selection.index === 0}
                        onClick={() => moveSelected('prev')}
                      >
                        <ChevronLeft className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 flex-1 px-0"
                        title="Bring forward"
                        disabled={selection.index >= selection.siblingCount - 1}
                        onClick={() => moveSelected('next')}
                      >
                        <ChevronRight className="size-3.5" />
                      </Button>
                    </div>
                  </FieldRow>
                </div>
              </Section>

              {/* Layout */}
              <Section title="Layout">
                {(() => {
                  const flow = currentFlow(draft)
                  const cols = trackCount(draft.gridTemplateColumns)
                  const rows = trackCount(draft.gridTemplateRows)
                  return (
                    <>
                      <FieldRow label="Flow">
                        <div className="flex gap-2">
                          <div className="flex flex-1 gap-0.5 rounded-md border p-0.5">
                            {FLOW_OPTIONS.map((opt) => (
                              <Button
                                key={opt.flow}
                                size="sm"
                                variant={flow === opt.flow ? 'secondary' : 'ghost'}
                                className="h-6 flex-1 px-0"
                                title={opt.label}
                                onClick={() => applyFlow(opt.flow, applyStyle, draft)}
                              >
                                <opt.icon className="size-3.5" />
                              </Button>
                            ))}
                          </div>
                          {flow !== 'none' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 shrink-0 px-0"
                              title="Remove auto layout"
                              onClick={() => applyFlow('none', applyStyle, draft)}
                            >
                              <X className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      </FieldRow>

                      {flow === 'grid' && (
                        <div className="grid grid-cols-2 gap-2">
                          <NumberField
                            label="Columns"
                            value={cols}
                            onChange={(n) =>
                              applyStyle(
                                'gridTemplateColumns',
                                `repeat(${Math.max(1, Math.round(n))}, minmax(0, 1fr))`
                              )
                            }
                          />
                          <NumberField
                            label="Rows"
                            value={rows}
                            onChange={(n) =>
                              applyStyle(
                                'gridTemplateRows',
                                n >= 1 ? `repeat(${Math.round(n)}, auto)` : 'none'
                              )
                            }
                          />
                        </div>
                      )}

                      <FieldRow label="Dimensions">
                        <div className="grid grid-cols-2 gap-2">
                          <DimensionField
                            axis="width"
                            label="W"
                            selection={selection}
                            draft={draft}
                            onApply={applyStyle}
                          />
                          <DimensionField
                            axis="height"
                            label="H"
                            selection={selection}
                            draft={draft}
                            onApply={applyStyle}
                          />
                        </div>
                      </FieldRow>

                      {flow !== 'none' && (
                        <div className="flex gap-3">
                          {flow !== 'grid' && (
                            <FieldRow label="Alignment">
                              <AlignmentGrid draft={draft} onApply={applyStyle} />
                            </FieldRow>
                          )}
                          <div className="min-w-0 flex-1 space-y-2">
                            {renderField({ prop: 'gap', label: 'Gap', type: 'unit' })}
                          </div>
                        </div>
                      )}

                      <FieldRow label="Padding">
                        {paddingExpanded ? (
                          <div className="grid grid-cols-2 gap-2">
                            {renderField({ prop: 'paddingTop', label: 'Top', type: 'unit' })}
                            {renderField({ prop: 'paddingRight', label: 'Right', type: 'unit' })}
                            {renderField({ prop: 'paddingBottom', label: 'Bottom', type: 'unit' })}
                            {renderField({ prop: 'paddingLeft', label: 'Left', type: 'unit' })}
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-2">
                            <PaddingPairField
                              label="Horizontal"
                              a={draft.paddingLeft}
                              b={draft.paddingRight}
                              onChange={(v) => {
                                applyStyle('paddingLeft', v)
                                applyStyle('paddingRight', v)
                              }}
                            />
                            <PaddingPairField
                              label="Vertical"
                              a={draft.paddingTop}
                              b={draft.paddingBottom}
                              onChange={(v) => {
                                applyStyle('paddingTop', v)
                                applyStyle('paddingBottom', v)
                              }}
                            />
                          </div>
                        )}
                        <button
                          type="button"
                          className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
                          onClick={() => setPaddingExpanded((v) => !v)}
                        >
                          {paddingExpanded ? 'Use horizontal / vertical' : 'Edit each side'}
                        </button>
                      </FieldRow>

                      <label className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={draft.overflow === 'hidden'}
                          onCheckedChange={(c) => applyStyle('overflow', c ? 'hidden' : 'visible')}
                        />
                        Clip content
                      </label>
                    </>
                  )
                })()}
              </Section>

              {/* Appearance */}
              <Section title="Appearance">
                <div className="grid grid-cols-2 gap-2">
                  <OpacityField
                    value={draft.opacity ?? '1'}
                    onChange={(v) => applyStyle('opacity', v)}
                  />
                  {renderField({ prop: 'borderRadius', label: 'Corner radius', type: 'unit' })}
                </div>
              </Section>

              {/* Fill */}
              <Section title="Fill">
                <ColorRow
                  value={draft.backgroundColor ?? ''}
                  edited={isEdited('backgroundColor')}
                  onChange={(v) => applyStyle('backgroundColor', v)}
                />
              </Section>

              {/* Stroke */}
              <Section title="Stroke">
                <ColorRow
                  value={draft.borderColor ?? ''}
                  edited={isEdited('borderColor')}
                  onChange={(v) => {
                    applyStyle('borderColor', v)
                    // A stroke with no style or weight is invisible; give it
                    // sensible defaults the first time a color is chosen.
                    if (draft.borderStyle === 'none') applyStyle('borderStyle', 'solid')
                    if (!parseFloat(draft.borderWidth ?? '0')) applyStyle('borderWidth', '1px')
                  }}
                />
                <div className="grid grid-cols-2 gap-2">
                  {renderField({ prop: 'borderWidth', label: 'Weight', type: 'unit' })}
                  {renderField({
                    prop: 'borderStyle',
                    label: 'Style',
                    type: 'select',
                    options: ['none', 'solid', 'dashed', 'dotted'],
                  })}
                </div>
              </Section>

              {/* Typography */}
              <Section title="Typography">
                {selection.text && (
                  <FieldRow label="Content">
                    <div className="space-y-1">
                      {textEdited && (
                        <div className="flex justify-end">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-5"
                            title="Reset this change"
                            onClick={resetTextEdit}
                          >
                            <RotateCcw className="size-3" />
                          </Button>
                        </div>
                      )}
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
                          'text-sm' + (textEdited ? ' border-primary bg-primary/5' : '')
                        }
                      />
                    </div>
                  </FieldRow>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {TYPOGRAPHY_FIELDS.map(renderField)}
                </div>
                {renderField({ prop: 'color', label: 'Color', type: 'color' })}
              </Section>
            </div>
          )}
        </ScrollArea>
      </TabsContent>

      <TabsContent value="layers" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div
            className="min-h-full p-2"
            // Clicking blank space below/around the rows deselects, like
            // clicking empty canvas in Figma. e.target === e.currentTarget
            // means the click landed on this wrapper directly, not a row.
            onClick={(e) => {
              if (e.target === e.currentTarget) deselect()
            }}
          >
            {tree.length === 0 ? (
              <p className="p-2 pt-8 text-center text-sm text-muted-foreground">
                No layers yet — make sure the tab is a localhost app.
              </p>
            ) : (
              <LayerTree
                nodes={tree}
                depth={0}
                expanded={expanded}
                selectedId={selection?.elementId ?? null}
                onToggle={(id) =>
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(id)) next.delete(id)
                    else next.add(id)
                    return next
                  })
                }
                onSelect={(id) => {
                  // Clicking the already-selected layer toggles it off,
                  // same as clicking empty canvas space in Figma.
                  if (id === selection?.elementId) {
                    deselect()
                    return
                  }
                  sendToPage({
                    type: 'PTR_RESELECT_ID',
                    frameToken: lastFrameRef.current ?? undefined,
                    elementId: id,
                  }).catch(() => {})
                }}
                onHover={(id) =>
                  sendToPage({
                    type: 'PTR_HOVER_ID',
                    frameToken: lastFrameRef.current ?? undefined,
                    elementId: id,
                  }).catch(() => {})
                }
              />
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
                                <NumericInput
                                  value={Number(parsed.num)}
                                  onChange={(n) => applyToken(t.name, `${n}${parsed.unit}`)}
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
    note: 'Matches Figma: Enter dives into a group, Escape steps back out.',
    items: [
      { keys: 'Click', desc: 'Select the element under the cursor' },
      {
        keys: 'Right-click (repeat on the same spot)',
        desc: 'Cycle through elements stacked at that point, when one hides another',
      },
      { keys: 'Return / Enter', desc: "Select the current element's first child" },
      { keys: 'Escape', desc: "Select the parent, or deselect once you're at the top" },
    ],
  },
  {
    title: 'Measuring',
    note: 'Hold while hovering — the same Alt-based measurement Figma uses on its canvas.',
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
      { keys: 'Cmd + [', desc: 'Move the selected element earlier among its siblings' },
      { keys: 'Cmd + ]', desc: 'Move the selected element later among its siblings' },
      { keys: 'Cmd + Shift + [', desc: 'Move it to the very start among its siblings' },
      { keys: 'Cmd + Shift + ]', desc: 'Move it to the very end among its siblings' },
      { keys: 'Drag', desc: 'Drag the selected element to move it freely' },
      { keys: 'Delete / Backspace', desc: 'Remove the selected element' },
      { keys: 'Cmd + D', desc: 'Duplicate the selected element' },
      { keys: 'Cmd + Alt + C', desc: "Copy the selected element's style" },
      { keys: 'Cmd + Alt + V', desc: 'Paste the copied style onto whatever is hovered' },
    ],
  },
  {
    title: 'Canvas',
    note: 'Alt + H, not bare H — H alone is Figma\'s Hand tool.',
    items: [
      { keys: 'Alt + H', desc: 'Highlight every other element that shares the same classes as the selection' },
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
