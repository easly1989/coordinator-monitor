// Protected commands: a session never runs one of these without the person's
// approval from the pane, whatever its permission mode says. The defaults are
// generic; `<busDir>/rules.json` adds to them or replaces them:
//
// { "replaceDefaults": false,
//   "rules": [{ "label": "restart", "pattern": "\\bpm2\\s+restart\\b" }],
//   "critical": ["jellyfin", "homeassistant"],
//   "tierModels": { "light": "Haiku · low" } }

export type Rule = { label: string; re: RegExp }

const D = (label: string, pattern: string): Rule => ({ label, re: new RegExp(pattern, 'i') })

export const DEFAULT_RULES: readonly Rule[] = [
  // merges and pushes to the main line
  D('merge', String.raw`\bgh\s+pr\s+merge\b`),
  D('merge', String.raw`\bgit\s+merge(?![-\w])`),
  D('merge', String.raw`\bgit\s+push\b[^|;&]*[\s:+](main|master)(?=$|[\s;&|"'])`),
  D('merge', String.raw`\bgit\s+push\b[^|;&]*(--force\b|\s-f\b)`),
  // deploys and releases
  D('deploy', String.raw`\b(vercel|netlify)\b[^|;&]*--prod\b`),
  D('deploy', String.raw`\bfly(ctl)?\s+deploy\b`),
  D('deploy', String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(deploy|release|publish)\b`),
  D('deploy', String.raw`\bnpm\s+publish\b`),
  D('deploy', String.raw`\bkubectl\s+(apply|delete|rollout|scale)\b`),
  D('deploy', String.raw`\bhelm\s+(install|upgrade|uninstall|rollback)\b`),
  D('deploy', String.raw`\bterraform\s+(apply|destroy)\b`),
  D('deploy', String.raw`\bgh\s+release\s+create\b`),
  D('deploy', String.raw`\bdocker\s+push\b`),
  // restarts and stops of running services
  D('restart', String.raw`\bdocker\s+(container\s+)?(restart|stop|kill|rm)\b`),
  D('restart', String.raw`\bdocker[\s-]compose\b[^|;&]*\b(restart|stop|down|up|kill|rm)\b`),
  D('restart', String.raw`\bsystemctl\s+(restart|stop|reload|reboot|poweroff)\b`),
  D('restart', String.raw`\bservice\s+\S+\s+(restart|stop|reload)\b`),
  D('restart', String.raw`\b(reboot|shutdown|poweroff)\b`),
  D('restart', String.raw`\bha\s+(core|host|supervisor)\s+(restart|reboot|update|stop)\b`),
  D('restart', String.raw`\bpct\s+(reboot|stop|shutdown)\b|\bqm\s+(reboot|stop|shutdown|reset)\b`),
]

export type RulesFile = {
  replaceDefaults?: boolean
  rules?: { label?: string; pattern?: string }[]
  critical?: string[]
  /** Model labels per savvy tier, when your savvy agents run other models: { "light": "Haiku · low" }. */
  tierModels?: Record<string, string>
  /** A session's hat by a word of its name, `{ "planora": "crown" }`; see HAT_NAMES in crab.ts. */
  hats?: Record<string, string>
}

export const compileRules = (file: RulesFile | null): { rules: Rule[]; critical: string[] } => {
  const own: Rule[] = []
  for (const r of file?.rules ?? []) {
    if (!r.pattern) continue
    try {
      own.push({ label: r.label || 'custom', re: new RegExp(r.pattern, 'i') })
    } catch {
      // a pattern that does not compile is skipped, never fatal
    }
  }
  const rules = file?.replaceDefaults ? own : [...DEFAULT_RULES, ...own]
  const critical = (file?.critical ?? []).filter(s => typeof s === 'string' && s.trim()).map(s => s.toLowerCase())
  return { rules, critical }
}

export const matchRule = (rules: readonly Rule[], command: string): Rule | undefined => {
  const text = runnableText(command)
  return rules.find(r => r.re.test(text))
}

// A command that only stores the text it reads: cat or tee into a file, a commit message, a PR or issue body.
const SINK = /^\s*(cat|tee|git\s+commit\b.*\s-F\s*-|gh\s+(pr|issue)\s+(create|edit|comment)\b.*\s--body-file\s+-)(\s|$)/

/**
 * `command` without the bodies of the here-docs it hands to a command that only stores them, which
 * the shell never runs: writing a test or a commit message that names a protected command is not one.
 * Only the plain form is read (`cat > f <<'EOF'` ending its line, the body, then `EOF`); anything else,
 * and a body fed to a shell or an interpreter (`bash`, `python -`, `node`), is matched whole, as that
 * text can run.
 */
export const runnableText = (command: string): string => {
  const lines = command.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    out.push(line)
    const m = /<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2\s*$/.exec(line)
    if (!m) continue
    const head = line.slice(0, m.index)
    // The command the body goes to; with a quote in the line, the whole line, so a quoted `;` splits nothing.
    const to = /["']/.test(head) ? head : (head.split(/&&|\|\||[;|&]/).pop() ?? '')
    if (/[`$<>]\(|`/.test(head) || !SINK.test(to)) continue
    const end = lines.findIndex((l, j) => j > i && (m[1] ? l.replace(/^\t+/, '') : l) === m[3])
    // No end line: the shell would take the rest as the body, but nothing here is sure of it.
    if (end > i) i = end
  }
  return out.join('\n')
}

export const criticalIn = (critical: readonly string[], command: string): string | undefined => {
  const low = command.toLowerCase()
  return critical.find(name => low.includes(name))
}
