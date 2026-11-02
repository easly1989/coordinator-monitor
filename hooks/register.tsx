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

import type { Answer, AnswerKind, Board, ChoiceQuestion, Local, MonitorRequest, PaneUi, SessionStatus } from '../types'
import { CRAB_H, TIER_COLOR, TIER_MODEL, crabSvg, tierOf } from './crab'
import { QUESTIONS_HEADING, pickStrings, type Strings } from './i18n'
import { compileRules, criticalIn, matchRule, type Rule, type RulesFile } from './rules'

const PANE = 'coordinator-monitor'
const TICK_MS = 3000
const STALE_MS = 15 * 60 * 1000
const ENDED_KEEP_MS = 60 * 60 * 1000
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const STEP_TOOL = 'mcp__savvy-progress__step'
const FLOW_TOOL = 'mcp__savvy-progress__progress'

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
/** App permission asks go to the pane, the coordinator's own too: its pane is beside it. */
let forwardAsks = true
let ticking = false
let home = '.'
// The desktop app's own record of this session: its sidebar title and effort.
let label = ''
let effort = ''
// shortcut: timings live in module memory, so a reload restarts them; persist in `local` if that bothers.
const agentTimes = new Map<string, { startedAt: number; endedAt?: number }>()

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
const baseName = (p: string): string => norm(p).split('/').pop() || p

/** "project" or "project › worktree" for a session in a worktree. */
const titleOf = (dir: string): string => {
  const p = norm(dir)
  const m = /^(.*)\/\.claude\/worktrees\/([^/]+)$/.exec(p)
  return m?.[1] && m[2] ? `${baseName(m[1])} › ${m[2]}` : baseName(p)
}

const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

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

type DesktopMeta = { cliSessionId?: string; title?: string; effort?: string }

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
            if (deskFiles.get(path)?.mtimeMs !== mtimeMs) deskFiles.set(path, { mtimeMs, meta: await readJson<DesktopMeta>($, path) })
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
    title: label || title,
    folder: title,
    cwd,
    model,
    effort: effort || undefined,
    state: state ?? (l.requests.length ? 'waiting' : isBusy ? 'running' : 'idle'),
    isCoordinator,
    heartbeat: Date.now(),
    startedAt,
    contextPct: ctx?.usedPercentage ?? ctx?.used_percentage,
    costUsd: (usage?.cost as { totalUsd?: number; total_cost_usd?: number } | undefined)?.totalUsd,
    rateLimits: (usage?.rateLimits ?? []).map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    agents: list.slice(-30).map(a => {
      const st = l.steps[a.id]
      const t = agentTimes.get(a.id)
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
      }
    }),
    flow: l.flow,
    requests: l.requests,
  }
  await $.fs.write(`${base}/sessions/${sessionId}.json`, JSON.stringify(status))
}

const applyAnswers = async ($: $): Promise<void> => {
  const answers = await readJson<Answer[]>($, `${base}/answers/${sessionId}.json`)
  if (!answers?.length) return
  const l = await read($, local)
  // An app ask is answered by the hook that waits on it, not here.
  const fresh = answers.filter(a => !l.applied.includes(a.requestId) && l.requests.some(r => r.id === a.requestId && r.kind !== 'ask'))
  if (!fresh.length) return
  const prompts: string[] = []
  await update($, local, cur => {
    const next: Local = { ...cur, requests: [...cur.requests], grantsOnce: [...cur.grantsOnce], grantsSession: [...cur.grantsSession], applied: [...cur.applied] }
    for (const a of fresh) {
      const req = next.requests.find(r => r.id === a.requestId)
      if (!req) continue
      next.requests = next.requests.filter(r => r.id !== a.requestId)
      next.applied = [...next.applied, a.requestId].slice(-300)
      // Fenced: the command is the session's text, sent on in the person's voice.
      const cmd = fence(req.command ?? '')
      if (a.kind === 'approve-once') {
        next.grantsOnce.push(grantKey(req))
        prompts.push(S.approvedMsg(cmd, true))
      } else if (a.kind === 'approve-session') {
        next.grantsSession.push(grantKey(req))
        prompts.push(S.approvedMsg(cmd, false))
      } else if (a.kind === 'deny') {
        prompts.push(S.deniedMsg(cmd))
      } else if (a.text?.trim()) {
        prompts.push(S.answerMsg(a.text.trim()))
      }
    }
    return next
  })
  for (const text of prompts) await $.prompt.submit({ text, asUser: true })
  await publish($)
}

