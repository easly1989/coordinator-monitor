// coordinator-monitor: one pane for every local Claude Code session.
// Copyright (C) 2026 Carlo Ruggiero (easly1989)
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. See LICENSE.
//
// Every session running this mod publishes its status to a shared folder
// (`busDir`/sessions/<id>.json): its subagents, context, pending permission
// requests and questions. The pane (any session, opened by /agents-monitor or
// by itself in the coordinator folder) reads every status file and writes the
// person's answers to `busDir`/answers/<id>.json, which the owning session
// picks up on its next tick and turns into a prompt of the person's own.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, RenderNode } from 'claude-code'

import type { AgentRow, Answer, AnswerKind, Board, ChoiceOption, ChoiceQuestion, Digest, Local, MonitorRequest, PaneUi, PlanItem, Queues, SessionStatus } from '../types'
import { CRAB_H, TIER_COLOR, TIER_MODEL, crabSvg, hatFor, tierOf } from './crab'
import { QUESTIONS_HEADING, asksGoAhead, pickStrings, type Strings } from './i18n'
import { lineCount, segmentsOf, touchesOf, viewOf, visible } from './request'
import { compileRules, criticalIn, matchRule, type Rule, type RulesFile } from './rules'

const PANE = 'coordinator-monitor'
const TICK_MS = 3000
// While a card waits, the session looks for its answer this often.
const FAST_MS = 1000
const STALE_MS = 15 * 60 * 1000
const ENDED_KEEP_MS = 60 * 60 * 1000
/** Published in every status, so the pane can flag a session still running an older copy. Keep in step with plugin.json. */
const MOD_VERSION = '0.6.4'
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const STEP_TOOL = 'mcp__savvy-progress__step'
const FLOW_TOOL = 'mcp__savvy-progress__progress'
// The desktop app's task list, and the CLI's.
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
// The coordinator's tool for what it queues per session.
const QUEUE_TOOL = 'mcp__coordinator-monitor__queue'
// The desktop app's end-of-turn box: its recap and its one question.
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'
// Past this a report keeps its head: the pane is a glance, the session has the rest.
const REPORT_MAX = 6000

const board = atom({ plugin: 'coordinator-monitor', key: 'board' } as const, { sessions: [], updatedAt: 0 } as Board, { shape: 'board-1' })
const local = atom(
  { plugin: 'coordinator-monitor', key: 'local' } as const,
  { requests: [], grantsOnce: [], grantsSession: [], steps: {}, flow: null, applied: [] } as Local,
  { shape: 'local-1' },
)
const paneUi = atom(
  { plugin: 'coordinator-monitor', key: 'ui' } as const,
  { filter: 'all', collapsed: {}, picks: {}, sent: [] } as PaneUi,
  { shape: 'ui-1' },
)

type $ = EngineInterface

// Module state: rebuilt on reload by session.start, never drawn from.
let S: Strings = pickStrings('en')
let base = ''
let sessionId = ''
let cwd = ''
let title = ''
let model = ''
let startedAt = 0
let isCoordinator = false
let isBusy = false
let isPaneOpen = false
let rules: Rule[] = []
let critical: string[] = []
let tierModels: Record<string, string> = { ...TIER_MODEL }
let forward = true
let ticking = false
let lastFollow = 0
let lastFull = 0
let hats: Record<string, string> = {}
let explainOn = false
// Protected commands whose tool call waits on the pane's answer: that wait applies it, not the tick.
const holding = new Set<string>()
let home = '.'
// The desktop app's own record of this session: its sidebar title and effort.
let label = ''
let effort = ''
// shortcut: timings live in module memory, so a reload restarts them; persist in `local` if that bothers.
const agentTimes = new Map<string, { startedAt: number; endedAt?: number }>()
// Each subagent's context at its last model request, in tokens, and its window.
const agentUse = new Map<string, { ctx: number; max: number }>()
// The wrap-up the main loop called this turn, read when the turn ends.
let wrap: { recap?: string; ask?: string } | null = null
let turnStartedAt = 0
// The answers this mod sends the session in the person's voice: they reach its own prompt.submit hook.
const ownPrompts = new Set<string>()
// How long the quiet notes (a record of an approval, a read receipt) wait to be delivered together; 0 delivers each at once.
let digestMs = 0
// When the oldest queued note was made, or 0 with none: read from the file at start, kept in step by every change to it.
let pendingSince = 0
let digestChain: Promise<unknown> = Promise.resolve()

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
const baseName = (p: string): string => norm(p).split('/').pop() || p

/** "project" or "project › worktree" for a session in a worktree. */
const titleOf = (dir: string): string => {
  const p = norm(dir)
  const m = /^(.*)\/\.claude\/worktrees\/([^/]+)$/.exec(p)
  return m?.[1] && m[2] ? `${baseName(m[1])} › ${m[2]}` : baseName(p)
}

const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
/** The id as a card shows it: its last six characters, the random four and the clock's last two. */
const shortId = (id: string): string => id.slice(-6)

const readJson = async <T,>($: $, path: string): Promise<T | null> => {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return null
  }
}

const detectLang = async ($: $, option: string | undefined): Promise<string> => {
  if (option && option !== 'auto') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return settings.language
  } catch {
    // fall through to the locale
  }
  return (await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || 'en'
}

/** `localId` is the record's file name, the id the app's deep links take. */
type DesktopMeta = { cliSessionId?: string; title?: string; effort?: string; localId?: string }

// Each desktop record as last read, by path and mtime: a refresh rereads only what changed.
const deskFiles = new Map<string, { mtimeMs: number; meta: DesktopMeta | null }>()
let deskAt = 0

/**
 * The desktop app files each Code session as claude-code-sessions/<account>/<org>/local_<id>.json,
 * with the CLI's session id, the sidebar title and the effort. The mod API has no title getter, so
 * read them there, keyed by CLI session id; a session the desktop did not start keeps its folder title.
 */
const desktopIndex = async ($: $): Promise<Map<string, DesktopMeta>> => {
  if (Date.now() - deskAt >= 60_000) {
    deskAt = Date.now()
    const appData = await $.env.get('APPDATA')
    const roots = [appData ? `${norm(appData)}/Claude` : '', `${home}/Library/Application Support/Claude`, `${home}/.config/Claude`].filter(Boolean)
    const seen = new Set<string>()
    for (const root of roots) {
      const dir = `${root}/claude-code-sessions`
      for (const acct of await $.fs.list(dir).catch(() => [])) {
        if (acct.kind !== 'dir') continue
        for (const org of await $.fs.list(`${dir}/${acct.name}`).catch(() => [])) {
          if (org.kind !== 'dir') continue
          for (const f of await $.fs.list(`${dir}/${acct.name}/${org.name}`).catch(() => [])) {
            if (f.kind !== 'file' || !f.name.startsWith('local_') || !f.name.endsWith('.json')) continue
            const path = `${dir}/${acct.name}/${org.name}/${f.name}`
            seen.add(path)
            const mtimeMs = f.mtimeMs ?? 0
            if (deskFiles.get(path)?.mtimeMs !== mtimeMs) {
              const meta = await readJson<DesktopMeta>($, path)
              deskFiles.set(path, { mtimeMs, meta: meta && { ...meta, localId: f.name.slice(0, -'.json'.length) } })
            }
          }
        }
      }
    }
    for (const p of [...deskFiles.keys()]) if (!seen.has(p)) deskFiles.delete(p)
  }
  const index = new Map<string, DesktopMeta>()
  for (const { meta } of deskFiles.values()) if (meta?.cliSessionId) index.set(meta.cliSessionId, meta)
  return index
}

// ---------------------------------------------------------------------------
// The session's own side: publish status, apply answers.

const publish = async ($: $, state?: SessionStatus['state']): Promise<void> => {
  const l = await read($, local)
  const usage = await $.session.usage().catch(() => null)
  const list = await $.agent.list().catch(() => [])
  const ctx = usage?.context as { usedPercentage?: number; used_percentage?: number } | undefined
  const now = Date.now()
  for (const a of list) {
    const t = agentTimes.get(a.id) ?? { startedAt: now }
    if (a.status !== 'running' && t.endedAt === undefined) t.endedAt = now
    if (a.status === 'running') t.endedAt = undefined
    agentTimes.set(a.id, t)
  }
  const status: SessionStatus = {
    v: 1,
    sessionId,
    version: MOD_VERSION,
    title: label || title,
    folder: title,
    cwd,
    model,
    effort: effort || undefined,
    // A report waits on the person only when it asks for a go-ahead.
    state: state ?? (l.requests.some(r => r.kind !== 'report' || r.awaits) ? 'waiting' : isBusy ? 'running' : 'idle'),
    isCoordinator,
    heartbeat: Date.now(),
    startedAt,
    contextPct: ctx?.usedPercentage ?? ctx?.used_percentage,
    costUsd: (usage?.cost as { totalUsd?: number; total_cost_usd?: number } | undefined)?.totalUsd,
    rateLimits: (usage?.rateLimits ?? []).map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    agents: list.slice(-30).map(a => {
      const st = l.steps[a.id]
      const t = agentTimes.get(a.id)
      const use = agentUse.get(a.id)
      return {
        id: a.id,
        type: a.type,
        description: a.description,
        status: String(a.status),
        stepDone: st?.done,
        stepTotal: st?.total,
        stepNote: st?.note,
        startedAt: t?.startedAt,
        endedAt: t?.endedAt,
        ctxPct: use ? Math.min(100, Math.round((use.ctx / use.max) * 100)) : undefined,
        tokens: use?.ctx,
      }
    }),
    flow: l.flow,
    requests: l.requests,
    plan: l.plan,
  }
  await $.fs.write(`${base}/sessions/${sessionId}.json`, JSON.stringify(status))
}

const applyAnswers = async ($: $): Promise<void> => {
  const answers = await readJson<Answer[]>($, `${base}/answers/${sessionId}.json`)
  if (!answers?.length) return
  const l = await read($, local)
  // The person's order for the planned tasks: a note the model reads at its next request, no turn of its own.
  for (const a of answers.filter(x => x.kind === 'order' && x.text && !l.applied.includes(x.requestId))) {
    // Claimed atomically: the pane's own call and the tick may both get here.
    let isMine = false
    await update($, local, cur => {
      isMine = !cur.applied.includes(a.requestId)
      return isMine ? { ...cur, applied: [...cur.applied, a.requestId].slice(-300) } : cur
    })
    if (isMine) await queueNote($, S.orderMsg(a.text ?? ''))
  }
  // An app ask, and a protected command held in its call, are answered by the hook that waits on them.
  const fresh = answers.filter(
    a => !l.applied.includes(a.requestId) && !holding.has(a.requestId) && l.requests.some(r => r.id === a.requestId && r.kind !== 'ask'),
  )
  if (!fresh.length) return
  const prompts: { text: string; agentId?: string }[] = []
  const notes: string[] = []
  await update($, local, cur => {
    const next: Local = { ...cur, requests: [...cur.requests], grantsOnce: [...cur.grantsOnce], grantsSession: [...cur.grantsSession], applied: [...cur.applied] }
    for (const a of fresh) {
      const req = next.requests.find(r => r.id === a.requestId)
      if (!req) continue
      next.requests = next.requests.filter(r => r.id !== a.requestId)
      next.applied = [...next.applied, a.requestId].slice(-300)
      // Fenced: the command is the session's text, sent on in the person's voice.
      const cmd = fence(req.command ?? '')
      const to = req.agentId
      if (a.kind === 'approve-once') {
        next.grantsOnce.push(grantKey(req))
        prompts.push({ text: S.approvedMsg(cmd, true), agentId: to })
      } else if (a.kind === 'approve-session') {
        next.grantsSession.push(grantKey(req))
        prompts.push({ text: S.approvedMsg(cmd, false), agentId: to })
      } else if (a.kind === 'deny') {
        prompts.push({ text: S.deniedMsg(cmd), agentId: to })
      } else if (a.kind === 'read') {
        // A note, not a prompt: it starts no turn, so nothing answers it and no report follows it.
        notes.push(S.readMsg(fmtTime(req.createdAt)))
      } else if (a.text?.trim()) {
        prompts.push({ text: req.kind === 'report' ? S.reportReplyMsg(a.text.trim()) : S.answerMsg(a.text.trim()), agentId: to })
      }
    }
    return next
  })
  for (const text of notes) await queueNote($, text)
  for (const p of prompts) {
    // A subagent's request is answered to that agent. Only when it cannot be reached does the parent
    // hear of it, told whose it is, so the parent does not run another agent's command as its own.
    if (p.agentId) {
      const sent = await $.session.send({ to: { agentId: p.agentId }, text: p.text }).catch(() => ({ isDelivered: false }))
      if (sent.isDelivered) continue
    }
    const text = p.agentId ? S.forAgentMsg(await agentLabel($, p.agentId), p.text) : p.text
    // Heard at once, and after the notes that came before it.
    await flushDigest($)
    ownPrompts.add(text)
    await $.prompt.submit({ text, asUser: true })
  }
  await publish($)
}

