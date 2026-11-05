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
  | { kind: 'block'; text: string; to: string; lines: number; isInline?: boolean; isString?: boolean; isRunning?: boolean; language?: string; path?: string; runBy?: string; isPiped?: boolean }

// A here-doc opener: `<<` or `<<-`, the word, quoted or not, then what may end a word (no CR, which bash keeps in it).
const DOC_OPENER = /<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2(?=[ \t;&|<>)]|$)/

const LANGUAGE: Record<string, string> = { node: 'javascript', python: 'python', python3: 'python', bash: 'bash', sh: 'bash', source: 'bash', pwsh: 'powershell', powershell: 'powershell' }
const INTERP = 'node|python3?|bash|sh|pwsh|powershell'

// The programs a here-doc may be drawn as going to: cat or tee, which store it, or one that reads it as code.
const READER = new RegExp(`^(?:[A-Za-z_]\\w*=\\S*[ \\t]+)*(?:cat|tee|${INTERP})(?:\\.exe)?(?=[ \\t]|$)`, 'i')

/**
 * Where a here-doc opened by the step `part`, with `after` the rest of its line, goes: a file, else the
 * program. `null` where that is not certain: `cat` given files reads them, not the body; a target under
 * /dev or /proc may be a descriptor or a pipe that a program reads and runs.
 */