// Past this an ask keeps the app's dialog: the card shows, and the grant covers, the whole input.
const ASK_MAX = 8000
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])])) : v

/** What an app permission ask is about, in full: a bare command as is, else every field but the description. */
const askWhat = (input: unknown): string => {
  const { description: _, ...rest } = (input && typeof input === 'object' ? input : { input }) as Record<string, unknown>
  return Object.keys(rest).length === 1 && typeof rest.command === 'string' ? rest.command : JSON.stringify(sortKeys(rest), null, 2)
}
const askKey = (tool: string, what: string): string => `ask\u0000${tool}\u0000${what}`
const grantKey = (r: MonitorRequest): string => (r.kind === 'ask' ? askKey(r.tool ?? '', r.command ?? '') : (r.command ?? ''))

// How long an app ask waits for the pane before the app's own dialog takes it (a process waits ten minutes at most).
const ASK_WAIT_MS = 9 * 60_000

/**
 * Waits until the pane answers request `id`, outside the hook's 10 s budget: a host process watches
 * this session's answers file, and a `$` call in flight never counts against the hook.
 * shortcut: the watcher outlives a session interrupted meanwhile, up to ASK_WAIT_MS; harmless, it only reads.
 */
const waitAnswer = async ($: $, id: string): Promise<Answer | undefined> => {
  const path = `${base}/answers/${sessionId}.json`
  const argv = /^[a-z]:/i.test(home)
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', "while (-not ((Test-Path -LiteralPath $env:CM_FILE) -and ((Get-Content -LiteralPath $env:CM_FILE -Raw) + '').Contains($env:CM_ID))) { Start-Sleep -Milliseconds 400 }"]
    : ['sh', '-c', 'until grep -qF "$CM_ID" "$CM_FILE" 2>/dev/null; do sleep 0.4; done']
  await $.process.run(argv, { env: { CM_FILE: path, CM_ID: id }, timeoutMs: ASK_WAIT_MS }).catch(() => undefined)
  return (await readJson<Answer[]>($, path))?.find(a => a.requestId === id)
}

/** A Markdown fence no backtick run inside `s` can close, so the text stays quoted. */
const fence = (s: string): string => {
  const f = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map(m => m[0].length + 1)))
  return `${f}\n${s}\n${f}`
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
  // One open question set and one choice at a time; permissions and app asks stack.
  const single = req.kind === 'questions' || req.kind === 'choice'
  await update($, local, cur => ({ ...cur, requests: [...cur.requests.filter(r => !(single && r.kind === req.kind)), req] }))
  await publish($)
}

// ---------------------------------------------------------------------------
// The pane's side: gather every session, write answers.

const gather = async ($: $): Promise<void> => {
  const entries = await $.fs.list(`${base}/sessions`).catch(() => [])
  const now = Date.now()
  const all: SessionStatus[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (entry.mtimeMs && now - entry.mtimeMs > ENDED_KEEP_MS) continue
    const s = await statusFile($, entry.name)
    if (!s || s.v !== 1) continue
    const age = now - s.heartbeat
    if (s.state === 'ended' ? age > ENDED_KEEP_MS : age > STALE_MS) continue
    all.push(s)
  }
  const rank = (s: SessionStatus) => (s.isCoordinator ? 0 : s.state === 'waiting' ? 1 : s.state === 'running' ? 2 : s.state === 'idle' ? 3 : 4)
  // Titles from the desktop's own records, so a session running an older copy of the mod is named too.
  const desk = await desktopIndex($).catch(() => new Map<string, DesktopMeta>())
  for (const s of all) {
    const m = desk.get(s.sessionId)
    if (m?.title?.trim() && m.title.trim() !== s.title) {
      s.folder ??= s.title
      s.title = m.title.trim()
    }
    if (!s.effort && m?.effort) s.effort = m.effort
  }
  all.sort((a, b) => rank(a) - rank(b) || b.heartbeat - a.heartbeat)
  await update($, board, () => ({ sessions: all, updatedAt: now }))
}

