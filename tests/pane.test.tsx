import { describe, expect, test, type TestBody } from 'claude-code/testing'

import type { SessionStatus } from '../types'

type TestOn = Parameters<TestBody>[1]

// The test environment has timers; the engine's lib types leave them out.
declare const setTimeout: (run: () => void, ms: number) => unknown

const PANE = {
  plugin: 'coordinator-monitor',
  component: 'Pane',
  requestId: 'coordinator-monitor',
  props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const now = Date.now()
const status = (over: Partial<SessionStatus>): SessionStatus => ({
  v: 1,
  sessionId: 's',
  title: 't',
  cwd: '/repos/t',
  model: 'claude-opus-5-5',
  state: 'idle',
  isCoordinator: false,
  heartbeat: now,
  startedAt: now,
  rateLimits: [],
  agents: [],
  flow: null,
  requests: [],
  ...over,
})

// Two sessions publishing: one waits on a permission and a choice, one runs a worker.
const FILES: Record<string, SessionStatus> = {
  'a.json': status({
    sessionId: 'a',
    title: 'Home Server',
    state: 'waiting',
    rateLimits: [{ kind: 'five_hour', percentUsed: 62, resetsAt: new Date(now + 3600_000).toISOString() }],
    requests: [
      { id: 'p1', kind: 'permission', createdAt: now, tool: 'Bash', command: 'git push origin main', rule: 'push to main' },
      {
        id: 'c1',
        kind: 'choice',
        createdAt: now + 1,
        questions: [{ question: 'Which way?', header: 'OAuth', options: [{ label: 'Update the console', description: 'with gcloud' }, { label: 'Code only' }] }],
      },
    ],
  }),
  'b.json': status({
    sessionId: 'b',
    title: 'Recipes',
    state: 'running',
    costUsd: 1.5,
    agents: [{ id: 'w1', type: 'savvy-medium', description: 'Migrate schema', status: 'running', stepDone: 2, stepTotal: 4, stepNote: 'events' }],
  }),
}

test('the pane draws sessions, workers and every kind of request, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'agents-monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: (e as { name?: string }).name === 'APPDATA' ? 'C:/AppData' : undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/repos/coordinator' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { rateLimits: [] } as never }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  const written: Record<string, string> = {}
  on('fs.write', (_, e) => {
    const w = e as { path?: string; text?: string }
    written[String(w.path ?? '').replace(/\\/g, '/')] = String(w.text ?? '')
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  // The desktop app's own record of this session, as it files it.
  const DESK = 'C:/AppData/Claude/claude-code-sessions'
  const DIRS: Record<string, never[]> = {
    [DESK]: [{ kind: 'dir', name: 'acct' } as never],
    [`${DESK}/acct`]: [{ kind: 'dir', name: 'org' } as never],
    [`${DESK}/acct/org`]: [
      { kind: 'file', name: 'local_other.json', mtimeMs: now } as never,
      { kind: 'file', name: 'local_me.json', mtimeMs: now - 1 } as never,
      { kind: 'file', name: 'local_a.json', mtimeMs: now - 2 } as never,
    ],
  }
  const DOCS: Record<string, unknown> = {
    [`${DESK}/acct/org/local_other.json`]: { cliSessionId: 'other', title: 'Not me' },
    [`${DESK}/acct/org/local_me.json`]: { cliSessionId: 'me', title: 'Coordinatore', effort: 'high' },
    // A session on an older copy of the mod publishes its folder name; the pane names it anyway.
    [`${DESK}/acct/org/local_a.json`]: { cliSessionId: 'a', title: 'HomeLab', effort: 'xhigh' },
  }
  const slash = (e: unknown): string => String((e as { path?: string }).path ?? '').replace(/\\/g, '/')
  on('fs.list', (_, e) => {
    const p = slash(e)
    return { value: DIRS[p] ?? (p.endsWith('/sessions') ? Object.keys(FILES).map(name => ({ kind: 'file', name, mtimeMs: now }) as never) : []) }
  })
  on('fs.read', (_, e) => {
    const p = slash(e)
    const doc = DOCS[p] ?? (p.includes('/sessions/') ? FILES[p.split('/').pop() ?? ''] : undefined)
    if (doc) return { value: JSON.stringify(doc) }
    throw new Error('ENOENT')
  })

  await $.session.start({ cwd: '/repos/coordinator', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'agents-monitor', args: '' } as never)

  // This session publishes the desktop's title and effort, not its folder name.
  for (let i = 0; i < 50 && !Object.keys(written).some(k => k.endsWith('/sessions/me.json')); i++) await new Promise<void>(r => setTimeout(r, 10))
  const mine = JSON.parse(Object.entries(written).find(([k]) => k.endsWith('/sessions/me.json'))?.[1] ?? '{}') as SessionStatus
  expect(mine.title).toBe('Coordinatore')
  expect(mine.folder).toBe('coordinator')
  expect(mine.effort).toBe('high')
  expect(mine.version).toBe('0.3.0')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /HomeLab · Bash/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Migrate schema/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Update the console/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /62%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5 · extra/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /waiting for a permission: git push origin main/ })).toBeTruthy()
    // The fixtures publish no version, as copies before 0.3 did: each is flagged.
    expect(await ui.find({ type: 'Text', text: /runs mod < 0\.3: \/reload-plugins there/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('a new turn retires the questions the session asked', async ($, on) => {
  const written: Record<string, string> = {}
  on('command.register', () => ({ value: { command: 'agents-monitor' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/repos/project' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.usage', () => ({ value: { rateLimits: [] } as never }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    written[e.path.replace(/\\/g, '/')] = e.text
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)

  const mine = (): SessionStatus => JSON.parse(Object.entries(written).find(([k]) => k.endsWith('/sessions/me.json'))?.[1] ?? '{}') as SessionStatus
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>(r => setTimeout(r, 5))
  }

  await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Done.\n\n## Questions for you\n\n1. Which port?', isAborted: false } as never)
  await settle()
  expect(mine().requests.map(r => r.kind)).toEqual(['questions'])

  // Carlo answers in the session itself: its next turn starts.
  await $.turn.start({ turnId: 't2' } as never)
  await settle()
  expect(mine().requests).toEqual([])
})
describe('the app asking for a permission', () => {
  // `file` is the name the coordinator's status file is listed under: anything but c.json poses as it.
  const setup = (on: TestOn, coordinator: boolean, file = 'c.json') => {
    const written: Record<string, string> = {}
    const COORD = JSON.stringify({ v: 1, sessionId: 'c', title: 'Coordinatore', cwd: '/c', model: 'm', state: 'running', isCoordinator: true, heartbeat: Date.now(), startedAt: 0, rateLimits: [], agents: [], flow: null, requests: [] })
    on('command.register', () => ({ value: { command: 'agents-monitor' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('env.get', () => ({ value: undefined }))
    on('settings.read', () => ({ value: {} }))
    on('session.id', () => ({ value: 'me' }))
    on('session.cwd', () => ({ value: '/repos/project' }))
    on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
    on('session.usage', () => ({ value: { rateLimits: [] } as never }))
    on('agent.list', () => ({ value: [] }))
    on('fs.exists', () => ({ value: false }))
    on('fs.list', (_, e) => ({ value: coordinator && e.path.replace(/\\/g, '/').endsWith('/sessions') ? [{ kind: 'file', name: file, mtimeMs: Date.now() } as never] : [] }))
    on('fs.read', (_, e) => {
      const p = e.path.replace(/\\/g, '/')
      if (coordinator && p.endsWith(`/sessions/${file}`)) return { value: COORD }
      if (written[p] !== undefined) return { value: written[p] }
      throw new Error('ENOENT')
    })
    on('fs.write', (_, e) => {
      written[e.path.replace(/\\/g, '/')] = e.text
      return { value: undefined }
    })
    on('clock.every', () => ({ value: undefined }))
    const mine = () => JSON.parse(Object.entries(written).find(([k]) => k.endsWith('/sessions/me.json'))?.[1] ?? '{}') as SessionStatus
    // The pane, while the session waits: what it saw on the card, and the answer it gives (none: no answer in time).
    const pane = { reply: undefined as string | undefined, seen: [] as string[] }
    on('process.run', (_, e) => {
      const ask = mine().requests.at(-1)
      pane.seen.push(ask?.command ?? '')
      // The engine resolves the mod's paths: the answers file sits beside the status file it wrote.
      const file = Object.keys(written).find(k => k.endsWith('/sessions/me.json'))?.replace('/sessions/', '/answers/')
      expect(file?.endsWith(String(e.init?.env?.CM_FILE).slice(1))).toBe(true)
      if (ask && file && pane.reply) written[file] = JSON.stringify([{ requestId: ask.id, at: Date.now(), kind: pane.reply }])
      return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    })
    return { mine, pane }
  }

  test('goes to the pane while a coordinator is there, and the session waits for the answer', async ($, on) => {
    const { mine, pane } = setup(on, true)
    let dialog = false
    on('classic.PermissionRequest', () => {
      dialog = true
      return { decision: { behavior: 'allow' } } as never
    })
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    type R = { decision?: { behavior: string } }
    pane.reply = 'approve-once'
    const r = (await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } } as never)) as R
    expect(r.decision?.behavior).toBe('allow')
    expect(dialog).toBe(false)
    expect(pane.seen).toEqual(['npm test'])
    expect(mine().requests).toEqual([])
    // Any field beyond the command is part of what is asked: it shows, and the answer covers it alone.
    pane.reply = 'deny'
    const d = (await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test', description: 'run tests', dangerouslyDisableSandbox: true } } as never)) as R
    expect(d.decision?.behavior).toBe('deny')
    expect(pane.seen[1]).toContain('"dangerouslyDisableSandbox": true')
    expect(pane.seen[1]).not.toContain('run tests')
    // No answer in time: the app's own dialog asks.
    pane.reply = undefined
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm run build' } } as never)
    expect(dialog).toBe(true)
    expect(mine().requests).toEqual([])
    // Too long to show whole: the dialog, without asking the pane.
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(9000) } } as never)
    expect(pane.seen.length).toBe(3)
  })

  test('a status file posing as another session does not count', async ($, on) => {
    setup(on, true, 'forged.json')
    let dialog = false
    on('classic.PermissionRequest', () => {
      dialog = true
      return { decision: { behavior: 'allow' } } as never
    })
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } } as never)
    expect(dialog).toBe(true)
  })

  test('keeps the dialog when no coordinator is there', async ($, on) => {
    setup(on, false)
    let dialog = false
    on('classic.PermissionRequest', () => {
      dialog = true
      return { decision: { behavior: 'allow' } } as never
    })
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } } as never)
    expect(dialog).toBe(true)
  })

  test('no session may write the pane answers itself', async ($, on) => {
    setup(on, true)
    on('tool.check', () => ({ decision: 'allow' }) as never)
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    const r = (await $.tool.check({ tool: 'Write', input: { file_path: 'C:\\Users\\x\\.claude\\coordinator-monitor\\answers\\me.json', content: '[]' }, tool_use_id: 'u1', isReadOnly: false } as never)) as { decision?: string }
    expect(r.decision).toBe('deny')
    // The mod's own source, and a read of the bus, stay allowed.
    const src = (await $.tool.check({ tool: 'Edit', input: { file_path: 'C:\\repos\\coordinator-monitor\\hooks\\register.tsx', old_string: 'a', new_string: '.claude/coordinator-monitor' }, tool_use_id: 'u2' } as never)) as { decision?: string }
    expect(src.decision).toBe('allow')
    const look = (await $.tool.check({ tool: 'Read', input: { file_path: 'C:\\Users\\x\\.claude\\coordinator-monitor\\sessions\\c.json' }, tool_use_id: 'u3', isReadOnly: true } as never)) as { decision?: string }
    expect(look.decision).toBe('allow')
  })
})