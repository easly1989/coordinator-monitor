export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
  stepDone?: number
  stepTotal?: number
  stepNote?: string
  /** When this session first saw it run, and saw it finish (epoch ms). */
  startedAt?: number
  endedAt?: number
}

export type ChoiceOption = { label: string; description?: string }

export type ChoiceQuestion = {
  header?: string
  question: string
  multiSelect?: boolean
  options: ChoiceOption[]
}

/** `ask` is the app's own permission dialog, up in the session: shown, answered there. */
export type RequestKind = 'permission' | 'choice' | 'questions' | 'ask'

export type MonitorRequest = {
  id: string
  kind: RequestKind
  createdAt: number
  /** permission: the tool and the command it was asked to run. */
  tool?: string
  command?: string
  /** permission: why it is protected (the rule's label). */
  rule?: string
  /** choice: the questions as the model asked them. */
  questions?: ChoiceQuestion[]
  /** questions: the '## Questions for you' section, as markdown. */
  text?: string
  agentId?: string
}

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type FlowInfo = { title: string; done: number; total: number; phase?: string }

export type SessionState = 'running' | 'idle' | 'waiting' | 'ended'

export type SessionStatus = {
  v: 1
  sessionId: string
  /** The mod version that published it; absent before 0.3. */
  version?: string
  /** The sidebar title the desktop app gave the session, else the folder. */
  title: string
  /** The folder title (`project` or `project › worktree`). */
  folder?: string
  cwd: string
  model: string
  effort?: string
  state: SessionState
  isCoordinator: boolean
  heartbeat: number
  startedAt: number
  contextPct?: number
  costUsd?: number
  rateLimits: RateLimit[]
  agents: AgentRow[]
  flow: FlowInfo | null
  requests: MonitorRequest[]
}

/** `dismiss` drops a request without telling the session anything. */
export type AnswerKind = 'approve-once' | 'approve-session' | 'deny' | 'answer' | 'dismiss'

export type Answer = { requestId: string; at: number; kind: AnswerKind; text?: string }

export type Board = { sessions: SessionStatus[]; updatedAt: number }

export type Local = {
  requests: MonitorRequest[]
  grantsOnce: string[]
  grantsSession: string[]
  steps: Record<string, { done: number; total: number; note?: string }>
  flow: FlowInfo | null
  applied: string[]
}

export type PaneUi = {
  filter: 'all' | 'waiting' | 'active'
  collapsed: Record<string, boolean>
  picks: Record<string, number[]>
  sent: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'coordinator-monitor': {
      board: Shaped<Board>
      local: Shaped<Local>
      ui: Shaped<PaneUi>
    }
  }
}
