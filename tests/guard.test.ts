import { expect, test } from 'claude-code/testing'

import { touchesBus } from '../hooks/guard'

const HOME = 'C:/Users/carlo'
const BASE = `${HOME}/.claude/coordinator-monitor`
const sh = (command: string, tool = 'Bash', isReadOnly = false) => touchesBus({ tool, input: { command }, isReadOnly }, BASE, HOME)
const file = (file_path: string, tool = 'Write') => touchesBus({ tool, input: { file_path }, isReadOnly: false }, BASE, HOME)

test('a shell command cannot build the bus path out of pieces the text does not name', () => {
  for (const cmd of [
    // Named plainly, in every spelling of the home folder and of the separators.
    'echo x > ~/.claude/coordinator-monitor/answers.json',
    'echo x > $HOME/.claude/coordinator-monitor/answers.json',
    'echo x > ${HOME}/.claude/coordinator-monitor/answers.json',
    'echo x > ~/.CLAUDE/Coordinator-Monitor//./answers.json',
    'echo x > C:\\Users\\carlo\\.claude\\coordinator-monitor\\answers.json',
    'echo x > ~/.claude/old/../coordinator-monitor/answers.json',
    // Quotes and escapes inside a word.
    'echo x > ~/.claude/coord""inator-monitor/a',
    "echo x > ~/.claude/'coordinator'-monitor/a",
    'echo x > ~/.claude/coord\\inator-monitor/a',
    'echo x > C:\\Users\\carlo\\.claude\\coord""inator-monitor\\a',
    // A glob, a variable or a substitution in the segment after .claude, or in .claude itself.
    'echo x > $HOME/.claude/c*-monitor/a',
    'echo x > ~/.claude/coordinator-m?nitor/a',
    'X=coord; echo x > ~/.claude/${X}inator-monitor/a',
    'echo x > ~/.claude/$(echo coordinator)-monitor/a',
    'echo x > ~/.claude/`echo coordinator`-monitor/a',
    'echo x > ~/.cl*/coordinator-monitor/a',
    // cd into .claude, then the folder by a relative name.
    'cd ~/.claude && cd coordinator-monitor && echo x > answers.json',
    'cd ~/.claude; echo x > ./coordinator-monitor/answers.json',
    'pushd $HOME/.claude && tee coordinator-monitor/rules.json',
    'cd ~ && cd .claude && cd "coordinator-monitor" && rm answers.json',
  ])
    expect(sh(cmd)).toBe(true)
})

test('a PowerShell command cannot build the bus path either', () => {
  for (const cmd of [
    'Set-Content $env:USERPROFILE\\.claude\\coordinator-monitor\\a x',
    'Set-Content "$env:userprofile\\.claude\\coordinator-monitor\\a" x',
    'Set-Content %USERPROFILE%\\.claude\\coordinator-monitor\\a x',
    "Set-Content (Join-Path (Join-Path $env:USERPROFILE '.claude') 'coordinator-monitor\\a') x",
    "Set-Content (Join-Path $env:USERPROFILE '.claude\\coordinator-monitor') x",
    'Set-Content ~\\.claude\\coord`inator-monitor\\a x',
    "Set-Content ('~\\.claude\\coord' + 'inator-monitor\\a') x",
    'Set-Location $env:USERPROFILE\\.claude; Set-Content coordinator-monitor\\a x',
    'Set-Content ~\\.claude\\$name\\a x',
  ])
    expect(sh(cmd, 'PowerShell')).toBe(true)
})

test('a file tool is judged by its target path, and the bus folder is denied under any base', () => {
  expect(file('C:\\Users\\carlo\\.claude\\coordinator-monitor\\answers.json')).toBe(true)
  expect(file('~/.claude/coordinator-monitor/rules.json', 'Edit')).toBe(true)
  expect(touchesBus({ tool: 'Write', input: { file_path: 'D:\\bus\\answers.json' } }, 'D:/bus', HOME)).toBe(true)
  expect(touchesBus({ tool: 'Bash', input: { command: 'echo x > D:/bu""s/answers.json' } }, 'D:/bus', HOME)).toBe(true)
  expect(touchesBus({ tool: 'Bash', input: { command: 'echo x > ~/bus/a' } }, `${HOME}/bus`, HOME)).toBe(true)
})

test('reading the bus, the mod source in the repo and the repo itself stay allowed', () => {
  // Read-only calls are never judged.
  expect(sh('cat ~/.claude/coordinator-monitor/answers.json', 'Bash', true)).toBe(false)
  expect(sh('cat ~/.claude/c*-monitor/answers.json', 'Bash', true)).toBe(false)
  // The mod's own source and docs.
  expect(file('C:\\repos\\coordinator-monitor-wt-071\\hooks\\register.tsx')).toBe(false)
  expect(file('C:/repos/coordinator-monitor/hooks/register.tsx', 'Edit')).toBe(false)
  expect(file('C:\\repos\\coordinator-monitor-wt-071\\README.md')).toBe(false)
  for (const cmd of [
    'git -C C:/repos/coordinator-monitor-wt-071 status',
    'cd C:/repos/coordinator-monitor-wt-071 && git add -A && git commit -m "fix: guard"',
    'cd ~/.claude && git -C C:/repos/coordinator-monitor-wt-071 status',
    'cd ~/.claude && cd C:/repos/coordinator-monitor && bun test',
    'sed -i s/a/b/ hooks/register.tsx',
    'mkdir -p ~/.claude/skills/$name && cp x ~/.claude/skills/y',
    'cp x ~/.claude/settings.json',
    'rm -rf node_modules/.cache/*',
  ])
    expect(sh(cmd)).toBe(false)
  expect(sh('git -C C:/repos/coordinator-monitor-wt-071 status', 'PowerShell')).toBe(false)
  expect(sh('Set-Location C:\\repos\\coordinator-monitor-wt-071; Set-Content hooks\\a.ts x', 'PowerShell')).toBe(false)
})