const targetOf = (part: string, after: string): { to: string; path?: string; language?: string } | null => {
  const run = part.replace(/^(?:[A-Za-z_]\w*=\S*[ \t]+)*/, '')
  const words = run.replace(/\d*>>?[ \t]*[^\s;&|<>]+/g, ' ').trim().split(/[ \t]+/)
  if (words[0] === 'cat' && words.slice(1).some(w => w !== '-' && !/^-[A-Za-z]+$/.test(w))) return null
  const file = /^(?:cat|tee)\b.*?>{0,2}\s*([^\s;&|<>]+)$/.exec(run) ?? (/^(?:cat|tee)\b/.test(run) ? /^\s*>{1,2}\s*([^\s;&|<>]+)/.exec(after) : null)
  if (file?.[1] && /^\/(dev|proc)\//.test(file[1])) return null
  if (file?.[1] && !file[1].startsWith('-') && !/^(cat|tee)$/.test(file[1])) return { to: file[1], path: file[1] }
  const by = new RegExp(`^(${INTERP})(?:\\.exe)?\\b`, 'i').exec(run)?.[1]?.toLowerCase()
  if (by) return { to: by, language: LANGUAGE[by] }
  return { to: run.split(/\s+/)[0] || 'the command' }
}

// Commands that read or move a file without running it.
const INERT = /^(?:cat|ls|chmod|chown|rm|cp|mv|wc|head|tail|stat|file|diff|grep|echo|printf|test|\[|touch)$/

/** A step's words past assignments and leading redirections (`< f bash` is bash): its program first. */
const wordsOf = (step: string): string[] =>
  step
    .trim()
    .replace(/^(?:(?:[A-Za-z_]\w*=\S*|\d*[<>]{1,2}[ \t]*[^\s;&|<>]+)[ \t]*)*/, '')
    .split(/\s+/)

/** A step's program: its first word past assignments and leading redirections (`< f bash` is bash). */
const programOf = (step: string): string => wordsOf(step)[0] ?? ''

/**
 * The first command in `text` that uses the file `base` and may run it: its program, `the shell` when
 * it is the file itself, or the program a reader of it pipes into (`cat f | bash`).
 */
const runnerOf = (text: string, base: string): string | undefined => {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Steps and the separators between them: a `|` hands the step's output to the next.
  const parts = text.split(/(\n|&&|\|\||[;&|])/)
  for (let i = 0; i < parts.length; i += 2) {
    const step = parts[i] ?? ''
    const first = programOf(step)
    if (!first || !new RegExp(`(^|[\\s/'"=<>])${esc}(?=$|[\\s'";&|)<>])`).test(step)) continue
    if (new RegExp(`(^|/)${esc}$`).test(first)) return 'the shell'
    if (first === '.' || first === 'source') return 'source'
    if (!INERT.test(first)) return first.replace(/\.exe$/i, '').toLowerCase()
    // A reader of the file piping on: the first program down the pipe that is not a reader runs it.
    for (let j = i; parts[j + 1] === '|'; j += 2) {
      const next = programOf(parts[j + 2] ?? '')
      // `tee` hands its input on, so the program after it is the one that runs the file.
      if (next === 'tee') continue
      if (next && !INERT.test(next)) return next.replace(/\.exe$/i, '').toLowerCase()
    }
  }
  return undefined
}

// A word that is one plain file name for the shell: no glob, quote, variable, substitution or `~`, and no `..` step.
const isPlainName = (w: string): boolean => /^[\w@%+=:,./-]+$/.test(w) && !/(^|\/)\.\.(\/|$)/.test(w)

/**
 * Whether a step of `text` may run a file it does not name as its plain file name: an interpreter (or `.`,
 * `source`) given a word that is not one (`g*.sh`, `"g".sh`, `$f`, `-c "…"`) or no file at all (it reads
 * its input), or a program that is not a plain word (`./g*.sh`, `$f`). Another plain file name is another file.
 */
const runsUnnamed = (text: string): boolean =>
  text.split(/\n|&&|\|\||[;&|]/).some(step => {
    const [first = '', ...rest] = wordsOf(step)
    const program = first.replace(/^[({!]+|[)}]+$/g, '')
    if (!program || INERT.test(program) || program.startsWith('#')) return false
    if (!new RegExp(`^(?:${INTERP})(?:\\.exe)?$|^(?:\\.|source)$`, 'i').test(program)) return !isPlainName(program)
    // A redirection's operator is not an operand; the file after `<` or `>` is.
    const operands = rest.map(w => w.replace(/^\d*[<>]{1,2}&?\d*/, '')).filter(w => w && !w.startsWith('-'))
    return !operands.length || operands.some(w => !isPlainName(w))
  })

/**
 * How `text` may use the file `base` later. A runner it can name: `runBy`. Otherwise, fail closed
 * rather than parse smarter, and mark the block `isPiped` ("may run later") when
 * - a `|` follows the file's first mention: it may carry the file to a program (`2>&1 |`, `|&`, a quoted
 *   `;`, a line break before the next step); or
 * - a step runs something that is not plainly another file (`runsUnnamed`): the file may be spelled in a
 *   way the mention test misses (a glob, a quote, a variable, `./sub/../`).
 * A false "may run" costs a word; a missed one costs the label.
 */
const laterUse = (text: string, base: string): { runBy?: string; isPiped?: boolean } => {
  const runBy = runnerOf(text, base)
  if (runBy) return { runBy }
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const at = new RegExp(`(^|[\\s/'"=<>])${esc}(?=$|[\\s'";&|)<>])`).exec(text)?.index
  return (at !== undefined && text.slice(at).includes('|')) || runsUnnamed(text) ? { isPiped: true } : {}
}

/**
 * `cmd` cut into its parts. A here-doc is cut out only where every part of its reading is certain (see
 * below), an inline script only when its closing quote is found; anything else stays shell text.
 */
export const segmentsOf = (cmd: string, shell: Shell = 'bash'): Segment[] => {
  // The reading marks a block as ‹n›: a command that holds those characters itself could pose as a block,
  // so it is cut into no block at all.
  if (/[‹›]/.test(cmd)) return cmd ? [{ kind: 'shell', text: cmd }] : []
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
  // A descriptor or a pipe opened anywhere (`exec 3> >(bash)`, `mkfifo`, `coproc`) may stand behind any
  // target: then no here-doc is cut out at all.
  const isPlumbed = shell === 'bash' && /(?:^|[;&|(\n])[ \t]*(?:exec[ \t]+\d*[<>]|mkfifo\b|mknod\b|coproc\b)/.test(cmd)
  for (let i = 0; i < lines.length && !isPlumbed; i++) {
    const line = lines[i] ?? ''
    let end = -1
    let t: { to: string; path?: string; language?: string; isString?: boolean; isRunning?: boolean }
    if (shell === 'bash') {
      // One `<<` on the line, its word whole as bash reads it: a word that goes on (`EOF.x`, `EOF"X"`,
      // `EOF-1`, `EOF` and a CR) is not the one this reads, so the line stays shell text.
      const m = (line.match(/<</g) ?? []).length === 1 ? DOC_OPENER.exec(line) : null
      if (!m || line.includes('<<<')) continue
      // Fail closed: a block is drawn only where all around it is plain. Before `<<`, text that splits
      // for certain and ends in cat, tee or a program that reads code; after the word, text that splits
      // for certain and leaves nothing open (no `|`, no line continuation, no `&&` or `||` going on);
      // after the end line, no `|` taking the output on. Anything else is shell text.
      const head = line.slice(0, m.index)
      const after = line.slice((m.index ?? 0) + m[0].length)
      const part = stepsOf(head, 'bash')?.at(-1) ?? ''
      // A process substitution or a duplicated descriptor (`>(bash)`, `<(…)`, `>&3`) may run the body.
      if (/[<>]\(|>&/.test(head + after)) continue
      // More than one output redirect (`> a > b`): the body goes to a file the reading may not name.
      if ((`${head}${after}`.match(/>+/g) ?? []).length > 1) continue
      if (!READER.test(part) || (after.trim() && !stepsOf(after, 'bash')) || /[|\\]|&&[ \t]*$/.test(after)) continue
      const word = m[3] ?? ''
      // Exactly the word, as bash wants it: `EOF` with a CR after it is not the end.
      end = lines.findIndex((l, j) => j > i && (m[1] === '-' ? l.replace(/^\t+/, '') : l) === word)
      if (end < 0 || /^[ \t]*(\||&&)/.test(lines[end + 1] ?? '')) continue
      const target = targetOf(part, after)
      if (!target) continue
      t = target
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
    // A file the command uses later, on the opener line or after the body: what it holds is code when
    // that use may run it. Fail closed: any command but a known reader of files counts as running it.
    const base = t.path?.split(/[\\/]/).pop() ?? ''
    const op = DOC_OPENER.exec(line)
    const later = base ? laterUse(`${line.slice(op ? op.index + op[0].length : line.length)}\n${cmd.slice(bodyEnd)}`, base) : {}
    out.push({ kind: 'block', text: body, lines: lineCount(body.replace(/\n$/, '')), ...t, ...(later.runBy ? { runBy: later.runBy, language: t.language ?? LANGUAGE[later.runBy] } : {}), ...(later.isPiped ? { isPiped: true } : {}) })
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
  // A marker typed into the command (no block carries one): the step is shown as written, never read as a block.
  if (!blocks.length && /[‹›]/.test(step)) return step
  const block = (k: string | undefined) => {
    const b = blocks[Number(k) - 1]
    return b?.kind === 'block' ? b : undefined
  }
  const size = (k: string | undefined) => {
    const b = block(k)
    return b ? ` (${b.lines} ${b.lines === 1 ? 'line' : 'lines'}${b.isRunning ? ', runs the $( ) in it now' : ''}${b.runBy ? `, run later by ${b.runBy}` : b.isPiped ? ', may run later (a later command may run it)' : ''})` : ''
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
  m = new RegExp(`^(${INTERP})(?:\\.exe)?\\b(.*?)‹(\\d+)›(.*)$`, 'i').exec(step)
  if (m) {
    const out = /(?:^|\s)\d*>>?\s*([^\s;&|<>]+)/.exec(`${m[2] ?? ''} ${m[4] ?? ''}`)?.[1]
    return `runs ${m[1]} on the block below${size(m[3])}${out ? `, output to ${out}` : ''}`
  }
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
  ['exec', /\b(python3?|node|bash|sh|pwsh|powershell)(\.exe)?\s+-(c|e|Command|EncodedCommand|enc)\b|\b(eval|iex|Invoke-Expression)\b|(^|[\s;&|])\.{1,2}[\\/]\S+|\|\s*(sh|bash)\b/i],
  ['del', /\b(rm|rmdir|del|Remove-Item)\b|\bgit\s+(reset\s+--hard|clean)\b|\s-delete\b|\b(zfs|zpool|qm|pct|lxc|virsh|docker)\s+(destroy|delete|rm|undefine)\b|\bmkfs(\.\w+)?\b/i],
  ['write', /(?<![\d&])>>?(?!&)\s*(?!\/dev\/null|\$null\b|nul\b)\S|\b(mv|cp|mkdir|tee|touch|Set-Content|Out-File|Add-Content|unzip|tar)\b/i],
]

export const risksOf = (cmd: string): string[] => RISKS.filter(([, re]) => re.test(cmd)).map(([k]) => k)

export const lineCount = (s: string): number => (s ? s.split(/\r\n|[\n\r\u2028\u2029]/).length : 0)

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

/** Something a shell request touches, as the collapsed card lists it: always shown, never summarised. */
export type Touch = { kind: 'cd' | 'rm' | 'write' | 'append' | 'url' | 'host' | 'remote'; target: string }

/**
 * The quote that is open at `at` in `text`, as the shell reads it: a `'` inside `"…"` (or the other way
 * round) opens nothing, and a `$( )` inside `"…"` is a command again, with quotes of its own.
 */
const openQuoteAt = (text: string, at: number): string => {
  // What is open, innermost last: `'`, `"`, or `(` for a `$( )`.
  const stack: string[] = []
  for (let i = 0; i < at; i++) {
    const c = text[i] ?? ''
    const top = stack.at(-1)
    if (top === "'") {
      if (c === "'") stack.pop()
    } else if (c === '\\') i++
    else if (top === '"') {
      if (c === '"') stack.pop()
      else if (c === '$' && text[i + 1] === '(') {
        stack.push('(')
        i++
      }
    } else if (c === '"' || c === "'") stack.push(c)
    else if (c === '$' && text[i + 1] === '(') {
      stack.push('(')
      i++
    } else if (c === ')' && top === '(') stack.pop()
  }
  const top = stack.at(-1)
  return top === '"' || top === "'" ? top : ''
}

/**
 * The words after `at` in `text`, quotes kept, up to the end of the command they belong to: an unquoted
 * `;`, `&`, `|`, newline, `)` or backtick, or the close of a quote the command sits in (`ssh h "rm x"`).
 */
const wordsAt = (text: string, at: number): string[] => {
  const enclosing = openQuoteAt(text, at)
  const words: string[] = []
  let cur = ''
  let quote = ''
  for (let i = at; i < text.length; i++) {
    const c = text[i] ?? ''
    if (quote) {
      cur += c
      if (c === quote) quote = ''
    } else if (c === enclosing || /[;&|\n)`]/.test(c)) break
    else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (/\s/.test(c)) {
      if (cur) words.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur) words.push(cur)
  return words
}

const SSH_ARG = /^-[pilFJbcDEeILmOoQRSWw]$/

/** Each place `text` (shell text, or a shell block) touches. Generous on purpose: an extra line costs less than a missed one. */
const touchesIn = (text: string): Touch[] => {
  const out: Touch[] = []
  const each = (re: RegExp, fn: (m: RegExpExecArray, words: string[]) => void) => {
    for (const m of text.matchAll(re)) fn(m, wordsAt(text, (m.index ?? 0) + m[0].length))
  }
  const cmd = (names: string) => new RegExp(String.raw`(?:^|[\s;&|(${'`'}'"])(?:${names})(?=[ \t])`, 'gim')
  const args = (words: string[]) => words.filter(w => !w.startsWith('-'))
  each(cmd('cd|pushd|chdir|Set-Location|sl'), (_, w) => {
    const to = args(w)[0]
    if (to) out.push({ kind: 'cd', target: to })
  })
  each(cmd('rm|rmdir|unlink|shred|Remove-Item|ri|del|erase'), (_, w) => {
    for (const to of args(w)) out.push({ kind: 'rm', target: to })
  })
  // Not an arrow (`=>`, `->`) in a short inline script, a duplicated descriptor or a process substitution.
  each(/(?<![=>-])(\d*|&)(>>|>\|?)(?![&(>])[ \t]*/g, (m, w) => {
    const to = w[0]
    if (to && !/^(\/dev\/null|\$null|nul)$/i.test(to)) out.push({ kind: m[2] === '>>' ? 'append' : 'write', target: to })
  })
  each(cmd('tee'), (_, w) => {
    for (const to of args(w)) out.push({ kind: w.some(x => x === '-a' || x === '--append') ? 'append' : 'write', target: to })
  })
  each(cmd('Out-File|Set-Content|Add-Content|sc|ac'), (m, w) => {
    const at = w.findIndex(x => /^-(Path|FilePath|LiteralPath)$/i.test(x))
    const to = at >= 0 ? w[at + 1] : args(w)[0]
    const isAppend = /Add-Content|ac$/i.test(m[0]) || w.some(x => /^-Append$/i.test(x))
    if (to) out.push({ kind: isAppend ? 'append' : 'write', target: to })
  })
  // Copies and moves write their last argument; a move also takes the others away.
  each(cmd('cp|mv|install|ln'), (m, w) => {
    const files = args(w)
    const to = files.at(-1)
    if (to && files.length > 1) {
      out.push({ kind: 'write', target: to })
      if (/mv$/i.test(m[0])) for (const from of files.slice(0, -1)) out.push({ kind: 'rm', target: from })
    }
  })
  each(cmd('touch|mkdir|truncate|chmod|chown'), (m, w) => {
    const files = /chmod|chown/i.test(m[0]) ? args(w).slice(1) : args(w)
    for (const to of files) out.push({ kind: 'write', target: to })
  })
  each(cmd('dd'), (_, w) => {
    for (const x of w) if (x.startsWith('of=')) out.push({ kind: 'write', target: x.slice(3) })
  })
  each(cmd('sed|perl'), (_, w) => {
    if (w.some(x => /^-[A-Za-z]*i/.test(x)) && args(w).length > 1) out.push({ kind: 'write', target: args(w).at(-1) ?? '' })
  })
  each(cmd('curl|wget'), (_, w) => {
    const at = w.findIndex(x => /^(-o|--output|-O|--output-document)$/.test(x))
    if (at >= 0 && w[at + 1] && w[at + 1] !== '-') out.push({ kind: 'write', target: w[at + 1] ?? '' })
  })
  each(/[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>|;&()]+/gi, m => out.push({ kind: 'url', target: m[0] }))
  each(cmd('ssh|mosh'), (_, w) => {
    const host = w.find((x, i) => !x.startsWith('-') && !SSH_ARG.test(w[i - 1] ?? ''))
    if (host) out.push({ kind: 'host', target: host.replace(/^[^@]*@/, '') })
  })
  each(cmd('scp|sftp|rsync'), (_, w) => {
    for (const x of w) {
      const host = /^(?:[^@\s:]+@)?([A-Za-z0-9][\w.-]+):/.exec(x)?.[1]
      if (host && !x.includes('://')) out.push({ kind: 'host', target: host })
    }
  })
  each(/\bgit[ \t]+(?:push|pull|fetch|clone)(?=[ \t])/g, (_, w) => {
    const to = args(w)[0]
    if (to) out.push({ kind: 'remote', target: to })
  })
  return out
}

// Files that hold data: a block written to one of these is not code, whatever the request does with it later.
// A block folds only into a plain relative file name (no path, `~`, `$`, quote, `..`, leading dot) of a short
// data list, never one named for this tool's config: the allowlist decides, NO_FOLD_TEXT is an extra guard.
const blockFolds = (sg: Extract<Segment, { kind: 'block' }>): boolean =>
  !!sg.path &&
  /^[A-Za-z0-9_][\w.@+-]*$/.test(sg.path) &&
  !sg.path.includes('..') &&
  /\.(?:md|txt|json|csv|ya?ml)$/i.test(sg.path) &&
  !/claude|settings|hook/i.test(sg.path) &&
  !sg.language && !sg.runBy && !sg.isPiped && !sg.isRunning && !sg.isInline && !sg.isString

// The programs a folded card may run: they move, make or show files and run nothing they are handed.
const FOLD_PROGRAMS = new Set(['cat', 'ls', 'mkdir', 'cd', 'echo', 'cp', 'mv', 'touch', 'chmod'])

// Never folded, whatever the program: a network pseudo-device, or a place that configures what runs later
// (this tool's own folder, a repo's hooks and workflows, an editor's tasks, ssh keys, shell start-up files).
const NO_FOLD_TEXT =
  /\/dev\/(?:tcp|udp)\/|\.claude|(?:^|[\/\\~\s'"=:])\.(?:git|github|vscode|ssh)(?:[\/\\\s'"]|$)|\.mcp\.json|\.service\.d\b|apt\.conf\.d|\.(?:bash_profile|bash_login|bash_logout|bashrc|profile|zshrc|zprofile|zshenv|zlogin)\b|\/etc\/(?:profile|bash|sudoers|cron|systemd|apt|ssh)/i

/** Whether one step of a folded card is on the allowlist (see `canFold`). */
const stepFolds = (step: string): boolean => {
  // A substitution runs whatever it holds; an assignment before the program (`GIT_CONFIG_GLOBAL=f git`,
  // `PATH=/tmp ls`, a bare `PATH=/tmp`) changes what runs, or what a later step runs.
  if (/\$\(|`|[<>]\(/.test(step)) return false
  const prefix = /^(?:(?:[A-Za-z_]\w*=\S*|\d*[<>]{1,2}[ \t]*[^\s;&|<>]+)[ \t]*)*/.exec(step.trim())?.[0] ?? ''
  if (/[A-Za-z_]\w*=/.test(prefix)) return false
  const program = programOf(step)
  if (FOLD_PROGRAMS.has(program)) {
    // Every redirect target, and every argument of a mover but echo, is one plain file name: no `~`, `$`, quote or glob.
    const redirects = [...step.matchAll(/\d*[<>]{1,2}[ \t]*([^\s;&|<>]+)/g)].map(m => m[1] ?? '')
    if (!redirects.every(w => isPlainName(w) && !/^\/(dev|proc)\//.test(w))) return false
    if (program === 'echo') return true
    const args = wordsOf(step).slice(1).filter(w => w && !/^\d*[<>]/.test(w) && !redirects.includes(w) && !w.startsWith('-') && !/^‹\d+›$/.test(w))
    return args.every(isPlainName)
  }
  if (program !== 'tee') return false
  // `tee` writes every file it is given: one only, the one the block goes to.
  const rest = step.trim().slice(prefix.length).split(/\s+/).slice(1)
  return !rest.some(w => /[<>]/.test(w)) && rest.filter(w => !w.startsWith('-') && !/^‹\d+›$/.test(w)).length === 1
}

/**
 * Whether a card may open folded. The recap says every shell step, but not the body of a block, and a
 * file of data can be read as code by a later command (`GIT_CONFIG_GLOBAL=x.conf git status`,
 * `npm install` beside a package.json, `git apply x.txt`). So both must hold, and a card that fails
 * either keeps its text on screen (fail closed):
 * - every block is a plain file of data written to a path, used as code by nothing (no interpreter,
 *   inline script, running `$( )`, later or piped use, here-string);
 * - every shell step's program is on a short allowlist of file movers (cat, ls, mkdir, cd, echo,
 *   cp, mv, touch, chmod, and tee with one file; no printf, which can set a variable), none run with an assignment before it or a
 *   substitution in it, and the steps split for certain.
 */
export const canFold = (segs: Segment[], shell: Shell = 'bash'): boolean => {
  // PowerShell runs code in a parenthesis, `@( )` and a script-block argument: nothing there is inert.
  if (shell === 'powershell') return false
  if (NO_FOLD_TEXT.test(segs.map(sg => (sg.kind === 'shell' ? sg.text : `${sg.path ?? ''}\n${sg.text}`)).join('\n'))) return false
  const isInert = segs.every(
    sg => sg.kind === 'shell' || blockFolds(sg),
  )
  const steps = splitSteps(aidTextOf(segs, shell), shell)
  return isInert && !!steps && steps.every(st => stepFolds(st.text))
}

/**
 * What a shell request touches, read from its shell text by a generous scan (an extra line costs less
 * than a missed one), and from a block only the file it writes and the URLs in it: a block that folds
 * is a file of data, and a block that runs keeps the card open (see `canFold`). Drawn through
 * `visible()` like all the rest.
 */
export const touchesOf = (cmd: string, shell: Shell = 'bash'): Touch[] => {
  const out: Touch[] = []
  for (const sg of segmentsOf(cmd, shell)) {
    if (sg.kind === 'shell') out.push(...touchesIn(sg.text))
    else {
      if (sg.path) out.push({ kind: 'write', target: sg.path })
      for (const m of sg.text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>|;&()]+/gi)) out.push({ kind: 'url', target: m[0] })
    }
  }
  const seen = new Set<string>()
  return out.filter(t => !seen.has(`${t.kind} ${t.target}`) && !!seen.add(`${t.kind} ${t.target}`))
}
