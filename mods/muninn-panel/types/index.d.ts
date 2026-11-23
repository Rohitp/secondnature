export type ReceiptLine = { at: string; tool: string; kind: 'lesson' | 'handoff'; id: string; text: string; why: string; session: string | null }
export type Carried = { id: string; label: string; route: string; state: 'lit' | 'armed' | 'fading'; lastTold: string | null; global: boolean }
export type Waiting = { id: string; text: string; plain: string | null; origin: string; route: string; worth?: string | null }
export type PanelData = {
  repo: string | null
  repoShort: string
  branch: string | null
  dial: 'quiet' | 'start' | 'anytime'
  stats: { told: number; sessions: number; cameBack: number; costUsd: number | null }
  week: { sessions: number; mostTold: { label: string; sessions: number } | null; problems: { kept: number; cameBack: number }; handoffs: number; costUsd: number | null }
  receipt: ReceiptLine[]
  waiting: { count: number; top: Waiting[] }
  cameBack: { id: string; text: string; full?: string; verdict: string; fix: string | null }[]
  carry: Carried[]
  /** Commands that failed the same way 3 or more times in a row this session, newest first. */
  loops: { name: string; n: number; err: string; tokens: number; at: string; told: boolean; lesson?: { id: string; text: string; why: string } | null }[]
  /** The branch's plan in short. */
  plan: { goal: string | null; status: string | null; next: string[] } | null
  handoff: { text: string; age: string; tool: string; delivered: boolean } | null
  kept: number
  scanning: boolean
  sessionsHere: number
}
export type PanelView = { data: PanelData | null; error: string | null; marked: string[]; dismissed: string[] }

declare module 'claude-code' {
  interface PluginState {
    'muninn-panel': { view: Shaped<PanelView> }
  }
}
