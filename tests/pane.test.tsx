import { expect, test } from 'claude-code/testing'

import type { SessionStatus } from '../types'

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
    ],
  }
  const DOCS: Record<string, unknown> = {
    [`${DESK}/acct/org/local_other.json`]: { cliSessionId: 'other', title: 'Not me' },
    [`${DESK}/acct/org/local_me.json`]: { cliSessionId: 'me', title: 'Coordinatore', effort: 'high' },
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

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Home Server · Bash/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Migrate schema/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Update the console/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /62%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /waiting for a permission: git push origin main/ })).toBeTruthy()
    await ui.unmount()
  }
})