/** A subagent as its parent knows it: its id and the description it was started with, quoted. */
const agentLabel = async ($: $, id: string): Promise<string> => {
  const a = (await $.agent.list().catch(() => [])).find(x => x.id === id)
  return JSON.stringify(visible(a?.description ? `${id} (${a.description})` : id))
}

/**
 * A row the model reads at its next request, in a running turn or the next one. Added to a session that
 * is idle it wakes it all the same, and a wake re-reads the whole conversation: so the quiet notes go
 * through `queueNote`, and only what must be heard at once goes through here.
 */
const appendNote = async ($: $, text: string): Promise<void> => {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
}

/**
 * The quiet notes waiting for delivery: the mod's own text, made when the person answered. They live in
 * the session's state, not in the bus folder, where any process could write a line the model would read
 * as the mod's.
 */
const digest = atom({ plugin: 'coordinator-monitor', key: 'digest' } as const, { seq: 0, rows: [] } as Digest, { shape: 'digest-1' })

/** A quiet note, kept until the next time the model is going to read anyway (see `flushDigest`). */
const queueNote = async ($: $, text: string): Promise<void> => {
  if (!digestMs) return appendNote($, text)
  const at = Date.now()
  // A digest that cannot be kept must not lose the note: it goes out now, as it did before.
  await update($, digest, d => ({ seq: d.seq + 1, rows: [...d.rows, { seq: d.seq + 1, at, text }] })).then(
    () => {
      pendingSince = pendingSince || at
    },
    () => appendNote($, text),
  )
}

/** The queued notes as one row, oldest first; a single note reads as itself. */
const digestText = (rows: Digest['rows']): string =>
  rows.length === 1
    ? (rows[0]?.text ?? '')
    : S.digestMsg(rows.length, fmtTime(rows[0]?.at ?? 0), fmtTime(rows.at(-1)?.at ?? 0), rows.map((r, i) => `${i + 1}. ${r.text}`).join('\n\n'))

/**
 * Delivers every queued note as one row, in the order they were made, one flush at a time. A note made
 * while the append runs has a higher `seq` and stays for the next flush; one the append failed on stays too.
 */
const flushDigest = async ($: $): Promise<void> => {
  const run = async (): Promise<void> => {
    const d = await read($, digest)
    const last = d.rows.at(-1)
    if (!last) return
    const sent = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: digestText(d.rows) }] } }).catch(() => ({ deny: 'failed' }))
    if (sent.deny) return
    await update($, digest, cur => {
      const rows = cur.rows.filter(r => r.seq > last.seq)
      pendingSince = rows[0]?.at ?? 0
      return { ...cur, rows }
    })
  }
  digestChain = digestChain.then(run, run).catch(() => undefined)
  await digestChain
}

/** While a turn runs the notes join it at no cost; idle, they wait for the digest interval since the oldest. */
const flushDue = async ($: $): Promise<void> => {
  if (pendingSince && (isBusy || Date.now() - pendingSince >= digestMs)) await flushDigest($)
}

/** `text` as the object `askWhat` wrote it from, or `null` when it is anything else, written as it would be. */
const ownJson = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text)
    const isOwn = !!v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(sortKeys(v), null, 2) === text
    return isOwn ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

// Past this an ask keeps the app's dialog: the card shows, and the grant covers, the whole input.
const ASK_MAX = 8000
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])])) : v

const askFields = (input: unknown): Record<string, unknown> => {
  const { description: _, ...rest } = (input && typeof input === 'object' ? input : { input }) as Record<string, unknown>
  return rest
}
/** Whether an ask is a bare command: it is then shown as is, never read as the JSON it may look like. */
const isBareAsk = (input: unknown): boolean => {
  const rest = askFields(input)
  return Object.keys(rest).length === 1 && typeof rest.command === 'string'
}
/** What an app permission ask is about, in full: a bare command as is, else every field but the description. */
const askWhat = (input: unknown): string => {
  const rest = askFields(input)
  return isBareAsk(input) ? String(rest.command) : JSON.stringify(sortKeys(rest), null, 2)
}
const askKey = (tool: string, what: string): string => `ask\u0000${tool}\u0000${what}`
/** A grant belongs to whoever asked: a subagent's serves that agent alone, never its parent or another agent. */
const scoped = (agentId: string | undefined, key: string): string => (agentId ? `agent\u0000${agentId}\u0000${key}` : key)
const grantKey = (r: MonitorRequest): string => scoped(r.agentId, r.kind === 'ask' ? askKey(r.tool ?? '', r.command ?? '') : (r.command ?? ''))

// How long an app ask waits for the pane before the app's own dialog takes it (a process waits ten minutes at most).
const ASK_WAIT_MS = 9 * 60_000
// How long a protected command's call waits for the pane before it is refused and the session waits by turns.
const HOLD_MS = 2 * 60_000

/**
 * Waits until the pane answers request `id`, outside the hook's 10 s budget: a host process watches
 * this session's answers file, and a `$` call in flight never counts against the hook.
 * shortcut: the watcher outlives a session interrupted meanwhile, up to ASK_WAIT_MS; harmless, it only reads.
 */
const waitAnswer = async ($: $, id: string, timeoutMs = ASK_WAIT_MS): Promise<Answer | undefined> => {
  const path = `${base}/answers/${sessionId}.json`
  const argv = /^[a-z]:/i.test(home)
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', "while (-not ((Test-Path -LiteralPath $env:CM_FILE) -and ((Get-Content -LiteralPath $env:CM_FILE -Raw) + '').Contains($env:CM_ID))) { Start-Sleep -Milliseconds 400 }"]
    : ['sh', '-c', 'until grep -qF "$CM_ID" "$CM_FILE" 2>/dev/null; do sleep 0.4; done']
  await $.process.run(argv, { env: { CM_FILE: path, CM_ID: id }, timeoutMs }).catch(() => undefined)
  return (await readJson<Answer[]>($, path))?.find(a => a.requestId === id)
}

/** A Markdown fence no backtick run inside `s` can close, so the text stays quoted. */
const fence = (s: string): string => {
  const f = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map(m => m[0].length + 1)))
  return `${f}\n${s}\n${f}`
}

/** A questions section's numbered items ("1. …" with the lines under it), and whatever leads them. */
const itemsOf = (text: string): { lead: string; items: { n: number; text: string }[] } => {
  const lead: string[] = []
  const items: { n: number; text: string }[] = []
  for (const line of text.split('\n')) {
    const m = /^\s{0,3}(\d+)[.)]\s/.exec(line)
    const last = items.at(-1)
    if (m) items.push({ n: Number(m[1]), text: line })
    else if (last) last.text += `\n${line}`
    else lead.push(line)
  }
  return { lead: lead.join('\n'), items }
}

/**
 * The answers an item offers as bullets opening on a bold label ("- **Not now:** …"), which the desktop
 * draws as buttons. Two at least: a lone bold bullet ("**Warning:** …") is a remark, not a choice.
 */
const optionsOf = (item: string): string[] => {
  const labels = [...item.matchAll(/^\s*[-*•]\s+\*\*(.+?)\*\*/gm)]
    .map(m => (m[1] ?? '').replace(/:\s*$/, '').trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 8)
  return labels.length >= 2 ? labels : []
}

/** The requests this session raised itself, open or done with: a closing message pointing at one repeats its card. */
const ownIds = (l: Local): Set<string> => new Set([...l.applied, ...l.requests.filter(r => r.kind !== 'questions' && r.kind !== 'report').map(r => r.id)])
const ASK_VERB = /\b(approv|confirm|conferm|answer|rispond|accept|accett)\w*/i
/** Whether `text` asks the person to answer one of `ids` ("approve request <id>" or "#<short id>"), not merely mentions one. */
const asksOwn = (text: string, ids: Set<string>): boolean => {
  const shorts = new Set([...ids].map(shortId))
  return [...text.matchAll(/(#)?\b([a-z0-9]{6,16})\b/g)].some(
    m => (m[1] ? shorts.has(m[2] ?? '') : ids.has(m[2] ?? '')) && ASK_VERB.test(text.slice(Math.max(0, m.index - 100), m.index).split(/[.!?\n]/).pop() ?? ''),
  )
}

type PlanArgs = { items?: { content?: unknown; status?: unknown }[]; advance?: boolean; done?: number[]; start?: number }
const planStatus = (s: unknown): PlanItem['status'] => (s === 'completed' || s === 'in_progress' ? s : 'pending')

/** The task list after one plan call: a whole list replaces it; `advance`, `done` and `start` (1-based) move it on. */
const nextPlan = (cur: PlanItem[], a: PlanArgs): PlanItem[] => {
  const items = Array.isArray(a.items)
    ? a.items.filter(x => x && typeof x.content === 'string').map(x => ({ text: String(x.content), status: planStatus(x.status) }))
    : cur.map(p => ({ ...p }))
  const set = (i: number, status: PlanItem['status']) => {
    const it = items[i]
    if (it) it.status = status
  }
  if (a.advance) {
    set(items.findIndex(p => p.status === 'in_progress'), 'completed')
    set(items.findIndex(p => p.status === 'pending'), 'in_progress')
  }
  for (const n of Array.isArray(a.done) ? a.done : []) set(n - 1, 'completed')
  if (typeof a.start === 'number') set(a.start - 1, 'in_progress')
  return items.slice(0, 50)
}

/** Takes one approve-once grant, atomically: two calls racing for one grant get it once. */
const takeOnce = async ($: $, key: string): Promise<boolean> => {
  let took = false
  await update($, local, cur => {
    const i = cur.grantsOnce.indexOf(key)
    took = i >= 0
    return took ? { ...cur, grantsOnce: cur.grantsOnce.filter((_, j) => j !== i) } : cur
  })
  return took
}

/** A status file the pane may trust: named after the session it claims, so one session cannot pose as another. */
const statusFile = async ($: $, name: string): Promise<SessionStatus | null> => {
  const s = await readJson<SessionStatus>($, `${base}/sessions/${name}`)
  return s && typeof s.sessionId === 'string' && /^[\w-]+$/.test(s.sessionId) && name === `${s.sessionId}.json` ? s : null
}

/** Whether a coordinator session is publishing now, so a request sent to the pane gets seen. */
const coordinatorLive = async ($: $): Promise<boolean> => {
  for (const f of await $.fs.list(`${base}/sessions`).catch(() => [])) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || (f.mtimeMs && Date.now() - f.mtimeMs > 60_000)) continue
    const s = await statusFile($, f.name)
    if (s?.isCoordinator && s.sessionId !== sessionId && s.state !== 'ended' && Date.now() - s.heartbeat < 60_000) return true
  }
  return false
}

const addRequest = async ($: $, req: MonitorRequest): Promise<void> => {
  // One open question set, one choice and one report at a time; permissions and app asks stack.
  const single = req.kind === 'questions' || req.kind === 'choice' || req.kind === 'report'
  await update($, local, cur => ({ ...cur, requests: [...cur.requests.filter(r => !(single && r.kind === req.kind)), req] }))
  await publish($)
}

/** A request too long to take in at a glance: its card leads with a summary. */
const isLarge = (what: string): boolean => what.length > 400 || what.split('\n').length > 6

/**
 * Asks a small model for a plain-language gloss of a large request, when the person turned that on
 * (`explainRequests`). The text it reads is the request itself, so the card labels it as unverified.
 */
