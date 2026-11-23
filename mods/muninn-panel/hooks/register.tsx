import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { PanelData, PanelView } from '../types'

// The "Claude Code side panel" board of the secondnature design canvas (Workbench family): the one thing to do now on
// top with the only solid button, then what this session was told and why, where you left off, new lessons, the week. Colors are the app's own,
// so light and dark follow it: 'suggestion' is muninn's blue, 'warning' is "a loop" or "the problem came back".
const PANE = 'muninn'
const ACCENT = 'suggestion'
const SIGNAL = 'warning'
// The setting answers one question: when should muninn speak up to your agents?
const DIAL_LABEL = { quiet: 'only when asked', start: 'at session start', anytime: 'whenever relevant' } as const
/** How recent a loop must be to go on top: older ones are history. */
const LOOP_FRESH_MS = 30 * 60_000

// Change the tag when PanelView's fields change, so a value stored by an older version is dropped.
const view = atom({ plugin: 'muninn-panel', key: 'view' } as const, { data: null, error: null, marked: [], dismissed: [] } as PanelView, { shape: 'view-4' })

/** Runs the muninn CLI. It must be on the PATH Claude Code was started with. */
async function muninn($: any, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await $.process.run(['muninn', ...args], { timeoutMs: 15_000, env: { MUNINN_INTERNAL: '1' } })
    return { ok: r.exitCode === 0, out: (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout).trim() }
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) }
  }
}

