// The raw command of a permission card in a region of at most MAX_ROWS rows, scrolled by keys or the bar.
// A surface module (`Client`): it draws only Text, every character of what the hooks module handed it,
// already passed through visible(). Nothing is cut: each row is a slice of the text, and every slice is
// reachable by scrolling.
import type { ClientModule } from 'claude-code'

export type Piece = { text: string; tone?: 'label' | 'field'; isBlock?: boolean }
export type Row = { text: string; tone?: 'label' | 'field'; isBlock?: boolean; isCont?: boolean }
export type ScrollProps = { pieces: Piece[]; maxRows: number; columns: number; hint: string }
type State = { offset: number; isDragging?: boolean }

// Cells a character may take: wide East Asian letters and emoji two, a tab up to a tab stop. Overcounting
// only wraps a row early; undercounting would let the surface wrap it again, taller but still whole.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
const cellsOf = (ch: string): number => (ch === '\t' ? 8 : WIDE.test(ch) ? 2 : 1)

/** The pieces as rows at most `width` cells wide; a row that continues the line before is `isCont`. */
export const rowsOf = (pieces: Piece[], width: number): Row[] => {
  const rows: Row[] = []
  for (const p of pieces) {
    const w = Math.max(8, width - (p.isBlock ? 2 : 0))
    const base = { ...(p.tone ? { tone: p.tone } : {}), ...(p.isBlock ? { isBlock: true } : {}) }
    for (const line of p.text.split('\n')) {
      let cur = ''
      let used = 0
      let isCont = false
      for (const ch of line) {
        const c = cellsOf(ch)
        if (cur && used + c > w) {
          rows.push({ ...base, text: cur, ...(isCont ? { isCont: true } : {}) })
          cur = ''
          used = 0
          isCont = true
        }
        cur += ch
        used += c
      }
      rows.push({ ...base, text: cur, ...(isCont ? { isCont: true } : {}) })
    }
  }
  return rows
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

const Scroll: ClientModule<ScrollProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const max = Math.max(1, props.maxRows)
  const columns = surface.columns || props.columns
  // One column for the bar, one between it and the text.
  const rows = rowsOf(props.pieces, columns - 2)
  const isOver = rows.length > max
  const top = rows.length - max
  const offset = isOver ? clamp(surface.state?.offset ?? 0, 0, top) : 0
  const go = (to: number, isDragging = surface.state?.isDragging) => surface.setState({ offset: clamp(Math.round(to), 0, Math.max(0, top)), ...(isDragging ? { isDragging } : {}) })
  const at = () => clamp(surface.state?.offset ?? 0, 0, Math.max(0, top))

  if (isOver) {
    surface.onKey(k => {
      const step = { up: -1, down: 1, pageup: -(max - 1), pagedown: max - 1 }[k.key]
      if (step) go(at() + step)
      else if (k.key === 'home') go(0)
      else if (k.key === 'end') go(top)
    })
    // The bar is the region's last column: a press there, or a drag that started there, moves the view.
    const toRow = (y: number) => (clamp(y, 0, max - 1) / Math.max(1, max - 1)) * top
    surface.onPointer(p => {
      const cols = surface.columns || props.columns
      if (p.type === 'down' && p.button === 'left' && p.x >= cols - 1 && p.y < max) go(toRow(p.y), true)
      else if (p.type === 'move' && surface.state?.isDragging && p.button) go(toRow(p.y), true)
      else if (p.type === 'up' && surface.state?.isDragging) go(at(), false)
    })
  }

  const shown = isOver ? rows.slice(offset, offset + max) : rows
  const body = shown.map((r, i) => (
    <Box key={`row-${offset + i}`} flexDirection="row" minHeight={1}>
      {r.isBlock ? <Text color="subtle">{'│ '}</Text> : null}
      <Text key={`t-${offset + i}`} mono wrap="wrap" color={r.tone ? 'subtle' : undefined}>
        {r.text}
      </Text>
    </Box>
  ))
  if (!isOver) return <Box flexDirection="column">{body}</Box>

  const thumb = Math.max(1, Math.round((max * max) / rows.length))
  const from = Math.round((offset / top) * (max - thumb))
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {body}
        </Box>
        <Box key="bar" flexDirection="column" width={1} marginLeft={1}>
          {Array.from({ length: max }, (_, i) => (
            <Text key={`bar-${i}`} color={i >= from && i < from + thumb ? 'text' : 'subtle'}>
              {i >= from && i < from + thumb ? '┃' : '│'}
            </Text>
          ))}
        </Box>
      </Box>
      <Text key="hint" size="caption" color="subtle">
        {props.hint.replace('{n}', String(rows.length))}
      </Text>
    </Box>
  )
}

export default Scroll