const explainLater = async ($: $, id: string, tool: string, what: string): Promise<void> => {
  if (!explainOn || !isLarge(what)) return
  const r = await $.model.complete({ model: 'haiku', maxTokens: 200, prompt: S.explainPrompt(tool, what.slice(0, 20_000)) }).catch(() => null)
  const text = r?.isAnswered ? r.text.trim().slice(0, 600) : ''
  if (!text) return
  await update($, local, cur => ({ ...cur, requests: cur.requests.map(x => (x.id === id ? { ...x, explain: text } : x)) }))
  void publish($)
}

/** Drops the requests `gone` picks, once the session has moved past them, and republishes. */
const retire = async ($: $, gone: (r: MonitorRequest) => boolean): Promise<void> => {
  if (!(await read($, local)).requests.some(gone)) return
  // Kept as done with, so a later message naming one is known to point at a settled card.
  await update($, local, cur => ({ ...cur, requests: cur.requests.filter(r => !gone(r)), applied: [...cur.applied, ...cur.requests.filter(gone).map(r => r.id)].slice(-300) }))
  void publish($)
}

/**
 * Opens a session in the desktop app by its deep link. The id comes from the app's own records and
 * is checked to be one before it reaches a shell; the link rides in an environment variable, unquoted.
 */
const openSession = async ($: $, localId: string): Promise<boolean> => {
  if (!/^local_[\w-]+$/.test(localId)) return false
  const url = `claude://claude.ai/epitaxy/${localId}`
  const argv = /^[a-z]:/i.test(home)
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:CM_URL']
    : ['sh', '-c', home.startsWith('/Users/') ? 'open "$CM_URL"' : 'xdg-open "$CM_URL"']
  const r = await $.process.run(argv, { env: { CM_URL: url }, timeoutMs: 15_000 }).catch(() => null)
  return r?.exitCode === 0
}

// ---------------------------------------------------------------------------
// The pane's side: gather every session, write answers.

const queuesPath = (): string => `${base}/queues.json`
/** The queues as stored; `null` when the file is there but unreadable, so nothing writes over it. */
const readQueues = async ($: $): Promise<Queues | null> => {
  const q = await readJson<Queues>($, queuesPath())
  if (!q || typeof q !== 'object' || Array.isArray(q)) return (await $.fs.exists(queuesPath()).catch(() => false)) ? null : {}
  return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? v.filter(x => typeof x === 'string') : []]))
}
/** `o[k]` for a key read from another session's file: an own property only, never `constructor` and kin. */
const own = <T,>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined)
const STATES = new Set<string>(['running', 'idle', 'waiting', 'ended'])

const gather = async ($: $): Promise<void> => {
  const entries = await $.fs.list(`${base}/sessions`).catch(() => [])
  const queues = (await readQueues($)) ?? {}
  const now = Date.now()
  const all: SessionStatus[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.mtimeMs && now - entry.mtimeMs > ENDED_KEEP_MS) continue
    const s = await statusFile($, entry.name)
    if (!s || s.v !== 1) continue
    const age = now - s.heartbeat
    if (s.state === 'ended' ? age > ENDED_KEEP_MS : age > STALE_MS) continue
    // Another session wrote it: its texts are drawn only as the strings they should be, every hidden
    // character as a code. The command stays as written: the card reads it, then draws it the same way.
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    const txt = (v: unknown): string | undefined => (typeof v === 'string' ? visible(v) : undefined)
    const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
    s.requests = arr<MonitorRequest>(s.requests)
      // An id ends up in keys, answers and notes: the mod makes them short and plain, so nothing else is one.
      .filter(r => r && typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id))
      .map(r => ({
        ...r,
        tool: txt(r.tool),
        command: str(r.command),
        rule: txt(r.rule),
        text: txt(r.text),
        summary: txt(r.summary),
        decision: txt(r.decision),
        explain: txt(r.explain),
        isInput: r.isInput === true,
        agentId: str(r.agentId),
        questions: arr<ChoiceQuestion>(r.questions)
          .filter(q => q && typeof q === 'object')
          .map(q => ({
            header: txt(q.header),
            question: txt(q.question) ?? '',
            multiSelect: !!q.multiSelect,
            options: arr<ChoiceOption>(q.options)
              .filter(o => o && typeof o === 'object')
              .map(o => ({ label: txt(o.label) ?? '', description: txt(o.description) })),
          })),
      }))
    s.plan = arr<PlanItem>(s.plan)
      .filter(p => p && typeof p.text === 'string')
      .map(p => ({ text: visible(p.text), status: p.status === 'completed' || p.status === 'in_progress' ? p.status : 'pending' }))
    s.queue = own(queues, s.sessionId)?.map(visible)
    s.agents = arr<AgentRow>(s.agents)
      .filter(a => a && typeof a.id === 'string')
      .map(a => ({ ...a, type: txt(a.type) ?? '', description: txt(a.description) ?? '', status: str(a.status) ?? '', stepNote: txt(a.stepNote) }))
    s.flow = s.flow && typeof s.flow === 'object' ? { ...s.flow, title: txt(s.flow.title) ?? '', phase: txt(s.flow.phase) } : null
    s.title = txt(s.title) ?? s.sessionId
    s.folder = txt(s.folder)
    s.model = txt(s.model) ?? ''
    if (!STATES.has(s.state)) s.state = 'idle'
    s.effort = txt(s.effort)
    // A session idle while its subagents work is still at work.
    if (s.state === 'idle' && s.agents.some(a => a.status === 'running')) s.state = 'running'
    all.push(s)
  }
  const rank = (s: SessionStatus) => (s.isCoordinator ? 0 : s.state === 'waiting' ? 1 : s.state === 'running' ? 2 : s.state === 'idle' ? 3 : 4)
  // Titles from the desktop's own records, so a session running an older copy of the mod is named too.
  const desk = await desktopIndex($).catch(() => new Map<string, DesktopMeta>())
  for (const s of all) {
    const m = desk.get(s.sessionId)
    if (m?.title?.trim() && m.title.trim() !== s.title) {
      s.folder ??= s.title
      s.title = visible(m.title.trim())
    }
    if (!s.effort && m?.effort) s.effort = m.effort
    s.localId = m?.localId
  }
  all.sort((a, b) => rank(a) - rank(b) || b.heartbeat - a.heartbeat)
  await update($, board, () => ({ sessions: all, updatedAt: now }))
}

/** Adds `a` to the session's answers file, keeping what is still waiting to be picked up. */
const postAnswer = async ($: $, target: SessionStatus, a: Answer): Promise<void> => {
  const path = `${base}/answers/${target.sessionId}.json`
  const live = new Set(target.requests.map(r => r.id))
  const prev = (await readJson<Answer[]>($, path)) ?? []
  // An order names no request: it stays a minute, time enough for the session's tick.
  const kept = prev.filter(x => (live.has(x.requestId) || (x.kind === 'order' && Date.now() - x.at < 60_000)) && x.requestId !== a.requestId)
  await $.fs.write(path, JSON.stringify([...kept, a]))
  if (target.sessionId === sessionId) await applyAnswers($)
}

const answer = async ($: $, target: SessionStatus, req: MonitorRequest, kind: AnswerKind, text?: string): Promise<void> => {
  await update($, paneUi, u => ({ ...u, sent: [...u.sent, req.id].slice(-300) }))
  await postAnswer($, target, { requestId: req.id, at: Date.now(), kind, text })
  // The session the pane sits in (the coordinator) keeps a record of every answer, read at its next request.
  // It carries nothing the other session wrote but its title, quoted: no question, no report text.
  // A dismiss tells no one, so it leaves no record either.
  // A free-text answer is heard at once, after the notes before it; an approval, a denial or a receipt waits for the digest.
  if (target.sessionId !== sessionId && kind !== 'dismiss') {
    if (kind === 'answer') {
      await flushDigest($)
      await appendNote($, answeredNote(target, req.id, kind, text))
    } else await queueNote($, answeredNote(target, req.id, kind, text))
  }
  $.ui.toast(S.sentToast(target.title))
  // Read again now: the session's next status shows the card gone sooner than the next tick would.
  void gather($)
}

type QueueArgs = { action?: string; session?: string; text?: string }
let queueChain: Promise<unknown> = Promise.resolve()

/**
 * The coordinator's `queue` tool. A session is named by its id or exact title; a part of a title only
 * when one live session other than the coordinator has it, else the candidates are listed back.
 */
const changeQueue = async ($: $, a: QueueArgs): Promise<string> => {
  const q = String(a.session ?? '').trim().toLowerCase()
  const all = (await read($, board)).sessions
  const live = all.filter(x => !x.isCoordinator && x.state !== 'ended')
  const exact = all.find(x => x.sessionId === a.session || x.localId === a.session) ?? all.find(x => x.title.toLowerCase() === q)
  const partial = q ? live.filter(x => x.title.toLowerCase().includes(q)) : []
  const s = exact ?? (partial.length === 1 ? partial[0] : undefined)
  if (!s) return partial.length > 1 ? S.queueAmbiguous(a.session ?? '', partial.map(x => `«${x.title}»`).join(', ')) : `No session in the pane matches "${a.session ?? ''}".`
  const queues = await readQueues($)
  if (!queues) return S.queueBroken
  const list = [...(own(queues, s.sessionId) ?? [])]
  const text = String(a.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (a.action === 'add' && text) list.push(text)
  if (a.action === 'remove') {
    const hits = list.filter(t => text && t.toLowerCase().includes(text.toLowerCase()))
    const i = list.indexOf(text) >= 0 ? list.indexOf(text) : hits.length === 1 ? list.indexOf(hits[0] ?? '') : -1
    if (i < 0) return hits.length > 1 ? S.queueAmbiguous(text, hits.map(t => `"${t}"`).join(', ')) : `"${text}" is not queued for ${s.title}.`
    list.splice(i, 1)
  }
  if (a.action === 'add' || a.action === 'remove') {
    await $.fs.write(queuesPath(), JSON.stringify({ ...queues, [s.sessionId]: list }))
    void gather($)
  }
  return `${s.title}: ${list.length ? list.map((t, n) => `${n + 1}. ${t}`).join('\n') : 'nothing queued'}`
}

/** The coordinator's record of one answer: the session's title as a quoted string, the request id, the person's answer. */
const answeredNote = (s: SessionStatus, id: string, kind: AnswerKind, text?: string): string =>
  S.answeredMsg(fmtTime(Date.now()), JSON.stringify(visible(s.title)), id, kind === 'answer' ? fence(text ?? '') : (S.answerKind[kind] ?? kind))

/** The planned tasks a session shows, in the person's order: its own plan's pending ones, then the queue's. */
const plannedOf = (s: SessionStatus, order: string[] = []): PlanItem[] => {
  const items: PlanItem[] = [...(s.plan ?? []).filter(p => p.status === 'pending'), ...(s.queue ?? []).map(text => ({ text, status: 'pending' as const, from: 'queue' as const }))]
  // shortcut: the order is kept by text, so two tasks with the same text keep their own order between them.
  const at = new Map(items.map((p, n) => [p, order.includes(p.text) ? order.indexOf(p.text) : order.length + n]))
  return items.sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0))
}

/** Moves planned task `i` of session `s` to `to`, keeps the order, and tells the session. */
const movePlanned = async ($: $, s: SessionStatus, i: number, to: number): Promise<void> => {
  const items = plannedOf(s, own((await read($, paneUi)).order, s.sessionId))
  const at = Math.max(0, Math.min(items.length - 1, to))
  if (at === i || !items[i]) return
  const [moved] = items.splice(i, 1)
  if (moved) items.splice(at, 0, moved)
  const list = items.map(p => p.text)
  await update($, paneUi, u => ({ ...u, order: { ...u.order, [s.sessionId]: list } }))
  const text = items.map((p, n) => `${n + 1}. ${p.text}${p.from === 'queue' ? ` ${S.queuedMark}` : ''}`).join('\n')
  const id = `order-${newId()}`
  await postAnswer($, s, { requestId: id, at: Date.now(), kind: 'order', text })
  // Not the list: its tasks are the session's own words.
  if (s.sessionId !== sessionId) await queueNote($, answeredNote(s, id, 'order'))
}

const newer = (a: string, b: string): boolean => a.localeCompare(b, undefined, { numeric: true }) > 0

