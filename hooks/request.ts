// A reading aid for a permission request: a shell command split into its steps with what kind of
// harm each kind of step can do, a file write or edit as its path and its code. Only an aid: the card
// always shows the request itself, which is what is approved. Where the split is not certain the aid
// gives up rather than guess: a step it hides would be worse than no steps at all.

export type Shell = 'bash' | 'powershell'

export type RequestView =
  | { kind: 'shell'; steps: string[]; risks: string[] }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; diff: string; isEveryMatch?: boolean }

/**
 * Characters that change how text reads without showing themselves: controls but tab and newline
 * (ESC, a bare CR), bidi marks, overrides and isolates, zero-width and other invisible fillers,
 * variation selectors, tag characters, lone surrogates, and every other default-ignorable or format
 * character Unicode lists.
 */
const HIDDEN =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}\uD800-\uDFFF\p{Default_Ignorable_Code_Point}\p{Cf}]/u

/**
 * A command line split at `&&`, `||`, `&`, `;`, `|` and newlines outside quotes and `$( … )`, quoting
 * as `shell` reads it: in bash `\` escapes outside quotes and inside `"…"` only; in PowerShell the
 * escape is a backtick and a quote doubles itself. `null` when the split is not certain: a quote or
 * `$(` left open, a here-doc or here-string, backtick substitution or `$'…'` in bash, a line
 * continuation, a comment, a curly quote (PowerShell reads them as quotes), a hidden character.
 */
export const stepsOf = (cmd: string, shell: Shell = 'bash'): string[] | null => splitSteps(cmd, shell)?.map(st => st.text) ?? null

/** `stepsOf`, each step also telling whether it reads the one before it through a pipe. */
const splitSteps = (cmd: string, shell: Shell): { text: string; isPiped: boolean }[] | null => {
  if (HIDDEN.test(cmd.replace(/\r\n/g, '\n')) || /[\u2018-\u201F]/.test(cmd)) return null
  if (shell === 'bash' ? /<<|`|\$'/.test(cmd) : /@["']\s*$|^\s*["']@/m.test(cmd)) return null
  const esc = shell === 'bash' ? '\\' : '`'
  const out: { text: string; isPiped: boolean }[] = []
  let cur = ''
  let isPiped = false
  let quote = ''
  let depth = 0
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] ?? ''
    const two = cmd.slice(i, i + 2)
    if (quote) {
      // An escape inside quotes: bash only in double quotes, PowerShell (backtick) only in double quotes too.
      if (quote === '"' && c === esc) {
        cur += two
        i++
      } else if (c === quote && shell === 'powershell' && cmd[i + 1] === quote) {
        cur += two
        i++
      } else {
        if (c === quote) quote = ''
        cur += c
      }
    } else if (c === esc) {
      // An escaped character, or a line continuation: the latter joins lines in ways not worth guessing.
      if (cmd[i + 1] === '\n' || cmd[i + 1] === '\r') return null
      cur += two
      i++
    } else if (c === '#' && (/(^|\s)$/.test(cur) || cur.endsWith('<'))) {
      // A comment, or a PowerShell block comment: what it swallows depends on rules not worth guessing.
      return null
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (two === '$(') {
      depth++
      cur += two
      i++
    } else if (c === ')' && depth) {
      depth--
      cur += c
    } else if (!depth && (two === '&&' || two === '||')) {
      out.push({ text: cur, isPiped })
      cur = ''
      isPiped = false
      i++
    } else if (!depth && c === '&' && cur.trim() && !/[<>]$/.test(cur) && cmd[i + 1] !== '>') {
      // A lone `&` runs what is before it in the background and goes on: a step. Kept are a redirection
      // (`2>&1`, `&>`) and PowerShell's call operator, which starts its step.
      out.push({ text: cur, isPiped })
      cur = ''
      isPiped = false
    } else if (!depth && (c === ';' || c === '|' || c === '\n')) {
      out.push({ text: cur, isPiped })
      cur = ''
      isPiped = c === '|'
    } else cur += c
  }
  if (quote || depth) return null
  out.push({ text: cur, isPiped })
  // Nothing inside a step is collapsed: what shows is what runs.
  return out.map(st => ({ ...st, text: st.text.trim() })).filter(st => st.text)
}