async function refresh($: any) {
  const [session, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
  const r = await muninn($, ['panel', '--session', session, '--cwd', cwd])
  if (!r.ok) {
    await update($, view, v => ({ ...v, error: /ENOENT|not found/i.test(r.out) ? 'missing' : r.out.slice(0, 300) }))
    return
  }
  let data: PanelData
  try { data = JSON.parse(r.out) } catch { await update($, view, v => ({ ...v, error: 'muninn returned something unexpected.' })); return }
  await update($, view, v => ({ ...v, data, error: null }))
  $.ui.status(data.receipt.length ? `secondnature · told ${data.receipt.length}` : undefined)
}

/** Runs an action, says what happened in one line, and redraws. */
async function act($: any, args: string[], done?: string) {
  const r = await muninn($, args)
  $.ui.toast(r.ok ? (done ?? r.out.split('\n')[0] ?? 'Done.') : `muninn: ${r.out.split('\n')[0]}`)
  await refresh($)
}

const time = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago` }
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** The week in a sentence or two: numbers live in sentences. */
function weekSentence(w: PanelData['week']): string {
  const parts = [w.sessions ? `Lessons were told in ${plural(w.sessions, 'session')} this week.` : 'Nothing was told to your agents this week.']
  if (w.problems.kept) parts.push(w.problems.cameBack ? `${w.problems.cameBack} of the ${plural(w.problems.kept, 'problem')} you kept a lesson for came back.` : `None of the ${plural(w.problems.kept, 'problem')} you kept a lesson for came back.`)
  if (w.costUsd != null) parts.push(`secondnature's calls to your Claude cost $${w.costUsd.toFixed(2)}.`)
  return parts.join(' ')
}
/** Why a line was told, as the end of a sentence starting "Because". */
function because(why: string, kind: string): string {
  if (kind === 'handoff') return 'it was the first session on this branch since the last one ended.'
  if (why === 'always-on, at session start') return 'the session started. Told every session.'
  if (why === 'always-on, sent again after compaction') return 'the conversation was compacted, so every-session lessons were told again.'
  if (why === 'always-on, for a subagent') return 'a subagent started. Told every session.'
  if (why === 'always-on, read from CLAUDE.local.md') return 'the session started and read it from CLAUDE.local.md.'
  if (why === 'after a failed command') return 'a command failed the way it has before.'
  return why.replace(/\.?$/, '.')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'muninn', description: 'Show what secondnature told this session, and why' })
    void $.ui.open({ id: PANE, title: 'secondnature' })
    void refresh($)
    // Hooks deliver during a turn; the panel catches up when the turn ends and every half minute.
    $.clock.every(30_000, () => refresh($))
    return next(e)
  })

  on('command.run', { command: 'muninn' }, async $ => {
    await $.ui.open({ id: PANE, title: 'secondnature' })
    await refresh($)
    return { text: 'secondnature panel opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const { data, error, marked, dismissed } = await read($, view)
    const caption = (text: string, color?: string) => <Text size="caption" weight="medium" color={color} dimColor={!color}>{text.toUpperCase()}</Text>

    if (error) {
      const missing = error === 'missing'
      return (
        <Box flexDirection="column" gap="sm" padding="md">
          <Text weight="semibold">secondnature</Text>
          <Text weight="semibold" color={SIGNAL}>The panel can't run muninn.</Text>
          <Text wrap="wrap">{missing ? 'Claude Code couldn\'t find the muninn command. Your agents are still told lessons through the hooks; only this panel is affected.' : error}</Text>
          {missing && <Text dimColor size="footnote" wrap="wrap">To fix it, run npm link in the muninn folder, then start a new session.</Text>}
          {!missing && <Text dimColor size="footnote" wrap="wrap">Run muninn status in a terminal to see what's wrong.</Text>}
          <Box flexDirection="row"><Button key="retry" variant="secondary" label="Try again" onPress={() => refresh($)} /></Box>
        </Box>
      )
    }
    if (!data) return <Box padding="md"><Text dimColor>Loading…</Text></Box>

    const session = await $.session.id()
    const mark = (id: string) => update($, view, v => ({ ...v, marked: [...v.marked, id].slice(-50) }))
    const dismiss = (id: string) => update($, view, v => ({ ...v, dismissed: [...v.dismissed, id].slice(-50) }))

    // The one thing to do now, in order: a loop happening now, a kept problem that came back, a lesson to review.
    const loop = data.loops.find(l => Date.now() - Date.parse(l.at) < LOOP_FRESH_MS && !dismissed.includes(`loop:${l.name}:${l.at}`))
    const back = data.cameBack.find(c => !dismissed.includes(`back:${c.id}`))
    const lesson = data.waiting.top[0]
    const firstRun = !loop && !back && !lesson && !data.kept && !data.receipt.length

    const header = (
      <Box key="header" flexDirection="column" gap="sm">
        <Box flexDirection="row" gap="sm" alignItems="center">
          <Text weight="semibold">secondnature</Text>
          <Box flexGrow={1} flexShrink={1}><Text dimColor size="footnote" wrap="truncate-end">{data.repoShort}{data.branch ? ` · ${data.branch}` : ''}</Text></Box>
        </Box>
        {/* The setting on a row of its own: beside the name it doesn't fit a narrow pane. */}
        <Box flexDirection="column" gap="xs">
          <Text dimColor size="footnote">Speaks up to this session</Text>
          <Select
            key="dial"
            value={data.dial}
            options={(Object.keys(DIAL_LABEL) as (keyof typeof DIAL_LABEL)[]).map(k => ({ value: k, label: DIAL_LABEL[k] }))}
            onSelect={v => act($, ['dial', v], `secondnature now speaks up ${DIAL_LABEL[v as keyof typeof DIAL_LABEL]} here.`)}
          />
        </Box>
      </Box>
    )

    const card = (color: string | undefined, children: any) => (
      <Box key="todo" flexDirection="column" gap="sm" padding="md" borderStyle="round" borderColor={color ?? 'subtle'}>{children}</Box>
    )
    let todo: any = null
    let todoIsLesson = false
    if (loop && loop.lesson) {
      // A kept lesson fits this loop but this session never got it: offer to tell it now.
      const l = loop.lesson
      const queued = marked.includes(`tell:${l.id}`)
      todo = card(SIGNAL, [
        caption('To do now', SIGNAL),
        <Text key="t" weight="semibold" wrap="wrap">{loop.name} failed the same way {loop.n} times in this session</Text>,
        <Text key="l" wrap="wrap">A lesson you kept says: {l.text}</Text>,
        <Text key="w" dimColor size="footnote" wrap="wrap">It wasn't told, because {l.why}.</Text>,
        queued
          ? <Text key="q" color={ACCENT} weight="semibold" wrap="wrap">Queued. It reaches the agent with your next message.</Text>
          : (
            <Box key="b" flexDirection="row" gap="sm">
              <Button key={`tell-${l.id}`} variant="primary" label="Tell the agent now" onPress={async () => { await mark(`tell:${l.id}`); await act($, ['tell', l.id, '--session', session], 'Queued. The agent is told it with your next message.') }} />
              <Button key="loop-later" variant="secondary" label="Not now" onPress={() => dismiss(`loop:${loop.name}:${loop.at}`)} />
            </Box>
          ),
      ])
    } else if (loop) {
      todo = card(SIGNAL, [
        caption(`Loop caught · ${ago(loop.at)}`, SIGNAL),
        <Text key="t" weight="semibold" wrap="wrap">{loop.name} failed {loop.n} times the same way.</Text>,
        loop.err ? <Text key="e" dimColor size="footnote" wrap="wrap">Same error each time: {loop.err}</Text> : null,
        loop.told ? <Text key="told" wrap="wrap">secondnature told your agent to stop retrying and read the error.</Text> : null,
        loop.tokens > 200 ? <Text key="cost" dimColor size="footnote">About {loop.tokens.toLocaleString('en-GB')} tokens went on the repeats.</Text> : null,
        <Box key="b" flexDirection="row" gap="sm">
          <Button key="loop-scan" variant="primary" label={data.scanning ? 'Checking…' : 'Find a lesson in it'} onPress={() => act($, ['scan'])} />
          <Button key="loop-later" variant="secondary" label="Not now" onPress={() => dismiss(`loop:${loop.name}:${loop.at}`)} />
        </Box>,
      ])
    } else if (back) {
      todo = card(SIGNAL, [
        caption('The problem came back', SIGNAL),
        <Text key="t" weight="semibold" wrap="wrap">{back.full ?? back.text}</Text>,
        <Text key="v" dimColor size="footnote" wrap="wrap">{back.verdict}</Text>,
        <Box key="b" flexDirection="row" gap="sm">
          {back.fix === 'always-on' && <Button key={`fix-${back.id}`} variant="primary" label="Tell it every session" onPress={() => act($, ['edit', back.id, '--always-on'], 'Told every session now.')} />}
          <Button key={`leave-${back.id}`} variant="secondary" label="Leave it" onPress={() => dismiss(`back:${back.id}`)} />
        </Box>,
      ])
    } else if (lesson) {
      todoIsLesson = true
      todo = card(undefined, [
        caption(data.waiting.count > 1 ? `To do now · 1 of ${data.waiting.count}` : 'To do now'),
        <Text key="h" weight="semibold">A new lesson to review</Text>,
        <Text key="t" wrap="wrap">{lesson.plain ?? lesson.text}</Text>,
        <Text key="why" dimColor size="footnote" wrap="wrap">{lesson.origin}. Agents aren't told until you keep it.</Text>,
        lesson.worth ? <Text key="worth" dimColor size="footnote" wrap="wrap">{lesson.worth}</Text> : null,
        <Text key="route" dimColor size="footnote">If kept: told {lesson.route}.</Text>,
        <Box key="b" flexDirection="row" gap="sm" alignItems="center">
          <Button key={`keep-${lesson.id}`} variant="primary" hotkey="1" label="Keep" onPress={() => act($, ['keep', lesson.id], 'Kept. Agents are told from their next session.')} />
          <Button key={`reject-${lesson.id}`} variant="secondary" hotkey="2" label="Don't keep" onPress={() => act($, ['reject', lesson.id], "Not kept. secondnature won't suggest it again.")} />
        </Box>,
      ])
    } else if (firstRun) {
      todo = (
        <Box key="first" flexDirection="column" gap="sm">
          <Text weight="semibold">Nothing to tell your agent yet.</Text>
          <Text wrap="wrap">secondnature reads your sessions and suggests lessons from what you repeat, correct, or what keeps failing. It also keeps a short summary of where each branch stands.</Text>
          <Text dimColor size="footnote" wrap="wrap">{data.sessionsHere ? `It has seen ${plural(data.sessionsHere, 'session')} here. ` : ''}Suggestions usually start after 2 or 3.</Text>
          <Box flexDirection="row"><Button key="scan" variant="primary" label={data.scanning ? 'Checking your sessions…' : 'Check my sessions now'} onPress={() => act($, ['scan'])} /></Box>
        </Box>
      )
    }

    const told = (
      <Box key="told" flexDirection="column" gap="sm">
        {caption(`Told this session · ${data.receipt.length}`)}
        {data.receipt.length === 0 && (
          <Text dimColor size="footnote" wrap="wrap">{data.dial === 'quiet' ? 'Nothing: secondnature speaks only when asked.' : 'Nothing yet. secondnature speaks at the start, and when a word or a failed command matches.'}</Text>
        )}
        {data.receipt.slice(0, 6).map(x => (
          <Box key={`${x.kind}-${x.id}`} flexDirection="column" gap="xs">
            <Text weight="medium" wrap="wrap">{x.kind === 'handoff' ? `Where you left off${data.branch ? ` on ${data.branch}` : ''}.` : x.text}</Text>
            <Text dimColor size="footnote" wrap="wrap">Because {because(x.why, x.kind)}</Text>
            {x.kind === 'lesson' && (marked.includes(x.id)
              ? <Text dimColor size="footnote">Noted, thanks.</Text>
              : (
                <Box flexDirection="row" gap="sm">
                  <Button key={`helped-${x.id}`} variant="secondary" label="Helped" onPress={async () => { await mark(x.id); await act($, ['feedback', x.id, 'helped', '--session', session], 'Noted: it helped.') }} />
                  <Button key={`wrong-${x.id}`} variant="secondary" label="Wrong" onPress={async () => { await mark(x.id); await act($, ['feedback', x.id, 'wrong', '--session', session]) }} />
                </Box>
              ))}
          </Box>
        ))}
      </Box>
    )

    const plan = data.plan ?? (data.handoff ? { goal: null, status: data.handoff.text.split('\n')[0] ?? null, next: [] } : null)
    const leftOff = plan && (
      <Box key="plan" flexDirection="column" gap="xs">
        {caption('Where you left off')}
        {plan.goal && <Text weight="semibold" wrap="wrap">Goal: {plan.goal}</Text>}
        {!plan.goal && plan.status && <Text wrap="wrap">{plan.status}</Text>}
        {plan.next.length > 0 && <Text dimColor wrap="wrap">Next: {plan.next[0]}</Text>}
      </Box>
    )

    const waiting = !todoIsLesson && data.waiting.count > 0 && (
      <Box key="waiting" flexDirection="column" gap="xs">
        {caption(`New lessons · ${data.waiting.count}`)}
        <Text dimColor size="footnote" wrap="wrap">Agents aren't told these until you keep them.</Text>
        <Box flexDirection="row"><Button key="review-all" plain label="Review in secondnature ↗" onPress={() => act($, ['ui', '--detach'], 'Opened secondnature in your browser.')} /></Box>
      </Box>
    )

    const week = (
      <Box key="week" flexDirection="column" gap="xs">
        {caption('This week')}
        <Text dimColor size="footnote" wrap="wrap">{weekSentence(data.week)}</Text>
        {todoIsLesson && data.waiting.count > 1 && <Box flexDirection="row"><Button key="review-more" plain label={`Review all ${data.waiting.count} in secondnature ↗`} onPress={() => act($, ['ui', '--detach'], 'Opened secondnature in your browser.')} /></Box>}
      </Box>
    )

    return (
      <Box flexDirection="column" gap="lg" padding="md">
        {header}
        {todo}
        {told}
        {leftOff}
        {waiting}
        {week}
      </Box>
    )
  })
}