/**
 * Mods do not hot-reload: a session keeps the copy it loaded. When a live coordinator publishes a
 * newer version, this session reloads its plugins itself (queued until it is idle), once per version
 * so a reload that brings nothing newer is not retried every tick.
 */
const followCoordinator = async ($: $): Promise<void> => {
  let newest = ''
  for (const f of await $.fs.list(`${base}/sessions`).catch(() => [])) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || (f.mtimeMs && Date.now() - f.mtimeMs > 60_000)) continue
    const s = await statusFile($, f.name)
    if (s?.isCoordinator && s.state !== 'ended' && s.version && newer(s.version, newest)) newest = s.version
  }
  if (!newest || !newer(newest, MOD_VERSION) || (await read($, local)).reloadTried === newest) return
  await update($, local, cur => ({ ...cur, reloadTried: newest }))
  await $.command.run({ command: 'reload-plugins' })
}

const tick = async ($: $): Promise<void> => {
  if (ticking) return
  ticking = true
  try {
    await flushDue($)
    // Every second only the answers are looked for, and only while a card waits; the rest every three.
    const isDue = Date.now() - lastFull >= TICK_MS - 100
    if (!isDue && !(await read($, local)).requests.length) return
    await applyAnswers($)
    if (!isDue) return
    lastFull = Date.now()
    const me = (await desktopIndex($).catch(() => new Map<string, DesktopMeta>())).get(sessionId)
    label = me?.title?.trim() ?? ''
    effort = me?.effort ?? ''
    await publish($)
    if (isPaneOpen || isCoordinator) await gather($)
    if (!isCoordinator && Date.now() - lastFollow > 30_000) {
      lastFollow = Date.now()
      await followCoordinator($).catch(() => undefined)
    }
  } catch {
    // a failed tick is retried on the next one
  } finally {
    ticking = false
  }
}

// ---------------------------------------------------------------------------
// Drawing.

const fmtPct = (n: number | undefined): string => (n === undefined ? '' : `${Math.round(n)}%`)
/** A reset within a day reads as its time ("16:40"), a later one as its weekday ("Mon"). */
const fmtReset = (iso: string | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.getTime() - Date.now() < 24 * 3600 * 1000
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { weekday: 'short' })
}
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))
const bar = (ratio: number, width: number): string => {
  const filled = Math.round(clamp01(ratio) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
// Wide markup and no width prop: the surface clamps it to the slot, and `none` stretches it to fit.
const barSvg = (ratio: number, color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="4" viewBox="0 0 1000 4" preserveAspectRatio="none">` +
  `<rect width="1000" height="4" rx="5" ry="2" fill="#8080804D"/>` +
  `<rect width="${Math.round(clamp01(ratio) * 1000)}" height="4" rx="5" ry="2" fill="${color}"/></svg>`
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** A rounded label: its text pressed to the width it is given, so no font's metrics can overflow it. */
const pillSvg = (label: string, bg: string, fg: string): string => {
  const textW = Math.round([...label].reduce((w, ch) => w + (/[A-Z0-9À-Ý]/.test(ch) ? 7.2 : 6.2), 0))
  const w = textW + 16
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="18" viewBox="0 0 ${w} 18">` +
    `<rect width="${w}" height="18" rx="9" fill="${bg}"/>` +
    `<text x="8" y="12.5" textLength="${textW}" lengthAdjust="spacingAndGlyphs" font-family="system-ui,Segoe UI,sans-serif" font-size="11" font-weight="600" fill="${fg}">${xml(label)}</text></svg>`
  )
}
/** "claude-opus-5-5" reads "Opus 5.5". */
const prettyModel = (id: string): string => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  return m?.[1] ? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}
const fmtTokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
}