/**
 * One part of a command as the card draws it: shell text, or a block the shell hands on whole (a
 * here-doc or here-string body, a long inline `-c` / `-e` script), labelled with where it goes. The
 * parts are slices of the command in order: together they are the command, every character of it.
 */
export type Segment =
  | { kind: 'shell'; text: string }
  | { kind: 'block'; text: string; to: string; lines: number; isInline?: boolean; isString?: boolean; isRunning?: boolean; language?: string; path?: string; runBy?: string }

// A here-doc opener: `<<` or `<<-`, the word, quoted or not, then what may end a word (no CR, which bash keeps in it).
const DOC_OPENER = /<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2(?=[ \t;&|<>)]|$)/

const LANGUAGE: Record<string, string> = { node: 'javascript', python: 'python', python3: 'python', bash: 'bash', sh: 'bash', source: 'bash', pwsh: 'powershell', powershell: 'powershell' }
const INTERP = 'node|python3?|bash|sh|pwsh|powershell'

/**
 * Where a here-doc opened between `head` and `after` goes: a program it is piped to (on its line, or on
 * the line after its end, when its line ends in `|`), a file, else the command that reads it.
 */
const targetOf = (head: string, after: string, next: string): { to: string; path?: string; language?: string } => {
  const pipe = /(?<![\|>])\|(?!\|)(.*)$/.exec(after)
  if (pipe) {
    const to = ((pipe[1] ?? '').trim() || next.trim()).split(/[\s;&|]/)[0]?.replace(/\.exe$/i, '').toLowerCase() || 'the next command'
    return { to, language: LANGUAGE[to] }
  }
  const part = head.split(/&&|\|\||[;&|]/).pop()?.trim() ?? ''
  const file = /^(?:cat|tee)\b.*?>{0,2}\s*([^\s;&|<>]+)$/.exec(part) ?? (/^(?:cat|tee)\b/.test(part) ? /^\s*>{1,2}\s*([^\s;&|<>]+)/.exec(after) : null)
  if (file?.[1] && !file[1].startsWith('-') && !/^(cat|tee)$/.test(file[1])) return { to: file[1], path: file[1] }
  const by = new RegExp(`^(${INTERP})(?:\\.exe)?\\b`, 'i').exec(part)?.[1]?.toLowerCase()
  if (by) return { to: by, language: LANGUAGE[by] }
  return { to: part.split(/\s+/)[0] || 'the command' }
}

/**
 * `cmd` cut into its parts. Only a here-doc whose end line is there is cut out (one opener on its line),
 * and an inline script only when its closing quote is found; anything else stays shell text.
 */
