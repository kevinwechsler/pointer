// Shared types and helpers for the side panel.

export type SourceInfo = { fileName: string; lineNumber: number } | null

export type SelectionPayload = {
  // Identifies which frame (top page or an iframe) owns this element, so
  // follow-up messages route to the right copy of the content script.
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
}

export type Edit = {
  id: string
  target: SelectionPayload
  kind: 'style' | 'text'
  prop: string
  from: string
  to: string
}

export async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id ?? null
}

export async function sendToPage(msg: Record<string, unknown>) {
  const tabId = await activeTabId()
  if (tabId == null) throw new Error('No active tab')
  return chrome.tabs.sendMessage(tabId, msg)
}

function shortFile(fileName: string): string {
  // Trim absolute paths down to something repo-relative and readable.
  const markers = ['/src/', '/app/', '/components/', '/pages/']
  for (const m of markers) {
    const i = fileName.indexOf(m)
    if (i !== -1) return fileName.slice(i + 1)
  }
  return fileName.split('/').slice(-3).join('/')
}

export function describeTarget(t: SelectionPayload): string {
  const parts: string[] = []
  let desc = `\`<${t.tag}>\``
  if (t.id) desc += ` with id \`${t.id}\``
  else if (t.classes.length)
    desc += ` with classes \`${t.classes.slice(0, 4).join(' ')}\``
  parts.push(desc)
  if (t.text) parts.push(`containing the text "${t.text.slice(0, 60)}"`)
  if (t.componentChain.length)
    parts.push(`(rendered by the \`${t.componentChain[0]}\` component)`)
  return parts.join(' ')
}

export type TokenEdit = { name: string; from: string; to: string }

export type PointerComment = {
  id: string
  selector: string
  descriptor: string
  text: string
  author: string
  createdAt: number
}

export function generatePrompt(edits: Edit[], tokenEdits: TokenEdit[] = []): string {
  if (!edits.length && !tokenEdits.length) return ''
  if (!edits.length) {
    const lines = [
      'Apply the following design token changes I made while inspecting the running app:',
      '',
    ]
    tokenEdits.forEach((t, i) => {
      lines.push(
        `${i + 1}. Change the CSS variable \`${t.name}\` from \`${t.from}\` to \`${t.to}\` where it is defined (e.g. :root).`
      )
    })
    return lines.join('\n')
  }
  const lines: string[] = [
    'Apply the following visual changes I made while inspecting the running app:',
    '',
  ]
  edits.forEach((e, i) => {
    const t = e.target
    const loc = t.source
      ? `in \`${shortFile(t.source.fileName)}:${t.source.lineNumber}\``
      : `selector: \`${t.selector}\``
    lines.push(`${i + 1}. Element: ${describeTarget(t)} — ${loc}`)
    if (e.kind === 'text') {
      lines.push(`   Change the text from "${e.from}" to "${e.to}".`)
    } else {
      lines.push(`   Change \`${e.prop}\` from \`${e.from}\` to \`${e.to}\`.`)
    }
    lines.push('')
  })
  if (tokenEdits.length) {
    lines.push('Design token changes:')
    tokenEdits.forEach((t) => {
      lines.push(
        `- Change the CSS variable \`${t.name}\` from \`${t.from}\` to \`${t.to}\` where it is defined (e.g. :root).`
      )
    })
    lines.push('')
  }
  lines.push(
    'Notes: these values come from live computed styles. If the project uses Tailwind or design tokens, translate the raw values to the closest existing token/class instead of hardcoding them.'
  )
  return lines.join('\n')
}
