// What a permission request does, at a glance: a shell command split into its steps with what kind of
// harm each kind of step can do, a file write or edit as its path and its code. Deterministic, so the
// summary says only what the request says. Where the split is not certain it gives up, and the card
// shows the request itself: a summary must never hide a step that will run.

export type Shell = 'bash' | 'powershell'

export type RequestView =
  | { kind: 'shell'; steps: string[]; risks: string[] }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; diff: string; isEveryMatch?: boolean }

/**
 * A command line split at `&&`, `||`, `;`, `|` and newlines outside quotes and `$( … )`, quoting as
 * `shell` reads it: in bash `\` escapes outside quotes and inside `"…"` only; in PowerShell the escape
 * is a backtick and a quote doubles itself. `null` when the split is not certain: a quote or `$(` left
 * open, a here-doc or here-string, backtick substitution in bash, a line continuation.
 */
export const stepsOf = (cmd: string, shell: Shell = 'bash'): string[] | null => {
  if (shell === 'bash' ? /<<|`/.test(cmd) : /@["']\s*$|^\s*["']@/m.test(cmd)) return null
  const esc = shell === 'bash' ? '\\' : '`'
  const out: string[] = []
  let cur = ''
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
      out.push(cur)
      cur = ''
      i++
    } else if (!depth && (c === ';' || c === '|' || c === '\n')) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  if (quote || depth) return null
  out.push(cur)
  return out.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
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
 * Characters that change how text reads without showing themselves (bidi overrides and isolates,
 * zero-width marks, ESC and the other controls), drawn as visible `\u` codes. Tab and newline stay.
 */
export const visible = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, ch => `\\u${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`)

/**
 * `what` as the card holds it (a bare command for a shell tool, else the tool's input as JSON), read
 * as the tool that asks says: `null` where there is no summary to trust, and the card shows `what`.
 */
export const viewOf = (tool: string, what: string): RequestView | null => {
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (what.startsWith('{')) return null
    const steps = stepsOf(what, tool === 'PowerShell' ? 'powershell' : 'bash')
    return steps && steps.length <= 40 ? { kind: 'shell', steps, risks: risksOf(what) } : null
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
