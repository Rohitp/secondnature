import { expect, test } from 'claude-code/testing'

// Made-up panel data in the shape `muninn panel` prints.
const DATA = {
  repo: 'github.com/example/shop', repoShort: 'shop', branch: 'main', dial: 'anytime',
  sent: [], handoff: null, loops: [], kept: 1, scanning: false, sessionsHere: 4,
  stats: { told: 1, sessions: 1, cameBack: 0, costUsd: 0.1 }, lastToldAt: null,
  receipt: [{ at: '2026-11-16T13:46:00.000Z', tool: 'claude-code', kind: 'lesson', id: 'l1', text: 'Keep deletions out of inline scripts.', why: 'always-on, at session start', session: 's1' }],
  waiting: { count: 1, top: [{ id: 'w1', text: 'Fix lint errors before re-running the checks.', plain: 'Your agents will fix lint errors before re-running the checks.', origin: 'Learned from a command that failed and was then fixed, in Claude Code, 16 Nov', route: 'when "ruff" comes up' }] },
  cameBack: [], carry: [{ id: 'l1', label: 'Keep deletions out of inline scripts', route: 'every session', state: 'lit', lastTold: '2026-11-16T13:46:00.000Z', global: false }],
  week: { sessions: 2, mostTold: null, problems: { kept: 1, cameBack: 0 }, handoffs: 1, costUsd: 0.12 },
  plan: { goal: 'Ship the checkout page.', status: 'Cart works; payment form is next.', next: ['Build the payment form', 'Add a receipt email'] },
}

const PANE = {
  plugin: 'muninn-panel',
  component: 'Pane',
  requestId: 'muninn',
  props: { title: 'muninn', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

async function start($: any, on: any, data: unknown, exitCode = 0) {
  on('command.register', () => ({ value: { command: 'muninn' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/x' }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode, stdout: exitCode ? '' : JSON.stringify(data), stderr: exitCode ? 'spawn muninn ENOENT' : '' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/x', surface: 'desktop', isInteractive: true })
}

test('a lesson to review is the one thing on top, on every surface', async ($, on) => {
  await start($, on, DATA)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /A new lesson to review/ }))?.text).toBe('A new lesson to review')
    expect(await ui.find({ type: 'Button', key: 'keep-w1' })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^Where you left off/i }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^Lessons were told in 2 sessions this week/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^Told this session · 1/i }))).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'helped-l1' })).toBeTruthy()
    await ui.unmount()
  }
})

test('a loop happening now goes on top, by its short name', async ($, on) => {
  await start($, on, { ...DATA, loops: [{ name: 'ruff format', n: 3, err: '<n> files would be reformatted', tokens: 4200, at: new Date().toISOString(), told: true }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /failed 3 times the same way/ }))?.text).toBe('ruff format failed 3 times the same way.')
  expect(await ui.find({ type: 'Text', text: /A new lesson to review/ })).toBeFalsy()
  await ui.unmount()
})

test('a kept lesson that fits a loop but was never told: one button tells the agent now', async ($, on) => {
  await start($, on, { ...DATA, loops: [{ name: 'pytest', n: 3, err: 'ModuleNotFoundError', tokens: 900, at: new Date().toISOString(), told: false, lesson: { id: 'k1', text: 'Run Python through poetry run python.', why: 'this session started before you kept it' } }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /pytest failed the same way 3 times in this session/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /It wasn't told, because this session started before you kept it/ }))).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'tell-k1' })).toBeTruthy()
  await ui.unmount()
})

test('first run: nothing learned yet, with one button to check', async ($, on) => {
  await start($, on, { ...DATA, waiting: { count: 0, top: [] }, kept: 0, receipt: [], carry: [], cameBack: [] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Nothing to tell your agent yet/ }))).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'scan' })).toBeTruthy()
  await ui.unmount()
})

test("when muninn can't run, says the hooks still work and how to fix it", async ($, on) => {
  await start($, on, null, 1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /can't run muninn/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /npm link/ }))).toBeTruthy()
  await ui.unmount()
})
