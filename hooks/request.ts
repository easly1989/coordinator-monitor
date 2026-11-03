// What a permission request does, at a glance: a shell command split into its steps with what kind of
// harm each kind of step can do, a file write or edit as its path and its code. Deterministic, so the
// summary says only what the request says; the full request stays one press away.

export type RequestView =
  | { kind: 'shell'; steps: string[]; risks: string[] }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; diff: string }

/** A command line split at `&&`, `||`, `;`, `|` and newlines outside quotes and `$( … )`. */
export const stepsOf = (cmd: string): string[] => {
  const out: string[] = []
  let cur = ''
  let quote = ''
  let depth = 0
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] ?? ''
    const two = cmd.slice(i, i + 2)
    if (quote) {
      if (c === quote && cmd[i - 1] !== '\\') quote = ''
      cur += c
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

/** `what` as the card holds it: a bare command for a shell tool, else the tool's input as JSON. */
export const viewOf = (what: string): RequestView | null => {
  if (!what.startsWith('{')) return { kind: 'shell', steps: stepsOf(what), risks: risksOf(what) }
  let input: Record<string, unknown>
  try {
    input = JSON.parse(what) as Record<string, unknown>
  } catch {
    return null
  }
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  if (!path) return null
  if (typeof input.content === 'string') return { kind: 'write', path, content: input.content }
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const old = input.old_string.split('\n')
    const neu = input.new_string.split('\n')
    const diff = [`@@ -1,${old.length} +1,${neu.length} @@`, ...old.map(l => `-${l}`), ...neu.map(l => `+${l}`)].join('\n')
    return { kind: 'edit', path, diff }
  }
  return null
}