// The pane's palette, after the mockup in docs/. Translucent fills sit on
// either theme; the terminal gets none of them (it has no alpha).
const AMBER = '#E8A33D'
const AMBER_TINT = '#E8A33D14'
const AMBER_LINE = '#E8A33D66'
const CARD = '#8080801A'
const CARD_LINE = '#80808033'
// A session's header band, a shade over its card, so its subagents read as rows beneath it.
const HEAD = '#80808024'
const BLUE = '#5B8DEF'
const BLUE_TINT = '#5B8DEF33'
const ON_AMBER = '#1F1E1D'
const RISK_COLOR: Record<string, string> = { net: '#5B8DEF', exec: '#E5534B', del: '#E5534B', write: '#E8A33D' }

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    S = pickStrings(await detectLang($, options.language as string | undefined))
    home = norm((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '.')
    base = norm((options.busDir as string | undefined)?.trim() || `${home}/.claude/coordinator-monitor`)
    sessionId = await $.session.id()
    cwd = norm(await $.session.cwd())
    title = titleOf(cwd)
    model = await $.session.model().catch(() => '')
    startedAt = Date.now()
    const folder = ((options.coordinatorFolder as string | undefined) ?? '').trim().toLowerCase()
    isCoordinator = !!folder && baseName(cwd).toLowerCase() === folder
    forward = (options.forwardQuestions as string | undefined) !== 'off' && !isCoordinator
    // An ask left from before a reload has no hook waiting on it any more.
    await update($, local, cur => ({ ...cur, requests: cur.requests.filter(r => r.kind !== 'ask') }))
    const minutes = Number(options.digestMinutes ?? 15)
    digestMs = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 240) * 60_000 : 0
    // Notes queued before a reload or a restart are still owed: read, so the timer counts from the oldest.
    pendingSince = (await read($, digest).catch(() => undefined))?.rows[0]?.at ?? 0
    const rulesFile = await readJson<RulesFile>($, `${base}/rules.json`)
    if (!rulesFile && (await $.fs.exists(`${base}/rules.json`).catch(() => false))) $.ui.toast(S.rulesBroken(`${base}/rules.json`))
    const compiled = compileRules(rulesFile)
    rules = compiled.rules
    critical = compiled.critical
    tierModels = { ...TIER_MODEL, ...(rulesFile?.tierModels ?? {}) }
    hats = rulesFile?.hats ?? {}
    explainOn = (options.explainRequests as string | undefined) === 'on'

    await $.command.register({ name: 'agents-monitor', description: 'Open the pane with every local session, its subagents and what waits for you' })
    // Only the coordinator queues work for the sessions.
    if (isCoordinator)
      await $.tool.register({
        name: 'queue',
        description:
          "Lists, adds or removes a session's planned tasks in the coordinator pane (its 'Planned' list). Use it when you hand a session work for later, and to remove a task only when the person asks.",
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'add', 'remove'] },
            session: { type: 'string', description: "The session's title as the pane shows it, or its id" },
            text: { type: 'string', description: 'add, remove: the task, one line' },
          },
          required: ['action', 'session'],
        },
        isDeferred: false,
      }).catch(() => undefined)
    $.clock.every(FAST_MS, () => void tick($))
    void tick($)
    if (isCoordinator) {
      const opened = await $.ui.open({ id: PANE, title: S.pane })
      isPaneOpen = opened.isPlaced
    }
    return started
  })

  on('session.end', async ($, e, next) => {
    await flushDigest($)
    await publish($, 'ended').catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'agents-monitor' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: S.pane, focus: true })
    isPaneOpen = opened.isPlaced
    await gather($)
    return { text: S.paneOpened }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      // The turn is starting anyway: the notes ride in it, the last thing the model reads before this prompt.
      await flushDigest($)
      isBusy = true
      wrap = null
      turnStartedAt = Date.now()
    }
    return next(e)
  })

  // What the person types in the session answers what the session waits on there: its questions,
  // choice and report, and a protected command it asked for (asked again, as a new card, if the session
  // tries it again). Not a slash command, a turn a notification or another session started, nor the
  // mod's own answer messages. A card the pane already answered stays until its answer is applied.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    if (ownPrompts.delete(e.text)) return next(e)
    if (!e.isMeta && !e.command && (kind === 'composer' || kind === 'sdk' || kind === 'bridge')) {
      const answered = new Set(((await readJson<Answer[]>($, `${base}/answers/${sessionId}.json`)) ?? []).map(a => a.requestId))
      // A protected command held in its call stops waiting too: the person is answering here.
      const held = (await read($, local)).requests.filter(r => r.kind === 'permission' && holding.has(r.id) && !answered.has(r.id))
      if (held.length) {
        const path = `${base}/answers/${sessionId}.json`
        const prev = (await readJson<Answer[]>($, path)) ?? []
        await $.fs.write(path, JSON.stringify([...prev, ...held.map(r => ({ requestId: r.id, at: Date.now(), kind: 'dismiss' as const }))]))
      }
      await retire($, r => (r.kind === 'permission' || r.kind === 'questions' || r.kind === 'choice' || r.kind === 'report') && !answered.has(r.id))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A loop that ended waits on no dialog of its own any more, whoever answered it.
    await retire($, r => r.kind === 'ask' && r.agentId === e.agentId)
    if (e.agentId) return done
    isBusy = false
    if (forward && !e.isAborted && e.answer.trim()) {
      // A turn that ends saying something new supersedes what the session asked or reported before it
      // (its answer may have come through another session); a choice asked during this turn stays.
      const asked = (r: MonitorRequest) => r.kind === 'questions' || r.kind === 'choice' || r.kind === 'report'
      await retire($, r => asked(r) && r.createdAt < turnStartedAt)
      const m = QUESTIONS_HEADING.exec(e.answer)
      const own = ownIds(await read($, local))
      if (m) {
        const rest = e.answer.slice(m.index + m[0].length)
        const end = rest.search(/^#{1,3}\s/m)
        const raw = (end >= 0 ? rest.slice(0, end) : rest).trim()
        // An item asking the person to answer one of this session's own cards (approve request <id>)
        // only repeats that card, and would outlive its answer: left out, and with it a section of only those.
        // A section with no numbered list is judged line by line.
        const { lead, items } = itemsOf(raw)
        const units = items.length ? items : raw.split('\n').map(line => ({ n: 0, text: line }))
        const kept = units.filter(i => !asksOwn(i.text, own))
        const text = kept.some(i => i.text.trim()) ? [items.length ? lead : '', ...kept.map(i => i.text)].join('\n').trim() : ''
        if (text) await addRequest($, { id: newId(), kind: 'questions', createdAt: Date.now(), text })
      } else if (!(await read($, local)).requests.length) {
        // A report with no questions section: shown, marked when it waits for a go-ahead. One that
        // ends a turn waiting on a card already in the pane would only repeat it, as would one that
        // asks for one of this session's own cards, answered or not.
        const text = e.answer.trim()
        const decision = wrap?.ask?.trim() || undefined
        await addRequest($, {
          id: newId(),
          kind: 'report',
          createdAt: Date.now(),
          text: text.length > REPORT_MAX ? `${text.slice(0, REPORT_MAX)}…` : text,
          summary: wrap?.recap?.trim() || undefined,
          decision,
          awaits: !asksOwn(decision ?? text, own) && (!!decision || asksGoAhead(text)),
        })
      }
    }
    wrap = null
    void publish($)
    return done
  })

  on('tool.call', { tool: WRAP_TOOL }, async ($, e, next) => {
    if (!e.agentId) {
      wrap = { recap: typeof e.recap === 'string' ? e.recap : undefined, ask: typeof e.ask === 'string' ? e.ask : undefined }
      // The wrap-up checks the desktop's task list off.
      await update($, local, cur => (cur.plan?.length ? { ...cur, plan: cur.plan.map(p => ({ ...p, status: 'completed' as const })) } : cur))
      await publish($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A call that ran, or was refused, at the app's own dialog settles the pane's card for it. Its
  // arguments sit beside `tool` on the event, as the dialog's input has them.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const { tool, tool_use_id: _, agentId: __, requestMeta: ___, ...args } = e as Record<string, unknown>
    const key = askKey(String(tool), askWhat(args))
    await retire($, r => r.kind === 'ask' && grantKey(r) === key)
    return ran
  }).catch(($, e, next) => next(e))

  // Each subagent's context and tokens, for its row.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (e.agentId && u) {
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
      // Haiku 4.5 and the Claude 3 models have a 200K window; the rest 1M.
      const max = /haiku-4|claude-3/i.test(u.model || e.model || '') ? 200_000 : 1_000_000
      agentUse.set(e.agentId, { ctx, max })
    }
    return result
  })

  // savvy-flow workers report their steps, the orchestrator its plan: keep a copy. A tool's
  // arguments sit beside `tool` on the event, not under `input`.
  // This sees the call only while savvy-progress, which answers it, sits beneath this mod.
  on('tool.call', { tool: STEP_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const id = e.agentId
    // A worker states its total once, then reports `done` alone: keep the total it gave.
    if (id)
      await update($, local, cur => {
        const total = typeof input.total === 'number' ? input.total : cur.steps[id]?.total
        return total === undefined ? cur : { ...cur, steps: { ...cur.steps, [id]: { done: input.done ?? 0, total, note: input.note } } }
      })
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: FLOW_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    const input = e as unknown as { title?: string; total?: number; done?: number; phase?: string; finished?: boolean }
    if (!e.agentId) {
      await update($, local, cur => {
        if (input.finished) return { ...cur, flow: null }
        const prev = cur.flow ?? { title: '', done: 0, total: 0 }
        return { ...cur, flow: { title: input.title ?? prev.title, done: input.done ?? prev.done, total: input.total ?? prev.total, phase: input.phase ?? prev.phase } }
      })
    }
    return ran
  }).catch(($, e, next) => next(e))

  // The session's task list, as the desktop's update_plan and the CLI's TodoWrite leave it: the main loop's alone.
  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId) {
      await update($, local, cur => ({ ...cur, plan: nextPlan(cur.plan ?? [], e as unknown as PlanArgs) }))
      await publish($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    const todos = (e as unknown as { todos?: { content?: unknown; status?: unknown }[] }).todos
    if (!e.agentId && Array.isArray(todos)) {
      await update($, local, cur => ({ ...cur, plan: nextPlan(cur.plan ?? [], { items: todos }) }))
      await publish($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // The coordinator's queue per session. The mod writes it: no session may write the bus itself.
  // Calls run one at a time, so tasks queued in parallel all land.
  on('tool.call', { tool: QUEUE_TOOL }, async ($, e) => {
    // The tool is registered in the coordinator alone; a call from anywhere else changes nothing.
    if (!isCoordinator) return { result: 'Only the coordinator session can change the queue.' }
    const run =queueChain.then(() => changeQueue($, e as unknown as QueueArgs))
    queueChain = run.catch(() => undefined)
    return { result: await run }
  }).catch(() => ({ result: 'coordinator-monitor could not change the queue' }))

  // Multiple-choice questions go to the pane instead of a dialog nobody watches.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!forward) return next(e)
    const questions: ChoiceQuestion[] = (e.questions ?? []).map(q => ({
      header: q.header,
      question: q.question ?? '',
      multiSelect: !!q.multiSelect,
      options: (q.options ?? []).map(op => ({ label: op.label ?? '', description: op.description })),
    }))
    if (!questions.length) return next(e)
    const id = newId()
    await addRequest($, { id, kind: 'choice', createdAt: Date.now(), questions, agentId: e.agentId })
    return { deny: S.questionForwarded(id) }
  }).catch(($, e, next) => next(e))

  // The app's own permission dialog goes to the pane while a coordinator is there to answer it. The
  // session holds, as at the dialog, until the answer comes back; with no answer in time, no
  // coordinator, or in the coordinator itself (the person is in its chat), the app's dialog asks.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (!forward) return next(e)
    const what = askWhat(e.tool_input)
    if (what.length > ASK_MAX) return next(e)
    const key = scoped(e.agent_id, askKey(e.tool_name, what))
    if ((await read($, local)).grantsSession.includes(key)) return { decision: { behavior: 'allow' } }
    if (!(await coordinatorLive($))) return next(e)
    const id = newId()
    await addRequest($, { id, kind: 'ask', createdAt: Date.now(), tool: e.tool_name, command: what, isInput: !isBareAsk(e.tool_input), rule: S.appPermission, agentId: e.agent_id })
    void explainLater($, id, e.tool_name, what)
    const a = await waitAnswer($, id)
    await update($, local, cur => ({
      ...cur,
      requests: cur.requests.filter(r => r.id !== id),
      applied: [...cur.applied, id].slice(-300),
      grantsSession: a?.kind === 'approve-session' ? [...cur.grantsSession, key] : cur.grantsSession,
    }))
    await publish($)
    if (a?.kind === 'approve-once' || a?.kind === 'approve-session') return { decision: { behavior: 'allow' } }
    if (a?.kind === 'deny') return { decision: { behavior: 'deny', message: S.deniedMsg(fence(what)) } }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Protected commands wait for the person's approval from the pane.
  on('tool.check', async ($, e, next) => {
    // Only the mod writes the bus: answers would let a session grant itself anything, rules.json or a
    // status file loosen the rules or pose as another session. Reading it is harmless; a file tool is
    // judged by its target, so the mod's own source and docs stay editable.
    if (!e.isReadOnly) {
      const i = (e.input ?? {}) as Record<string, unknown>
      const target = JSON.stringify(i.file_path ?? i.notebook_path ?? i).replace(/\\\\/g, '/').toLowerCase()
      if (target.includes('.claude/coordinator-monitor') || (base && target.includes(base.toLowerCase()))) return { decision: 'deny', reason: S.answersGuard }
    }
    if (!SHELL_TOOLS.has(e.tool) || !e.tool_use_id) return next(e)
    const command = String((e.input as { command?: unknown } | null)?.command ?? '')
    const rule = command && matchRule(rules, command)
    if (!rule) return next(e)
    const l = await read($, local)
    const key = scoped(e.agentId, command)
    if (l.grantsSession.includes(key)) return { decision: 'allow', reason: 'approved for this session from the coordinator pane' }
    if (await takeOnce($, key)) return { decision: 'allow', reason: 'approved once from the coordinator pane' }
    const pending = l.requests.find(r => r.kind === 'permission' && r.command === command && r.agentId === e.agentId)
    const id = pending?.id ?? newId()
    if (!pending) {
      const crit = criticalIn(critical, command)
      // With a coordinator there, the call waits a while for its answer, as at the app's dialog: an
      // approval then runs it at once, with no new turn. Unanswered, it is refused and waits as before.
      // Held before the card exists, so no tick applies an early answer as well.
      const isHeld = await coordinatorLive($)
      if (isHeld) holding.add(id)
      try {
        await addRequest($, { id, kind: 'permission', createdAt: Date.now(), tool: e.tool, command, rule: crit ? `${rule.label} · ${crit}` : rule.label, agentId: e.agentId })
        void explainLater($, id, e.tool, command)
        const a = isHeld ? await waitAnswer($, id, HOLD_MS) : undefined
        if (a?.kind === 'approve-once' || a?.kind === 'approve-session' || a?.kind === 'deny') {
          // A call interrupted meanwhile runs nothing: an approval for it is kept for the next try.
          const isGone = !!next.signal?.aborted
          await update($, local, cur => ({
            ...cur,
            requests: cur.requests.filter(r => r.id !== id),
            applied: [...cur.applied, id].slice(-300),
            grantsSession: a.kind === 'approve-session' ? [...cur.grantsSession, key] : cur.grantsSession,
            grantsOnce: a.kind === 'approve-once' && isGone ? [...cur.grantsOnce, key] : cur.grantsOnce,
          }))
          await publish($)
          return a.kind === 'deny'
            ? { decision: 'deny', reason: S.deniedMsg(fence(command)) }
            : { decision: 'allow', reason: 'approved from the coordinator pane' }
        }
      } finally {
        holding.delete(id)
      }
    }
    return { decision: 'deny', reason: S.waitApproval(rule.label, id) }
  }).catch(() => ({ decision: 'deny', reason: 'coordinator-monitor could not check this protected command' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isPaneOpen = true
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Code } = ui
    const isTerm = e.surface === 'terminal'
    const Svg = !isTerm && 'Svg' in ui ? ui.Svg : undefined
    const Input = 'Input' in ui ? ui.Input : undefined
    const Markdown = 'Markdown' in ui ? ui.Markdown : undefined
    const b = await read($, board)
    const u = await read($, paneUi)
    const cols = Math.max(30, e.props.bodyColumns || 60)
    const sent = new Set(u.sent)
    // Fills only where the surface blends them.
    const fill = (c: string): string | undefined => (isTerm ? undefined : c)

    const crab = (costume: string, alt: string, walking: boolean, dim = false, size = 30, hat?: string): RenderChildren =>
      Svg ? <Svg source={crabSvg(costume, { isWalking: walking, isDim: dim, size, hat })} alt={alt} width={size} height={CRAB_H(size)} /> : null
    const meter = (ratio: number, color: string, alt: string): RenderChildren =>
      Svg ? <Svg source={barSvg(ratio, color)} alt={alt} height={4} /> : <Text color={color}>{bar(ratio, Math.max(10, Math.min(40, cols - 16)))}</Text>
    // A rounded pill where the surface draws SVG; the terminal keeps its reversed text.
    const badge = (label: string, tone: 'amber' | 'blue' = 'amber'): RenderNode =>
      Svg ? (
        <Svg source={pillSvg(label, tone === 'amber' ? AMBER : BLUE_TINT, tone === 'amber' ? ON_AMBER : BLUE)} alt={label} height={18} />
      ) : (
        <Text size="caption" weight="bold" color={tone === 'amber' ? 'warning' : BLUE}>
          {` ${label} `}
        </Text>
      )
    // A small coloured label: a pill where SVG draws, coloured text on the terminal.
    const tag = (label: string, color: string): RenderNode =>
      Svg ? (
        <Svg source={pillSvg(label, `${color}2E`, color)} alt={label} height={18} />
      ) : (
        <Text size="caption" color={color}>
          {`[${label}]`}
        </Text>
      )
    // The desktop draws a field without chrome: frame it so it reads as one.
    const field = (input: RenderNode): RenderNode => (
      <Box flexDirection="column" paddingX="sm" borderStyle="round" borderColor={isTerm ? undefined : CARD_LINE} borderDimColor={isTerm} backgroundColor={fill(CARD)}>
        {input}
      </Box>
    )
    const chip = (label: string): RenderNode => (
      <Text size="caption" color="subtle" backgroundColor={fill(CARD)}>
        {` ${label} `}
      </Text>
    )
    // Jumps to a session in the desktop app; none for this session, which is already in front.
    const openButton = (s: SessionStatus, key: string): RenderNode | null =>
      s.localId && s.sessionId !== sessionId ? (
        <Button
          key={key}
          variant="secondary"
          label={`↗ ${S.openSession}`}
          onPress={() => void openSession($, s.localId ?? '').then(ok => ok || $.ui.toast(S.openFailed))}
        />
      ) : null

    const setFilter = (f: PaneUi['filter']) => () => void update($, paneUi, cur => ({ ...cur, filter: f }))
    const waitingCount = b.sessions.filter(s => s.state === 'waiting').length
    const limits = new Map<string, SessionStatus['rateLimits'][number]>()
    for (const s of [...b.sessions].sort((x, y) => x.heartbeat - y.heartbeat)) for (const r of s.rateLimits) limits.set(r.kind, r)
    const five = limits.get('five_hour')
    const week = limits.get('seven_day')
    // The coordinator is the chat beside the pane: its own card would only repeat it. Its requests still reach the inbox.
    const others = b.sessions.filter(s => !s.isCoordinator)
    const activeCount = others.filter(s => s.state === 'running' || s.state === 'waiting').length
    const runningAgents = others.reduce((n, s) => n + s.agents.filter(a => a.status === 'running').length, 0)
    const costs = b.sessions.map(s => s.costUsd).filter((c): c is number => typeof c === 'number')
    const ago = b.updatedAt ? Math.max(0, Math.round((Date.now() - b.updatedAt) / 1000)) : undefined


    // What waits for the person, newest last.
    const inbox: { s: SessionStatus; r: MonitorRequest }[] = []
    // A closed session waits on nothing: what it asked for is moot.
    for (const s of b.sessions) if (s.state !== 'ended') for (const r of s.requests) if (!sent.has(r.id)) inbox.push({ s, r })
    inbox.sort((x, y) => x.r.createdAt - y.r.createdAt)

    const stat = (key: string, label: string, value: string, sub: RenderChildren): RenderNode => (
      <Box key={key} flexDirection="column" width="32%" flexGrow={1} gap="xs" padding="sm" backgroundColor={fill(CARD)} borderStyle={isTerm ? 'round' : undefined} borderDimColor>
        <Text size="caption" color="subtle" wrap="truncate-end">
          {label}
        </Text>
        <Text size="heading" weight="semibold">
          {value || '—'}
        </Text>
        {sub}
      </Box>
    )

    const card = ({ s, r }: { s: SessionStatus; r: MonitorRequest }): RenderNode => {
      const head = (label: string, what: string, tone: 'amber' | 'blue' = 'amber') => (
        <Box flexDirection="row" alignItems="center" gap="sm">
          {badge(label, tone)}
          <Box flexGrow={1} flexShrink={1}>
            <Text weight="semibold" wrap="truncate-end">
              {what}
            </Text>
          </Box>
          {/* The request's short id, as sessions and the coordinator quote it; a press copies the whole id. */}
          <Button
            key={`id-${r.id}`}
            plain
            dimColor
            label={`#${shortId(r.id)}`}
            onPress={press => void $.ui.copy({ text: r.id, surface: press.surface }).then(c => $.ui.toast(c.isCopied ? S.idCopied(r.id) : r.id))}
          />
          {openButton(s, `open-${r.id}`)}
        </Box>
      )
      // Amber for what waits on the person; a report that only informs sits in the plain card colours.
      const shell = (children: RenderChildren, isQuiet = false) => (
        <Box
          key={r.id}
          flexDirection="column"
          gap="sm"
          padding="md"
          borderStyle="round"
          borderColor={isTerm ? (isQuiet ? undefined : 'warning') : isQuiet ? CARD_LINE : AMBER_LINE}
          borderDimColor={isQuiet && isTerm}
          backgroundColor={fill(isQuiet ? CARD : AMBER_TINT)}
        >
          {children}
        </Box>
      )
      if (r.kind === 'report') {
        const isOpen = !!u.open?.[r.id]
        const text = r.text ?? ''
        // Collapsed it reads as one glance: the wrap-up's question or recap, else the report's first paragraph.
        const gist = r.decision || r.summary || (text.split(/\n\s*\n/)[0] ?? '').replace(/^#+\s*/, '').slice(0, 280)
        return shell(
          <Box flexDirection="column" gap="sm">
            {head(r.awaits ? S.confirmBadge : S.report, s.title, r.awaits ? 'amber' : 'blue')}
            {isOpen ? (
              <Box flexDirection="column" padding="sm" backgroundColor={fill(CARD)}>
                {Markdown ? <Markdown key={`md-${r.id}`} text={text} /> : <Text>{text}</Text>}
              </Box>
            ) : (
              <Text size="footnote" weight={r.decision ? 'semibold' : undefined}>
                {gist}
              </Text>
            )}
            {isOpen && Input ? (
              <Box flexDirection="column" gap="xs">
                <Text size="caption" color="subtle">
                  {S.replyLabel}
                </Text>
                {field(<Input key={`reply-${r.id}`} placeholder={S.replyHere} rows={3} submitLabel={S.send} onSubmit={value => value.trim() && void answer($, s, r, 'answer', value)} />)}
              </Box>
            ) : null}
            <Box flexDirection="row" flexWrap="wrap" gap="sm">
              {r.awaits ? <Button key={`go-${r.id}`} variant="primary" label={S.confirm} onPress={() => void answer($, s, r, 'answer', S.confirmMsg)} /> : null}
              <Button
                key={`more-${r.id}`}
                variant="secondary"
                label={isOpen ? `▾ ${S.hideReport}` : `▸ ${S.showReport}`}
                onPress={() => void update($, paneUi, cur => ({ ...cur, open: { ...cur.open, [r.id]: !isOpen } }))}
              />
              {/* Unlike a dismissal, the session learns it was read; it owes no reply. */}
              <Button key={`read-${r.id}`} variant="secondary" label={S.markRead} onPress={() => void answer($, s, r, 'read')} />
              <Button key={`dismiss-${r.id}`} variant="secondary" label={S.dismiss} onPress={() => void answer($, s, r, 'dismiss')} />
            </Box>
          </Box>,
          !r.awaits,
        )
      }
      if (r.kind === 'permission' || r.kind === 'ask') {
        const what = r.command ?? ''
        const tool = r.tool ?? 'Bash'
        const shellKind = tool === 'PowerShell' ? 'powershell' : 'bash'
        // An app ask holds a shell tool's whole input as JSON: the command reads as itself, its other
        // fields as lines under it. Decoding the JSON is exact, so nothing of what is approved changes.
        // Only JSON the mod wrote itself is decoded: a bare command that looks like JSON (two `command`
        // keys, say) is a command, and is shown as one.
        const input = r.kind === 'ask' && r.isInput && (tool === 'Bash' || tool === 'PowerShell') ? ownJson(what) : null
        const cmd = typeof input?.command === 'string' ? input.command : what
        const fields = typeof input?.command === 'string' ? Object.entries(input).filter(([k]) => k !== 'command') : []
        const isShell = (tool === 'Bash' || tool === 'PowerShell') && !cmd.startsWith('{')
        // A shell command is drawn in its parts, every character of it: shell text, and each block it
        // hands on whole (a here-doc, a here-string, a long inline script) under a label saying where it goes.
        // Characters that hide or reorder text are drawn as codes, here and in the aid.
        const segs = isShell ? segmentsOf(cmd, shellKind) : []
        const view = viewOf(tool, cmd)
        // A large shell request opens folded: its recap, what it touches and its size stay, its text is a
        // press away. Never where the aid gave up: then the card opens whole, as before.
        const isFoldable = isShell && view?.kind === 'shell' && isLarge(cmd)
        const isFolded = isFoldable && !u.open?.[`full:${r.id}`]
        const touches = isFoldable ? touchesOf(cmd, shellKind) : []
        // Only what closes a block is drawn under it: an inline script's closing quotes, a here-string's
        // `'@`, a here-doc's end word (the line after its body, by how it is cut). Anything else may run
        // (`"|sh`, `'@ | iex`) and keeps a box of its own.
        const tailOf = (k: number): string | null => {
          const blk = segs[k]
          const next = segs[k + 1]
          const text = next?.kind === 'shell' ? next.text.replace(/\n$/, '') : ''
          if (blk?.kind !== 'block' || text.length >= 10) return null
          const closer = blk.isInline ? /^\s*["')]+\s*$/ : blk.isString ? /^\s*["']@\s*$/ : /^\t*[A-Za-z_]\w*$/
          return closer.test(text) ? text : null
        }
        const raw = isShell ? (
          <Box flexDirection="column" gap="xs">
            {(isFolded ? [] : segs).map((sg, k) =>
              sg.kind === 'shell' ? (
                sg.text.trim() && !tailOf(k - 1) ? <Code key={`raw-${r.id}-${k}`} source={visible(sg.text.replace(/\n$/, ''))} wrap="wrap" language={shellKind} /> : null
              ) : (
                <Box key={`blk-${r.id}-${k}`} flexDirection="column" gap="xs" paddingLeft="sm" borderStyle="round" borderColor={isTerm ? undefined : CARD_LINE} borderDimColor={isTerm}>
                  <Text size="caption" color="subtle">
                    {visible(S.blockLabel(sg.isInline ? 'inline' : sg.isString ? 'string' : sg.path ? 'file' : 'input', sg.to, sg.lines, sg.runBy, sg.isRunning, sg.isPiped))}
                  </Text>
                  <Code key={`raw-${r.id}-${k}`} source={visible(sg.text.replace(/\n$/, ''))} wrap="wrap" language={sg.language} path={sg.path} startLine={1} />
                  {tailOf(k) !== null ? (
                    <Text size="caption" color="subtle">
                      {visible(S.followedBy(tailOf(k) ?? ''))}
                    </Text>
                  ) : null}
                </Box>
              ),
            )}
            {fields.map(([k, v]) => (
              <Text key={`fld-${r.id}-${k}`} size="caption" color="subtle">
                {visible(`${k}: ${JSON.stringify(v)}`)}
              </Text>
            ))}
          </Box>
        ) : (
          <Code key={`raw-${r.id}`} source={visible(what)} wrap="wrap" language={what.startsWith('{') ? 'json' : shellKind} />
        )
        // A large request, or a file it writes, gets a reading aid on top: its steps as the asking tool's
        // shell reads them, or the file's path and code. None where the split is not certain.
        const isAided = !!view && (isLarge(cmd) || view.kind !== 'shell')
        const HEAD_LINES = 12
        const summary: RenderChildren = !view ? null : view.kind === 'shell' ? (
          <Box flexDirection="column" gap="xs">
            <Box flexDirection="row" flexWrap="wrap" gap="sm" alignItems="center">
              <Text size="caption" color="subtle">
                {S.steps(view.steps.length)}
              </Text>
              {view.risks.map(k => (
                <Box key={`risk-${r.id}-${k}`}>{tag(S.risk[k] ?? k, RISK_COLOR[k] ?? BLUE)}</Box>
              ))}
            </Box>
            {/* Every step, whole: a cut one could hide what runs after the cut. */}
            {view.steps.map((st, i) => (
              <Text key={`st-${r.id}-${i}`} size="footnote" wrap="wrap">
                <Text color="subtle">{`${i + 1}. `}</Text>
                {visible(st)}
              </Text>
            ))}
          </Box>
        ) : (
          <Box flexDirection="column" gap="xs">
            <Text size="footnote">
              <Text color="subtle">{`${view.kind === 'write' ? S.writes : S.edits} `}</Text>
              <Text weight="semibold">{visible(view.path)}</Text>
              <Text color="subtle">{view.kind === 'write' ? ` · ${S.lines(lineCount(view.content))}` : view.isEveryMatch ? ` ${S.everyMatch}` : ''}</Text>
            </Text>
            {view.kind === 'write' ? (
              <Code key={`body-${r.id}`} source={visible(view.content.split('\n').slice(0, HEAD_LINES).join('\n'))} path={view.path} startLine={1} />
            ) : (
              <Code key={`body-${r.id}`} source={visible(view.diff)} format="diff" path={view.path} />
            )}
            {view.kind === 'write' && lineCount(view.content) > HEAD_LINES ? (
              <Text size="caption" color="subtle">
                {S.firstLines(HEAD_LINES, lineCount(view.content))}
              </Text>
            ) : null}
          </Box>
        )
        return shell(
          <Box flexDirection="column" gap="sm">
            {head(S.permission, `${s.title} · ${r.tool ?? 'Bash'}`)}
            {/* A reading aid above the request, never in its place: the request itself is what is approved. */}
            {isAided ? (
              <Box flexDirection="column" gap="xs" padding="sm" borderStyle="round" borderColor={isTerm ? undefined : '#FFFFFF1F'} borderDimColor={isTerm}>
                <Text size="caption" color="subtle">
                  {S.readingAid}
                </Text>
                {summary}
              </Box>
            ) : null}
            {/* Built from the command alone, folded or not: where it goes, what it deletes and writes, whom it talks to. */}
            {touches.length ? (
              <Box flexDirection="column" gap="xs" padding="sm" borderStyle="round" borderColor={isTerm ? undefined : '#FFFFFF1F'} borderDimColor={isTerm}>
                <Text size="caption" color="subtle">
                  {S.touches}
                </Text>
                {touches.map((t, i) => (
                  <Text key={`tch-${r.id}-${i}`} size="footnote" wrap="wrap">
                    <Text color={t.kind === 'rm' ? 'warning' : 'subtle'}>{`${S.touch[t.kind]}  `}</Text>
                    {visible(t.target)}
                  </Text>
                ))}
              </Box>
            ) : null}
            {/* Written from the request itself, as unverified as the aid. */}
            {r.explain ? (
              <Box flexDirection="column" gap="xs" padding="sm" borderStyle="round" borderColor={isTerm ? undefined : '#7F77DD66'} borderDimColor={isTerm} backgroundColor={fill('#7F77DD14')}>
                <Text size="caption" weight="semibold" color="#B3ADF0">
                  {S.explainLabel}
                </Text>
                <Text size="footnote">{r.explain}</Text>
                <Text size="caption" color="subtle">
                  {S.explainWarn}
                </Text>
              </Box>
            ) : null}
            {/* The whole request, always shown, wrapped, never cut. */}
            <Box flexDirection="column" gap="xs">
              {/* Always: its size gives away a tail that blank lines or a comment push out of sight. */}
              <Text size="caption" color="subtle">
                {`${S.fullRequest} · ${view?.kind === 'shell' ? `${S.steps(view.steps.length)} · ` : ''}${S.commandSize(lineCount(cmd), cmd.length)}${segs.some(sg => sg.kind === 'block') ? ` · ${S.blocks(segs.filter(sg => sg.kind === 'block').length)}` : ''}`}
              </Text>
              {isFoldable ? (
                <Box flexDirection="row">
                  <Button
                    key={`full-${r.id}`}
                    variant="secondary"
                    label={isFolded ? `▸ ${S.showRequest}` : `▾ ${S.hideRequest}`}
                    onPress={() => void update($, paneUi, cur => ({ ...cur, open: { ...cur.open, [`full:${r.id}`]: isFolded } }))}
                  />
                </Box>
              ) : null}
              {raw}
            </Box>
            {r.rule ? (
              <Text size="footnote" color={r.rule.includes('·') ? 'warning' : 'subtle'}>
                {r.rule.includes('·') ? `${r.rule} — ${S.critical}` : r.rule}
              </Text>
            ) : null}
            <Box flexDirection="row" flexWrap="wrap" gap="sm">
              <Button key={`once-${r.id}`} variant="primary" label={S.approveOnce} onPress={() => void answer($, s, r, 'approve-once')} />
              <Button key={`sess-${r.id}`} variant="secondary" label={S.approveSession} onPress={() => void answer($, s, r, 'approve-session')} />
              <Button key={`deny-${r.id}`} variant="secondary" label={S.deny} onPress={() => void answer($, s, r, 'deny')} />
            </Box>
          </Box>,
        )
      }
      if (r.kind === 'choice') {
        const qs = r.questions ?? []
        const picks = (qi: number): number[] => u.picks[`${r.id}:${qi}`] ?? []
        const toggle = (qi: number, oi: number, multi: boolean) => () =>
          void update($, paneUi, cur => {
            const k = `${r.id}:${qi}`
            const was = cur.picks[k] ?? []
            const now = multi ? (was.includes(oi) ? was.filter(x => x !== oi) : [...was, oi]) : [oi]
            return { ...cur, picks: { ...cur.picks, [k]: now } }
          })
        const compose = (other: string): string =>
          qs
            .map((q, qi) => {
              const chosen = picks(qi).map(oi => q.options[oi]?.label).filter(Boolean)
              const a = qi === qs.length - 1 && other.trim() ? other.trim() : chosen.join(', ')
              return qs.length > 1 ? `${qi + 1}. ${q.question}\n→ ${a || '—'}` : a
            })
            .join('\n\n')
        return shell(
          <Box flexDirection="column" gap="sm">
            {head(S.choice, s.title)}
            {qs.map((q, qi) => (
              <Box key={`${r.id}-q${qi}`} flexDirection="column" gap="sm">
                <Box flexDirection="row" gap="sm" alignItems="center">
                  {q.header ? chip(q.header) : null}
                  <Text size="caption" color="subtle">
                    {S.questionOf(qi + 1, qs.length)}
                  </Text>
                </Box>
                <Text weight="semibold">{q.question}</Text>
                {q.options.map((o, oi) => {
                  const isOn = picks(qi).includes(oi)
                  return (
                    <Box
                      key={`${r.id}-${qi}-${oi}`}
                      flexDirection="column"
                      // Thin: the Button inside is the press target, the padding around it is not.
                      paddingX="sm"
                      paddingY="xs"
                      borderStyle="round"
                      borderColor={isOn ? (isTerm ? 'warning' : AMBER) : isTerm ? undefined : CARD_LINE}
                      borderDimColor={!isOn && isTerm}
                      backgroundColor={fill(isOn ? AMBER_TINT : CARD)}
                      hover={isTerm ? undefined : { borderColor: AMBER_LINE }}
                    >
                      {/* A Box takes no press: the Button holds both lines, so either one picks the option. */}
                      <Button key={`${r.id}-${qi}-${oi}-b`} plain onPress={toggle(qi, oi, !!q.multiSelect)}>
                        {isTerm ? (isOn ? '● ' : '○ ') : ''}
                        <Text weight="semibold">{o.label}</Text>
                        {o.description ? '\n' : ''}
                        {o.description ? (
                          <Text size="footnote" color="subtle">
                            {o.description}
                          </Text>
                        ) : (
                          ''
                        )}
                      </Button>
                    </Box>
                  )
                })}
              </Box>
            ))}
            {Input ? (
              <Box flexDirection="column" gap="xs">
                <Text size="caption" color="subtle">
                  {S.other}
                </Text>
                {field(<Input key={`other-${r.id}`} placeholder={S.otherPlaceholder} submitLabel={S.send} onSubmit={value => void answer($, s, r, 'answer', compose(value))} />)}
              </Box>
            ) : null}
            <Box flexDirection="row" flexWrap="wrap" gap="sm">
              <Button key={`send-${r.id}`} variant="primary" label={S.send} onPress={() => void answer($, s, r, 'answer', compose(''))} />
              <Button key={`dismiss-${r.id}`} variant="secondary" label={S.dismiss} onPress={() => void answer($, s, r, 'dismiss')} />
            </Box>
          </Box>,
        )
      }
      // An item's bold-label bullets are its answers, as buttons: one item answers on a press, several
      // are picked one by one and sent together, each with its item's number.
      const { items } = itemsOf(r.text ?? '')
      // Picks keyed by the item's place: a section may repeat a number.
      const offers = items.map((i, at) => ({ at, n: i.n, options: optionsOf(i.text) })).filter(o => o.options.length)
      const isMulti = items.length > 1
      const pickOf = (at: number): number | undefined => u.picks[`${r.id}:${at}`]?.[0]
      const composeQ = (other: string): string =>
        [...offers.map(o => {
          const oi = pickOf(o.at)
          return oi === undefined ? '' : `${o.n}. ${o.options[oi]}`
        }), other.trim()].filter(Boolean).join('\n')
      const reply = (text: string) => text && void answer($, s, r, 'answer', text)
      return shell(
        <Box flexDirection="column" gap="sm">
          {head(S.questions, s.title)}
          <Box flexDirection="column" padding="sm" backgroundColor={fill(CARD)}>
            {Markdown ? <Markdown key={`md-${r.id}`} text={r.text ?? ''} /> : <Text>{r.text ?? ''}</Text>}
          </Box>
          {offers.map(o => (
            <Box key={`${r.id}-o${o.at}`} flexDirection="row" flexWrap="wrap" gap="sm" alignItems="center">
              {isMulti ? (
                <Text size="caption" color="subtle">
                  {`${o.n}.`}
                </Text>
              ) : null}
              {o.options.map((label, oi) => (
                <Button
                  key={`opt-${r.id}-${o.at}-${oi}`}
                  variant={pickOf(o.at) === oi ? 'primary' : 'secondary'}
                  label={label}
                  onPress={() =>
                    isMulti
                      ? void update($, paneUi, cur => ({ ...cur, picks: { ...cur.picks, [`${r.id}:${o.at}`]: cur.picks[`${r.id}:${o.at}`]?.[0] === oi ? [] : [oi] } }))
                      : reply(label)
                  }
                />
              ))}
            </Box>
          ))}
          {Input ? (
            <Box flexDirection="column" gap="xs">
              <Text size="caption" color="subtle">
                {offers.length ? S.other : S.replyLabel}
              </Text>
              {field(<Input key={`reply-${r.id}`} placeholder={S.replyHere} rows={3} submitLabel={S.send} onSubmit={value => reply(isMulti ? composeQ(value) : value.trim())} />)}
            </Box>
          ) : null}
          <Box flexDirection="row" gap="sm">
            {isMulti && offers.length ? <Button key={`send-${r.id}`} variant="primary" label={S.send} onPress={() => reply(composeQ(''))} /> : null}
            <Button key={`dismiss-${r.id}`} variant="secondary" label={S.dismiss} onPress={() => void answer($, s, r, 'dismiss')} />
          </Box>
        </Box>,
      )
    }

    const shown = others.filter(s =>
      u.filter === 'waiting' ? s.state === 'waiting' : u.filter === 'active' ? s.state === 'running' || s.state === 'waiting' : true,
    )
    // Locked sessions hold their place, in the person's order, above the rest, which sort by activity.
    const locked = (u.locked ?? []).map(id => shown.find(s => s.sessionId === id)).filter((s): s is SessionStatus => !!s)
    const loose = shown.filter(s => !u.locked?.includes(s.sessionId))

    const pill = (state: string): RenderNode | null =>
      state === 'waiting' ? badge(S.st.waiting ?? state) : state === 'running' ? badge(S.st.running ?? state, 'blue') : (
        <Text size="caption" color="subtle">
          {S.st[state] ?? state}
        </Text>
      )

    // A hairline across the card; the terminal's border already separates enough.
    const rule: RenderChildren = Svg ? (
      <Svg source='<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1" viewBox="0 0 1000 1" preserveAspectRatio="none"><rect width="1000" height="1" fill="#80808040"/></svg>' alt="—" height={1} />
    ) : null

    const sessionBlock = (s: SessionStatus): RenderNode => {
      const isCol = !!u.collapsed[s.sessionId]
      const who = [s.isCoordinator ? S.coordinator : '', s.sessionId === sessionId ? S.thisSession : ''].filter(Boolean).join(' · ')
      const meta = [prettyModel(s.model), s.effort ? (own(S.effort, s.effort) ?? s.effort) : '', s.contextPct !== undefined ? `ctx ${fmtPct(s.contextPct)}` : '']
        .filter(Boolean)
        .join(' · ')
      const ask = s.requests.find(r => r.kind !== 'report' || r.awaits)
      const asks =
        // The command itself is on its card in the inbox, above: the session's card only says so.
        ask?.kind === 'permission' || ask?.kind === 'ask'
          ? S.waitsPermission
          : ask?.kind === 'choice'
            ? S.hasChoice
            : ask?.kind === 'questions'
              ? S.hasQuestions
              : ask?.kind === 'report' && ask.awaits
                ? S.waitsConfirm
                : ''
      const flow = s.flow ? `${s.flow.title} · ${s.flow.done}/${s.flow.total}${s.flow.phase ? ` · ${s.flow.phase}` : ''}` : ''
      const costume = s.state === 'waiting' ? 'waiting' : 'other'
      const id = s.sessionId
      const isLocked = !!u.locked?.includes(id)
      const toggleLock = () =>
        void update($, paneUi, cur => ({ ...cur, locked: isLocked ? (cur.locked ?? []).filter(x => x !== id) : [...(cur.locked ?? []), id] }))
      const lockUp = () =>
        void update($, paneUi, cur => {
          const l = [...(cur.locked ?? [])]
          const i = l.indexOf(id)
          if (i > 0) [l[i - 1], l[i]] = [l[i] ?? id, l[i - 1] ?? id]
          return { ...cur, locked: l }
        })
      // The session's progress: its plan's done tasks over all it has to do, the queue's included.
      const plan = s.plan ?? []
      const done = plan.filter(p => p.status === 'completed').length
      const total = plan.length + (s.queue?.length ?? 0)
      const now = plan.filter(p => p.status === 'in_progress')
      const planned = plannedOf(s, own(u.order, id))
      const isFolded = !!u.tasksFolded?.[id]
      // A pointer can show a long title whole on hover; with none (terminal, touch) the title wraps instead.
      const hasHover = !isTerm && e.surface !== 'mobile'
      // A grid: number | source mark | title, which takes what is left | the controls, last and fixed, so
      // they stand at the same place on every row. They stay drawn (dim at rest) so the keyboard reaches them.
      // The controls are their glyphs: a desktop draws a Button's label, not its children, and words
      // overflowed the row. The legend line above names them.
      // On touch the controls are full buttons, a finger's size apart.
      const ctl = e.surface === 'mobile' ? ({ variant: 'secondary' } as const) : ({ plain: true, dimColor: true } as const)
      const plannedRow = (p: PlanItem, i: number): RenderNode => {
        // The number opens the whole title, for a keyboard and a press as well as the pointer's hover.
        const isWhole = !hasHover || !!u.open?.[`task:${id}:${p.text}`]
        return (
          <Box key={`pl-${id}-${i}`} flexDirection="row" gap="sm" alignItems="center" paddingX="sm" hover={hasHover ? { backgroundColor: '#80808026' } : undefined}>
            <Box flexShrink={0}>
              {hasHover ? (
                <Button
                  key={`exp-${id}-${i}`}
                  plain
                  dimColor
                  label={`${String(i + 1).padStart(2, '\u2007')}.`}
                  onPress={() => void update($, paneUi, cur => ({ ...cur, open: { ...cur.open, [`task:${id}:${p.text}`]: !isWhole } }))}
                />
              ) : (
                <Text size="caption" color="subtle">
                  {`${String(i + 1).padStart(2, '\u2007')}.`}
                </Text>
              )}
            </Box>
            <Box flexShrink={0}>
              <Text size="caption" color={p.from === 'queue' ? BLUE : 'subtle'}>
                {p.from === 'queue' ? '◆' : '◇'}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text size="footnote" wrap={isWhole ? 'wrap' : 'truncate-end'}>
                {p.text}
              </Text>
              {!isWhole && p.text.length > 40 ? (
                <Box position="absolute" top={1} left={0} display="none" hover={{ display: 'flex' }} padding="xs" borderStyle="round" borderColor={CARD_LINE} backgroundColor={HEAD}>
                  <Text size="footnote" wrap="wrap">
                    {p.text}
                  </Text>
                </Box>
              ) : null}
            </Box>
            <Box flexDirection="row" gap={e.surface === 'mobile' ? 'sm' : 'xs'} flexShrink={0}>
              <Button key={`up-${id}-${i}`} {...ctl} label="▲" onPress={() => void movePlanned($, s, i, i - 1)} />
              <Button key={`down-${id}-${i}`} {...ctl} label="▼" onPress={() => void movePlanned($, s, i, i + 1)} />
              <Button key={`top-${id}-${i}`} {...ctl} label="⤒" onPress={() => void movePlanned($, s, i, 0)} />
            </Box>
          </Box>
        )
      }
      return (
        // padding 0: the header's band reaches the card's edges.
        <Box key={id} flexDirection="column" padding={0} borderStyle="round" borderColor={isTerm ? undefined : s.state === 'waiting' ? AMBER_LINE : CARD_LINE} borderDimColor={isTerm} backgroundColor={fill(CARD)}>
          {/* The session's header: a band of its own, the session's figures beside its name, its progress under it. */}
          <Box flexDirection="column" gap="xs" padding="md" backgroundColor={fill(HEAD)}>
            <Box flexDirection="row" gap="sm" alignItems="center">
              {crab(costume, s.title, s.state === 'running', s.state === 'ended' || s.state === 'idle', 34, hatFor(`${s.title} ${s.folder ?? ''}`, hats))}
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Box flexDirection="row" gap="sm" alignItems="center">
                  <Text weight="bold" wrap="truncate-end">
                    {s.title}
                  </Text>
                  {pill(s.state)}
                </Box>
                <Text size="footnote" color="subtle" wrap="truncate-end">
                  {flow || asks || who || s.folder || s.cwd}
                </Text>
                {/* Mods do not hot-reload: a session keeps the copy it loaded until /reload-plugins. */}
                {s.state !== 'ended' && (s.version ?? '0').localeCompare(MOD_VERSION, undefined, { numeric: true }) < 0 ? (
                  <Text size="caption" color="warning" wrap="truncate-end">
                    {S.oldMod(s.version ?? '< 0.3')}
                  </Text>
                ) : null}
              </Box>
              <Text size="caption" color="subtle">
                {meta}
              </Text>
              {openButton(s, `open-${id}`)}
              {/* Icons, as big as Open beside them: the desktop draws a Button's label, so the label is the glyph. */}
              {isLocked && u.locked?.[0] !== id ? <Button key={`lockup-${id}`} variant="secondary" label="▲" onPress={lockUp} /> : null}
              <Button key={`lock-${id}`} variant="secondary" label={isLocked ? '🔒' : '🔓'} onPress={toggleLock} />
              {s.agents.length ? (
                <Button
                  key={`c-${id}`}
                  plain
                  dimColor
                  label={isCol ? `▸ ${s.agents.length}` : '▾'}
                  onPress={() => void update($, paneUi, cur => ({ ...cur, collapsed: { ...cur.collapsed, [id]: !isCol } }))}
                />
              ) : null}
            </Box>
            {total ? (
              <Box flexDirection="column" gap="xs">
                {meter(done / total, BLUE, `${done}/${total}`)}
                <Text size="caption" color="subtle">
                  {S.progressOf(done, total)}
                </Text>
              </Box>
            ) : null}
          </Box>
          {now.length || planned.length ? (
            <Box flexDirection="column" gap="xs" paddingX="md" paddingY="sm">
              <Button
                key={`tasks-${id}`}
                plain
                dimColor
                label={`${isFolded ? '▸' : '▾'} ${S.tasks} · ${S.tasksCount(now.length, planned.length)}${done ? ` · ${S.doneCount(done)}` : ''}`}
                onPress={() => void update($, paneUi, cur => ({ ...cur, tasksFolded: { ...cur.tasksFolded, [id]: !isFolded } }))}
              />
              {!isFolded && now.length ? (
                <Text size="caption" color="subtle">
                  {S.inProgress}
                </Text>
              ) : null}
              {!isFolded
                ? now.map((p, i) => (
                    <Box key={`now-${id}-${i}`} paddingX="sm" backgroundColor={fill(BLUE_TINT)}>
                      <Text size="footnote">
                        <Text color={BLUE}>● </Text>
                        {p.text}
                      </Text>
                    </Box>
                  ))
                : null}
              {!isFolded && planned.length ? (
                <Text size="caption" color="subtle">
                  {S.planned}
                </Text>
              ) : null}
              {!isFolded ? planned.map(plannedRow) : null}
              {!isFolded && planned.length ? (
                <Text size="caption" color="subtle">
                  {S.noRemove}
                </Text>
              ) : null}
            </Box>
          ) : null}
          {!isCol &&
            s.agents.map(a => {
              const tier = tierOf(a.type)
              const color = TIER_COLOR[tier] ?? '#888780'
              const word = tier === 'other' ? a.type : tier === 'explore' ? 'Explore' : tier
              const ratio = a.status === 'done' ? 1 : a.stepTotal ? (a.stepDone ?? 0) / a.stepTotal : 0
              const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ` · ${a.stepNote}` : ''}` : ''
              const took = a.startedAt ? fmtDur((a.endedAt ?? Date.now()) - a.startedAt) : ''
              const stats = [a.ctxPct !== undefined ? `ctx ${a.ctxPct}%` : '', a.tokens ? fmtTokens(a.tokens) : '', took].filter(Boolean).join(' · ')
              // Only this session's own subagents can be opened from here.
              const pick = () => void $.ui.view({ agentId: a.id }).then(r => r.deny && $.ui.toast(r.deny))
              const name = (
                <Text size="footnote" weight="semibold" wrap="truncate-end">
                  {a.description || a.type}
                </Text>
              )
              // Each worker is one compact row under the header: name, tier and figures on a line, its bar right under it.
              return (
                <Box key={`${id}-${a.id}`} flexDirection="column">
                  {rule}
                  <Box flexDirection="row" gap="sm" paddingY="xs" paddingRight="sm" paddingLeft="lg" alignItems="flex-start">
                    {crab(tier === 'other' ? 'other' : tier, word, a.status === 'running', false, 22)}
                    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                      <Box flexDirection="row" gap="sm" alignItems="center">
                        <Box flexShrink={1}>
                          {s.sessionId === sessionId ? (
                            <Button key={`a-${a.id}`} plain dimColor={a.status === 'idle'} onPress={pick}>
                              {name}
                            </Button>
                          ) : (
                            name
                          )}
                        </Box>
                        <Text size="caption">
                          <Text color={color} weight="semibold">
                            {word}
                          </Text>
                          <Text color="subtle">{tierModels[tier] ? ` · ${tierModels[tier]}` : ''}</Text>
                        </Text>
                        <Text size="caption" color="subtle">
                          {stats}
                        </Text>
                        <Box flexGrow={1} />
                        <Text color={a.status === 'done' ? 'success' : a.status === 'failed' ? 'error' : a.status === 'running' ? BLUE : 'subtle'}>
                          {a.status === 'done' ? '✓' : a.status === 'failed' ? '✕' : a.status === 'running' ? '●' : '◷'}
                        </Text>
                      </Box>
                      {meter(ratio, a.status === 'done' ? '#3FB950' : color, `${Math.round(clamp01(ratio) * 100)}%`)}
                      {steps ? (
                        <Text size="caption" wrap="truncate-end">
                          {steps}
                        </Text>
                      ) : null}
                    </Box>
                  </Box>
                </Box>
              )
            })}
        </Box>
      )
    }

    const tab = (f: PaneUi['filter'], label: string) => (
      <Button key={`tab-${f}`} variant={u.filter === f ? 'primary' : 'secondary'} label={label} onPress={setFilter(f)} />
    )

    return (
      <Box flexDirection="column" gap="md">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
          <Text size="heading" weight="semibold">
            {S.pane}
          </Text>
          <Text size="caption" color="subtle">
            {S.allSessions}
            {ago !== undefined ? ` · ${S.updatedAgo(ago)}` : ''}
          </Text>
        </Box>
        {/* A fixed third each: the bars' wide markup would otherwise push every card onto its own row. */}
        <Box flexDirection="row" gap="sm">
          {stat(
            'st-5h',
            `${S.fiveHour}${five?.resetsAt ? ` · ${S.until} ${fmtReset(five.resetsAt)}` : ''}`,
            fmtPct(five?.percentUsed),
            meter((five?.percentUsed ?? 0) / 100, (five?.percentUsed ?? 0) >= 90 ? '#E5534B' : '#7F77DD', fmtPct(five?.percentUsed)),
          )}
          {stat(
            'st-week',
            `${S.week}${week?.resetsAt ? ` · ${S.until} ${fmtReset(week.resetsAt)}` : ''}`,
            fmtPct(week?.percentUsed),
            meter((week?.percentUsed ?? 0) / 100, (week?.percentUsed ?? 0) >= 93 ? '#E5534B' : '#7F77DD', fmtPct(week?.percentUsed)),
          )}
          {stat(
            'st-now',
            `${S.now} · ${activeCount} ${S.active.toLowerCase()} / ${others.length}`,
            costs.length ? `≈$${costs.reduce((x, y) => x + y, 0).toFixed(2)}` : String(activeCount),
            <Text size="caption" color="subtle">
              {S.agentsRunning(runningAgents)}
            </Text>,
          )}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap="sm">
          {tab('all', S.all)}
          {tab('waiting', `${S.waiting} · ${waitingCount}`)}
          {tab('active', S.active)}
        </Box>
        {u.filter !== 'active' && inbox.length ? (
          <Box flexDirection="column" gap="sm">
            <Text size="caption" weight="bold" color={isTerm ? 'warning' : AMBER}>
              {S.inbox} · {inbox.length}
            </Text>
            {inbox.map(card)}
          </Box>
        ) : u.filter !== 'active' ? (
          <Text size="footnote" color="subtle">
            {S.nothingWaiting}
          </Text>
        ) : null}
        <Text size="caption" weight="bold" color="subtle">
          {S.sessionsAndAgents}
        </Text>
        {shown.length ? (
          <Box flexDirection="column" gap="sm">
            {locked.length ? (
              <Text size="caption" weight="bold" color="subtle">
                {`🔒 ${S.lockedGroup}`}
              </Text>
            ) : null}
            {locked.map(sessionBlock)}
            {locked.length && loose.length ? (
              <Text size="caption" weight="bold" color="subtle">
                {S.othersGroup}
              </Text>
            ) : null}
            {loose.map(sessionBlock)}
          </Box>
        ) : (
          <Text size="footnote" color="subtle">
            {S.noSessions}
          </Text>
        )}
      </Box>
    )
  })
}