export const segmentsOf = (cmd: string, shell: Shell = 'bash'): Segment[] => {
  const out: Segment[] = []
  const lines = cmd.split('\n')
  const starts: number[] = []
  let n = 0
  for (const l of lines) {
    starts.push(n)
    n += l.length + 1
  }
  const offset = (i: number): number => Math.min(starts[i] ?? cmd.length, cmd.length)
  let from = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    let end = -1
    let t: { to: string; path?: string; language?: string; isString?: boolean; isRunning?: boolean }
    if (shell === 'bash') {
      // One `<<` on the line, its word whole as bash reads it: a word that goes on (`EOF.x`, `EOF"X"`,
      // `EOF-1`, `EOF` and a CR) is not the one this reads, so the line stays shell text.
      const m = (line.match(/<</g) ?? []).length === 1 ? DOC_OPENER.exec(line) : null
      if (!m || line.includes('<<<')) continue
      const head = line.slice(0, m.index)
      // A `<<` inside quotes, or after a comment, opens nothing: the line stays shell text.
      if (head.trim() && !stepsOf(head, 'bash')) continue
      const word = m[3] ?? ''
      // Exactly the word, as bash wants it: `EOF` with a CR after it is not the end.
      end = lines.findIndex((l, j) => j > i && (m[1] === '-' ? l.replace(/^\t+/, '') : l) === word)
      if (end < 0) continue
      t = targetOf(head, line.slice((m.index ?? 0) + m[0].length), lines[end + 1] ?? '')
      // An unquoted word: the shell runs each `$( )` and backtick in the body as it reads it.
      const body = lines.slice(i + 1, end).join('\n')
      if (!m[2] && /\$\(|`/.test(body)) t.isRunning = true
    } else {
      const m = /@(["'])\s*$/.exec(line)
      if (!m) continue
      end = lines.findIndex((l, j) => j > i && l.startsWith(`${m[1]}@`))
      t = { to: /(\$[\w:]+)\s*=\s*$/.exec(line.slice(0, m.index))?.[1] ?? '', isString: true }
    }
    if (end < 0) continue
    const bodyStart = offset(i + 1)
    const bodyEnd = offset(end)
    if (bodyEnd <= bodyStart) continue
    out.push({ kind: 'shell', text: cmd.slice(from, bodyStart) })
    const body = cmd.slice(bodyStart, bodyEnd)
    // A file the command runs later: what it holds is code, whatever it was written as.
    const base = t.path?.split(/[\\/]/).pop() ?? ''
    const by = base
      ? new RegExp(`(?:^|[\\s;&|(])(${INTERP}|source|\\.)(?:\\.exe)?\\s+[^;&|\\n]*${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').exec(cmd.slice(bodyEnd))?.[1]?.toLowerCase()
      : undefined
    const runBy = by === '.' ? 'source' : by
    out.push({ kind: 'block', text: body, lines: lineCount(body.replace(/\n$/, '')), ...t, ...(runBy ? { runBy, language: t.language ?? LANGUAGE[runBy] } : {}) })
    from = bodyEnd
    i = end - 1
  }
  out.push({ kind: 'shell', text: cmd.slice(from) })
  return out.flatMap(sg => (sg.kind === 'shell' ? scriptsIn(sg.text, shell) : [sg])).filter(sg => sg.text)
}

/** Shell text with each long inline script (`python -c "…"`, `node -e '…'`) cut out as a block of its own. */
const scriptsIn = (text: string, shell: Shell): Segment[] => {
  const out: Segment[] = []
  const re = new RegExp(`(?:^|[\\s;&|(])(${INTERP})(?:\\.exe)?\\s+(-c|-e|-Command)\\s+(["'])`, 'gi')
  let from = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length
    const q = m[3] ?? '"'
    const esc = shell === 'bash' ? '\\' : '`'
    let close = -1
    for (let k = open; k < text.length; k++) {
      if (q === '"' && text[k] === esc) k++
      else if (text[k] === q) {
        if (shell === 'powershell' && text[k + 1] === q) k++
        else {
          close = k
          break
        }
      }
    }
    if (close < 0) break
    const script = text.slice(open, close)
    if (script.length < 80 && !script.includes('\n')) continue
    const by = (m[1] ?? '').toLowerCase()
    out.push({ kind: 'shell', text: text.slice(from, open) })
    out.push({ kind: 'block', text: script, to: by, isInline: true, lines: lineCount(script), language: LANGUAGE[by] })
    from = close
    re.lastIndex = close + 1
  }
  out.push({ kind: 'shell', text: text.slice(from) })
  return out
}

/**
 * The command the reading aid splits into steps: its shell text, each block standing as `‹n›` (the
 * n-th block), a here-doc's body and end line left out, so a step can say what it writes or runs.
 */
const aidTextOf = (segs: Segment[], shell: Shell): string => {
  const blocks: Segment[] = segs.filter(sg => sg.kind === 'block')
  const no = (sg: Segment | undefined): number => (sg ? blocks.indexOf(sg) + 1 : 0)
  const isDoc = (sg: Segment | undefined): boolean => sg?.kind === 'block' && !sg.isInline
  return segs
    .map((sg, k) => {
      if (sg.kind === 'block') return isDoc(sg) ? '' : `‹${no(sg)}›`
      let t = sg.text
      if (isDoc(segs[k - 1])) t = shell === 'bash' ? t.replace(/^[^\n]*(\n|$)/, '') : t.replace(/^["']@/, '')
      if (isDoc(segs[k + 1])) t = t.replace(/(<<-?[ \t]*(['"]?)[A-Za-z_]\w*\2(?=[ \t;&|<>)]|\n|$)|@["'])([^\n]*\n?)$/, `‹${no(segs[k + 1])}›$3`)
      return t
    })
    .join('')
}

/** A step in plain words, where its form is a common one; else the step itself. */
export const describeStep = (step: string, blocks: Segment[]): string => {
  const block = (k: string | undefined) => {
    const b = blocks[Number(k) - 1]
    return b?.kind === 'block' ? b : undefined
  }
  const size = (k: string | undefined) => {
    const b = block(k)
    return b ? ` (${b.lines} ${b.lines === 1 ? 'line' : 'lines'}${b.isRunning ? ', runs the $( ) in it now' : ''}${b.runBy ? `, run later by ${b.runBy}` : ''})` : ''
  }
  const env = /^((?:[A-Za-z_]\w*=\S*\s+)+)(\S.*)$/.exec(step)
  if (env?.[1] && env[2]) return `${describeStep(env[2], blocks)} (with ${env[1].trim()})`
  let m = /^(?:\.|source)\s+(\S+)(.*)$/.exec(step)
  if (m) return `runs ${m[1]} in this shell${m[2]?.trim() ? `: ${m[2].trim()}` : ''}`
  m = /^(?:cat|tee)\b.*‹(\d+)›/.exec(step)
  if (m) return block(m[1])?.path ? `writes ${block(m[1])?.to}${size(m[1])}` : `feeds the block below to ${block(m[1])?.to ?? 'the next command'}${size(m[1])}`
  m = /^([A-Za-z_]\w*)=/.exec(step)
  if (m) return `sets ${m[1]}`
  m = new RegExp(`^(${INTERP})(?:\\.exe)?\\s+(?:-c|-e|-Command)\\s+(["'])‹(\\d+)›\\2(.*)$`, 'i').exec(step)
  if (m) return `runs the inline ${m[1]} script below${size(m[3])}${m[4]?.trim() ? `, then ${m[4].trim()}` : ''}`
  m = new RegExp(`^(${INTERP})(?:\\.exe)?\\s+(?:-c|-e|-Command)\\s+(.+)$`, 'i').exec(step)
  if (m) return `runs inline ${m[1]}: ${m[2]}`
  m = new RegExp(`^(${INTERP})(?:\\.exe)?\\s+(?:-\\s+)?‹(\\d+)›`, 'i').exec(step)
  if (m) return `runs ${m[1]} on the block below${size(m[2])}`
  m = new RegExp(`^(${INTERP})(?:\\.exe)?\\s+([^-\\s]\\S*)(.*)$`, 'i').exec(step)
  if (m) return `runs ${m[2]} with ${m[1]}${m[3]?.trim() ? `: ${m[3].trim()}` : ''}`
  m = /^mkdir\s+(?:-p\s+)?(.+)$/.exec(step)
  if (m) return `creates the folders ${m[1]}`
  m = /^cd\s+(.+)$/.exec(step)
  if (m) return `goes to ${m[1]}`
  m = /^rm\s+(?:-[a-z]+\s+)*(.+)$/.exec(step)
  if (m) return `deletes ${m[1]}`
  m = /^ls\b\s*(.*)$/.exec(step)
  if (m) return `lists ${m[1] || 'the folder'}`
  return step
}

// shortcut: word lists for the common tools on this machine; a step they miss shows with no chip.
const RISKS: [string, RegExp][] = [
  ['net', /\b(curl|wget|gh|scp|ssh|rsync|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b|\bgit\s+(push|pull|fetch|clone)\b|\b(npm|pnpm|yarn)\s+(i|install|add|publish)\b|\bpip3?\s+install\b/i],
  ['exec', /\b(python3?|node|bash|sh|pwsh|powershell)(\.exe)?\s+-(c|e|Command)\b|\b(eval|iex|Invoke-Expression)\b|(^|[\s;&|])\.{1,2}[\\/]\S+|\|\s*(sh|bash)\b/i],
  ['del', /\b(rm|rmdir|del|Remove-Item)\b|\bgit\s+(reset\s+--hard|clean)\b/i],
  ['write', /(?<![\d&])>>?(?!&)\s*(?!\/dev\/null|\$null\b|nul\b)\S|\b(mv|cp|mkdir|tee|touch|Set-Content|Out-File|Add-Content|unzip|tar)\b/i],
]

export const risksOf = (cmd: string): string[] => RISKS.filter(([, re]) => re.test(cmd)).map(([k]) => k)

export const lineCount = (s: string): number => (s ? s.split('\n').length : 0)

/**
 * `s` with every hidden character drawn as a visible code (`\u202E`, `\u{E0041}`), and so is a stack of
 * three or more combining marks. Tab and newline stay; a character a shell may read as a line break
 * (CR, NEL, the line and paragraph separators) also breaks the line where it stands, so what follows it
 * shows as the line it is. Padding that would push the rest of the text out of sight is counted
 * instead of drawn: three or more blank lines, twenty or more spaces or tabs in a row.
 */
export const visible = (s: string): string =>
  s
    .replace(new RegExp(`${HIDDEN.source}|\\p{M}{3,}`, 'gu'), (run: string, at: number) => {
      const codes = [...run]
        .map(ch => {
          const hex = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase()
          return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`
        })
        .join('')
      return /^[\r\u0085\u2028\u2029]$/.test(run) && s[at + run.length] !== '\n' ? `${codes}\n` : codes
    })
    .replace(/\n(?:[ \t]*\n){3,}/g, m => `\n⟨${m.split('\n').length - 2} blank lines⟩\n`)
    .replace(/[ \t]{20,}/g, m => `⟨${m.length} ${m.includes('\t') ? 'spaces and tabs' : 'spaces'}⟩`)

/**
 * `what` as the card holds it (a bare command for a shell tool, else the tool's input as JSON), read
 * as the tool that asks says: `null` where there is no summary to trust, and the card shows `what`.
 */
export const viewOf = (tool: string, what: string): RequestView | null => {
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (what.startsWith('{')) return null
    const shell = tool === 'PowerShell' ? 'powershell' : 'bash'
    // Steps of the shell text alone; a here-doc or inline script is one step that names its block.
    const segs = segmentsOf(what, shell)
    const blocks = segs.filter(sg => sg.kind === 'block')
    const steps = splitSteps(aidTextOf(segs, shell), shell)
    if (!steps || steps.length > 40) return null
    return { kind: 'shell', steps: steps.map(st => `${st.isPiped ? 'pipes into: ' : ''}${describeStep(st.text, blocks)}`), risks: risksOf(what) }
  }
  if (tool !== 'Write' && tool !== 'Edit') return null
  let input: Record<string, unknown>
  try {
    input = JSON.parse(what) as Record<string, unknown>
  } catch {
    return null
  }
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  if (!path) return null
  if (tool === 'Write' && typeof input.content === 'string') return { kind: 'write', path, content: input.content }
  if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const old = input.old_string.split('\n')
    const neu = input.new_string.split('\n')
    const diff = [`@@ -1,${old.length} +1,${neu.length} @@`, ...old.map(l => `-${l}`), ...neu.map(l => `+${l}`)].join('\n')
    return input.replace_all === true ? { kind: 'edit', path, diff, isEveryMatch: true } : { kind: 'edit', path, diff }
  }
  return null
}
