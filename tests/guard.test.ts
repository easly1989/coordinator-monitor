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

test('a file tool cannot reach the bus through a Windows alias of its path', () => {
  for (const p of [
    'C:\\Users\\carlo\\.claude\\COORDI~1\\rules.json',
    '~/.claude/a b/../coordinator-monitor/rules.json',
    '~/.claude::$INDEX_ALLOCATION/coordinator-monitor/rules.json',
    '~/.claude./coordinator-monitor/rules.json',
    '~/.claude/coordinator-monitor./rules.json',
    '~/.claude/coordinator-monitor /rules.json',
    '~/.claude/coordinator-monitor::$DATA',
  ])
    for (const tool of ['Write', 'Edit']) expect(file(p, tool)).toBe(true)
  // The rest of .claude stays editable.
  expect(file('~/.claude/settings.json')).toBe(false)
  expect(file('~/.claude/skills/x/SKILL.md', 'Edit')).toBe(false)
})

test('a file tool cannot reach the bus through a junction', () => {
  // Without a way to resolve the path (the host offers none), the bus folder's own entries are known by name.
  expect(file('C:/tmp/c/coordinator-monitor/answers/x.json')).toBe(true)
  expect(file('C:\\tmp\\c\\coordinator-monitor\\rules.json', 'Edit')).toBe(true)
  expect(file('C:/repos/coordinator-monitor/hooks/rules.ts')).toBe(false)
  // Where the runtime can resolve paths, a junction with any name is followed.
  const sys = (globalThis as { process?: { getBuiltinModule?: (n: string) => any } }).process
  const fs = sys?.getBuiltinModule?.('node:fs')
  const os = sys?.getBuiltinModule?.('node:os')
  const cp = sys?.getBuiltinModule?.('node:child_process')
  if (!fs || !os || !cp) return
  const root = fs.mkdtempSync(`${os.tmpdir()}\\cm-guard-`)
  try {
    const home = `${root}\\home`
    const base = `${home}\\.claude\\coordinator-monitor`
    fs.mkdirSync(`${base}\\answers`, { recursive: true })
    cp.execFileSync('cmd', ['/c', 'mklink', '/J', `${root}\\c`, `${home}\\.claude`], { stdio: 'ignore' })
    const at = (file_path: string) => touchesBus({ tool: 'Write', input: { file_path }, isReadOnly: false }, base.replace(/\\/g, '/'), home.replace(/\\/g, '/'))
    expect(at(`${root}/c/coordinator-monitor/answers/x.json`)).toBe(true)
    expect(at(`${root}\\c\\coordinator-monitor\\new\\deeper\\x.json`)).toBe(true)
    expect(at(`${root}/c/settings.json`)).toBe(false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a shell command cannot create a link that makes the bus reachable under another name', () => {
  for (const cmd of [
    'cmd /c mklink /J C:\\tmp\\c C:\\Users\\carlo\\.claude',
    'cmd //c mklink //J C:\\tmp\\c ~/.claude',
    'mklink /D C:\\tmp\\c C:\\Users\\carlo\\.claude\\coordinator-monitor',
    'ln -s ~/.claude /tmp/c',
    'ln -s $HOME/.claude/coordinator-monitor /tmp/c',
  ])
    expect(sh(cmd)).toBe(true)
  for (const cmd of [
    'New-Item -ItemType Junction -Path C:\\tmp\\c -Target $HOME\\.claude',
    'New-Item -ItemType SymbolicLink -Path C:\\tmp\\c -Target ~\\.claude\\coordinator-monitor',
    'New-Item -Path C:\\tmp\\c -ItemType HardLink -Value $env:USERPROFILE\\.claude\\x',
    'cmd /c mklink /J C:\\tmp\\c C:\\Users\\carlo\\.claude',
  ])
    expect(sh(cmd, 'PowerShell')).toBe(true)
  // Links that name nothing of the folder are not our business.
  expect(sh('ln -s /usr/bin/node ~/bin/node')).toBe(false)
  expect(sh('New-Item -ItemType Junction -Path C:\\tmp\\c -Target C:\\repos\\x', 'PowerShell')).toBe(false)
})

test('braces, tilde short names, joined strings and a glob that spells the folder are denied', () => {
  for (const cmd of [
    'echo x | tee ~/{.,}claude/coordinator-monitor/rules.json',
    'cd ~ && echo x | tee .claud[e]/coordinator-monitor/rules.json',
    'echo x | tee ~/.claud?/coordinator-monitor/rules.json',
    'echo x > ~/.claude/COORDI~1/rules.json',
    'cd ~/.claude && echo x > COORDI~1/rules.json',
  ])
    expect(sh(cmd)).toBe(true)
  for (const cmd of [
    `Set-Content ('~\\.claude\\coord'+"inator-monitor\\rules.json") x`,
    `Set-Content ("~\\.claude\\coord"+'inator-monitor\\rules.json') x`,
    'Set-Content ~\\.claude\\COORDI~1\\rules.json x',
  ])
    expect(sh(cmd, 'PowerShell')).toBe(true)
})

test('a message that only mentions the folder, and cd into .claude for something else, stay quiet', () => {
  for (const cmd of [
    'git commit -m "docs: bus lives in ~/.claude/coordinator-monitor"',
    "git commit -m 'docs: bus lives in ~/.claude/coordinator-monitor'",
    'echo "see ~/.claude/coordinator-monitor"',
    'cd .claude && git add settings.json && git commit -m "coordinator: tweak"',
    'cd ~/.claude && git add settings.json && git commit -m "coordinator: tweak"',
    'cd ~/.claude; git commit -m "coordinator-monitor update"',
    'cd ~/.claude && cat coordinator-notes.md',
  ])
    expect(sh(cmd)).toBe(false)
  // Still denied: the command, not the text, names the folder.
  expect(sh('git commit -m "x"; echo y > ~/.claude/coordinator-monitor/a')).toBe(true)
  expect(sh('git commit -m "$(echo y > ~/.claude/coordinator-monitor/a)"')).toBe(true)
  expect(sh('cat <<EOF > ~/.claude/coordinator-monitor/a\nx\nEOF')).toBe(true)
})