const answer = async ($: $, target: SessionStatus, req: MonitorRequest, kind: AnswerKind, text?: string): Promise<void> => {
  const path = `${base}/answers/${target.sessionId}.json`
  const live = new Set(target.requests.map(r => r.id))
  const prev = (await readJson<Answer[]>($, path)) ?? []
  const kept = prev.filter(a => live.has(a.requestId) && a.requestId !== req.id)
  await $.fs.write(path, JSON.stringify([...kept, { requestId: req.id, at: Date.now(), kind, text }]))
  await update($, paneUi, u => ({ ...u, sent: [...u.sent, req.id].slice(-300) }))
  $.ui.toast(S.sentToast(target.title))
  if (target.sessionId === sessionId) await applyAnswers($)
}

const tick = async ($: $): Promise<void> => {
  if (ticking) return
  ticking = true
  try {
    await applyAnswers($)
    const me = (await desktopIndex($).catch(() => new Map<string, DesktopMeta>())).get(sessionId)
    label = me?.title?.trim() ?? ''
    effort = me?.effort ?? ''
    await publish($)
    if (isPaneOpen || isCoordinator) await gather($)
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
  `<rect width="1000" height="4" fill="#8080804D"/>` +
  `<rect width="${Math.round(clamp01(ratio) * 1000)}" height="4" fill="${color}"/></svg>`
/** "claude-opus-5-5" reads "Opus 5.5". */
const prettyModel = (id: string): string => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  return m?.[1] ? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}
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
const BLUE = '#5B8DEF'
const BLUE_TINT = '#5B8DEF33'
const ON_AMBER = '#1F1E1D'

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
    forwardAsks = (options.forwardQuestions as string | undefined) !== 'off'
    forward = forwardAsks && !isCoordinator
    // An ask left from before a reload has no hook waiting on it any more.
    await update($, local, cur => ({ ...cur, requests: cur.requests.filter(r => r.kind !== 'ask') }))
    const rulesFile = await readJson<RulesFile>($, `${base}/rules.json`)
    if (!rulesFile && (await $.fs.exists(`${base}/rules.json`).catch(() => false))) $.ui.toast(S.rulesBroken(`${base}/rules.json`))
    const compiled = compileRules(rulesFile)
    rules = compiled.rules
    critical = compiled.critical
    tierModels = { ...TIER_MODEL, ...(rulesFile?.tierModels ?? {}) }

    await $.command.register({ name: 'agents-monitor', description: 'Open the pane with every local session, its subagents and what waits for you' })
    $.clock.every(TICK_MS, () => void tick($))
    void tick($)
    if (isCoordinator) {
      const opened = await $.ui.open({ id: PANE, title: S.pane })
      isPaneOpen = opened.isPlaced
    }
    return started
  })

  on('session.end', async ($, e, next) => {
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
      isBusy = true
      // A new turn supersedes what the session asked last time, whether the answer came from
      // the pane or was typed in the session itself. Permissions stay: only the pane grants them.
      const asked = (r: MonitorRequest) => r.kind === 'questions' || r.kind === 'choice'
      if ((await read($, local)).requests.some(asked)) {
        await update($, local, cur => ({ ...cur, requests: cur.requests.filter(r => !asked(r)) }))
        void publish($)
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    isBusy = false
    if (forward && !e.isAborted) {
      const m = QUESTIONS_HEADING.exec(e.answer)
      if (m) {
        const rest = e.answer.slice(m.index + m[0].length)
        const end = rest.search(/^#{1,3}\s/m)
        const text = (end >= 0 ? rest.slice(0, end) : rest).trim()
        if (text) await addRequest($, { id: newId(), kind: 'questions', createdAt: Date.now(), text })
      }
    }
    void publish($)
    return done
  })

  // savvy-flow workers report their steps, the orchestrator its plan: keep a copy.
  on('tool.call', { tool: STEP_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    const input = e.input as { done?: number; total?: number; note?: string }
    if (e.agentId && typeof input.total === 'number') {
      const id = e.agentId
      await update($, local, cur => ({ ...cur, steps: { ...cur.steps, [id]: { done: input.done ?? 0, total: input.total ?? 0, note: input.note } } }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: FLOW_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    const input = e.input as { title?: string; total?: number; done?: number; phase?: string; finished?: boolean }
    if (!e.agentId) {
      await update($, local, cur => {
        if (input.finished) return { ...cur, flow: null }
        const prev = cur.flow ?? { title: '', done: 0, total: 0 }
        return { ...cur, flow: { title: input.title ?? prev.title, done: input.done ?? prev.done, total: input.total ?? prev.total, phase: input.phase ?? prev.phase } }
      })
    }
    return ran
  }).catch(($, e, next) => next(e))

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

  // The app's own permission dialog goes to the pane while someone is there to answer it: the
  // coordinator's pane, open. The session holds, as at the dialog, until the answer comes back;
  // with no answer in time, or no pane, the app's dialog asks as usual.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (!forwardAsks) return next(e)
    const what = askWhat(e.tool_input)
    if (what.length > ASK_MAX) return next(e)
    const key = askKey(e.tool_name, what)
    if ((await read($, local)).grantsSession.includes(key)) return { decision: { behavior: 'allow' } }
    if (!(isCoordinator ? isPaneOpen : await coordinatorLive($))) return next(e)
    const id = newId()
    await addRequest($, { id, kind: 'ask', createdAt: Date.now(), tool: e.tool_name, command: what, rule: S.appPermission })
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
    if (l.grantsSession.includes(command)) return { decision: 'allow', reason: 'approved for this session from the coordinator pane' }
    if (await takeOnce($, command)) return { decision: 'allow', reason: 'approved once from the coordinator pane' }
    const pending = l.requests.find(r => r.kind === 'permission' && r.command === command)
    const id = pending?.id ?? newId()
    if (!pending) {
      const crit = criticalIn(critical, command)
      await addRequest($, { id, kind: 'permission', createdAt: Date.now(), tool: e.tool, command, rule: crit ? `${rule.label} · ${crit}` : rule.label, agentId: e.agentId })
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

    const crab = (costume: string, alt: string, walking: boolean, dim = false): RenderChildren =>
      Svg ? <Svg source={crabSvg(costume, { isWalking: walking, isDim: dim, size: 30 })} alt={alt} width={30} height={CRAB_H(30)} /> : null
    const meter = (ratio: number, color: string, alt: string): RenderChildren =>
      Svg ? <Svg source={barSvg(ratio, color)} alt={alt} height={4} /> : <Text color={color}>{bar(ratio, Math.max(10, Math.min(40, cols - 16)))}</Text>
    const badge = (label: string, tone: 'amber' | 'blue' = 'amber'): RenderNode =>
      tone === 'amber' ? (
        <Text size="caption" weight="bold" color={isTerm ? 'warning' : ON_AMBER} backgroundColor={fill(AMBER)}>
          {` ${label} `}
        </Text>
      ) : (
        <Text size="caption" weight="semibold" color={BLUE} backgroundColor={fill(BLUE_TINT)}>
          {` ${label} `}
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

    const setFilter = (f: PaneUi['filter']) => () => void update($, paneUi, cur => ({ ...cur, filter: f }))
    const waitingCount = b.sessions.filter(s => s.state === 'waiting').length
    const limits = new Map<string, SessionStatus['rateLimits'][number]>()
    for (const s of [...b.sessions].sort((x, y) => x.heartbeat - y.heartbeat)) for (const r of s.rateLimits) limits.set(r.kind, r)
    const five = limits.get('five_hour')
    const week = limits.get('seven_day')
    const activeCount = b.sessions.filter(s => s.state === 'running' || s.state === 'waiting').length
    const runningAgents = b.sessions.reduce((n, s) => n + s.agents.filter(a => a.status === 'running').length, 0)
    const costs = b.sessions.map(s => s.costUsd).filter((c): c is number => typeof c === 'number')
    const ago = b.updatedAt ? Math.max(0, Math.round((Date.now() - b.updatedAt) / 1000)) : undefined


    // What waits for the person, newest last.
    const inbox: { s: SessionStatus; r: MonitorRequest }[] = []
    for (const s of b.sessions) for (const r of s.requests) if (!sent.has(r.id)) inbox.push({ s, r })
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
      const head = (label: string, what: string) => (
        <Box flexDirection="row" alignItems="center" gap="sm">
          {badge(label)}
          <Box flexGrow={1} flexShrink={1}>
            <Text weight="semibold" wrap="truncate-end">
              {what}
            </Text>
          </Box>
        </Box>
      )
      const shell = (children: RenderChildren) => (
        <Box key={r.id} flexDirection="column" gap="sm" padding="md" borderStyle="round" borderColor={isTerm ? 'warning' : AMBER_LINE} backgroundColor={fill(AMBER_TINT)}>
          {children}
        </Box>
      )
      if (r.kind === 'permission' || r.kind === 'ask') {
        return shell(
          <Box flexDirection="column" gap="sm">
            {head(S.permission, `${s.title} · ${r.tool ?? 'Bash'}`)}
            <Code source={r.command ?? ''} language={r.command?.startsWith('{') ? 'json' : r.tool === 'PowerShell' ? 'powershell' : 'bash'} />
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
                      paddingX="md"
                      paddingY="sm"
                      borderStyle="round"
                      borderColor={isOn ? (isTerm ? 'warning' : AMBER) : isTerm ? undefined : CARD_LINE}
                      borderDimColor={!isOn && isTerm}
                      backgroundColor={fill(isOn ? AMBER_TINT : CARD)}
                      hover={isTerm ? undefined : { borderColor: AMBER_LINE }}
                    >
                      <Button key={`${r.id}-${qi}-${oi}-b`} plain onPress={toggle(qi, oi, !!q.multiSelect)}>
                        {isTerm ? (isOn ? '● ' : '○ ') : ''}
                        <Text weight="semibold">{o.label}</Text>
                      </Button>
                      {o.description ? (
                        <Text size="footnote" color="subtle">
                          {o.description}
                        </Text>
                      ) : null}
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
      return shell(
        <Box flexDirection="column" gap="sm">
          {head(S.questions, s.title)}
          <Box flexDirection="column" padding="sm" backgroundColor={fill(CARD)}>
            {Markdown ? <Markdown key={`md-${r.id}`} text={r.text ?? ''} /> : <Text>{r.text ?? ''}</Text>}
          </Box>
          {Input ? (
            <Box flexDirection="column" gap="xs">
              <Text size="caption" color="subtle">
                {S.replyLabel}
              </Text>
              {field(<Input key={`reply-${r.id}`} placeholder={S.replyHere} rows={3} submitLabel={S.send} onSubmit={value => value.trim() && void answer($, s, r, 'answer', value)} />)}
            </Box>
          ) : null}
          <Box flexDirection="row" gap="sm">
            <Button key={`dismiss-${r.id}`} variant="secondary" label={S.dismiss} onPress={() => void answer($, s, r, 'dismiss')} />
          </Box>
        </Box>,
      )
    }

    const shown = b.sessions.filter(s =>
      u.filter === 'waiting' ? s.state === 'waiting' : u.filter === 'active' ? s.state === 'running' || s.state === 'waiting' : true,
    )

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
      const meta = [prettyModel(s.model), s.effort ? (S.effort[s.effort] ?? s.effort) : '', s.contextPct !== undefined ? `ctx ${fmtPct(s.contextPct)}` : '']
        .filter(Boolean)
        .join(' · ')
      const ask = s.requests[0]
      const asks = ask?.kind === 'permission' || ask?.kind === 'ask' ? S.waitsPermission(ask.command ?? '') : ask?.kind === 'choice' ? S.hasChoice : ask?.kind === 'questions' ? S.hasQuestions : ''
      const flow = s.flow ? `${s.flow.title} · ${s.flow.done}/${s.flow.total}${s.flow.phase ? ` · ${s.flow.phase}` : ''}` : ''
      const costume = s.state === 'waiting' ? 'waiting' : 'other'
      return (
        <Box key={s.sessionId} flexDirection="column" borderStyle="round" borderColor={isTerm ? undefined : s.state === 'waiting' ? AMBER_LINE : CARD_LINE} borderDimColor={isTerm} backgroundColor={fill(CARD)}>
          <Box flexDirection="row" gap="sm" alignItems="center" padding="sm">
            {crab(costume, s.title, s.state === 'running', s.state === 'ended' || s.state === 'idle')}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text weight="semibold">{s.title}</Text>
              <Text size="footnote" color="subtle" wrap="truncate-end">
                {flow || asks || who || s.folder || s.cwd}
              </Text>
            </Box>
            <Box flexDirection="column" alignItems="flex-end">
              {pill(s.state)}
              <Text size="caption" color="subtle">
                {meta}
              </Text>
            </Box>
            {s.agents.length ? (
              <Button
                key={`c-${s.sessionId}`}
                plain
                dimColor
                label={isCol ? `▸ ${s.agents.length}` : '▾'}
                onPress={() => void update($, paneUi, cur => ({ ...cur, collapsed: { ...cur.collapsed, [s.sessionId]: !isCol } }))}
              />
            ) : null}
          </Box>
          {!isCol &&
            s.agents.map(a => {
              const tier = tierOf(a.type)
              const color = TIER_COLOR[tier] ?? '#888780'
              const word = tier === 'other' ? a.type : tier === 'explore' ? 'Explore' : tier
              const ratio = a.status === 'done' ? 1 : a.stepTotal ? (a.stepDone ?? 0) / a.stepTotal : 0
              const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ` · ${a.stepNote}` : ''}` : ''
              const took = a.startedAt ? fmtDur((a.endedAt ?? Date.now()) - a.startedAt) : ''
              // Only this session's own subagents can be opened from here.
              const pick = () => void $.ui.view({ agentId: a.id }).then(r => r.deny && $.ui.toast(r.deny))
              const name = <Text weight="semibold">{a.description || a.type}</Text>
              // Each worker is a row of its own under the session's header, ruled off as in the mockup.
              return (
                <Box key={`${s.sessionId}-${a.id}`} flexDirection="column">
                  {rule}
                  <Box flexDirection="row" gap="sm" padding="sm" alignItems="flex-start">
                  {crab(tier === 'other' ? 'other' : tier, word, a.status === 'running')}
                  <Box flexDirection="column" flexGrow={1} flexShrink={1} gap="xs">
                    <Box flexDirection="row" gap="sm" justifyContent="space-between" alignItems="center">
                      {s.sessionId === sessionId ? (
                        <Button key={`a-${a.id}`} plain dimColor={a.status === 'idle'} onPress={pick}>
                          {name}
                        </Button>
                      ) : (
                        name
                      )}
                      <Text color={a.status === 'done' ? 'success' : a.status === 'failed' ? 'error' : a.status === 'running' ? BLUE : 'subtle'}>
                        {a.status === 'done' ? '✓' : a.status === 'failed' ? '✕' : a.status === 'running' ? '●' : '◷'}
                      </Text>
                    </Box>
                    <Box flexDirection="row" gap="sm" justifyContent="space-between">
                      <Text size="caption">
                        <Text color={color} weight="semibold">
                          {word}
                        </Text>
                        <Text color="subtle">{tierModels[tier] ? ` · ${tierModels[tier]}` : ''}</Text>
                      </Text>
                      <Text size="caption" color="subtle">
                        {took}
                      </Text>
                    </Box>
                    {steps ? (
                      <Text size="footnote" wrap="truncate-end">
                        {steps}
                      </Text>
                    ) : null}
                    {meter(ratio, a.status === 'done' ? '#3FB950' : color, `${Math.round(clamp01(ratio) * 100)}%`)}
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
            `${S.now} · ${activeCount} ${S.active.toLowerCase()} / ${b.sessions.length}`,
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
            {shown.map(sessionBlock)}
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
