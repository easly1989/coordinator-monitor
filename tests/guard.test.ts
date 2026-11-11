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

const BS = String.fromCharCode(92)
const took = (f: () => unknown): number => {
  const t = performance.now()
  f()
  return performance.now() - t
}

test('a glob in a command is read in linear time', () => {
  expect(took(() => sh('ls ' + '*'.repeat(2000)))).toBeLessThan(200)
  expect(took(() => sh('ls .' + '*'.repeat(2000) + '/x'))).toBeLessThan(200)
  expect(took(() => sh('ls ' + '{a,b}'.repeat(2000) + '/x'))).toBeLessThan(200)
  expect(took(() => sh('ls ' + '{'.repeat(2000) + '/x'))).toBeLessThan(200)
  expect(took(() => sh('ls ' + '[a'.repeat(2000) + '/x'))).toBeLessThan(200)
})

test('a class, a negated class and a brace that spell the folder are denied, one that does not stay quiet', () => {
  for (const cmd of [
    'cp x.txt ~/.cl[^x]ude/coordinator-monitor/rules.json',
    'cp x.txt ~/.cl[!x]ude/coordinator-monitor/rules.json',
    'cp x.txt ~/[.]claude/coordinator-monitor/rules.json',
    'cp x.txt ~/.cl[a-b]ude/coordinator-monitor/rules.json',
    'cp x.txt ~/.cl[a/coordinator-monitor/rules.json',
    'cp x.txt ~/.{cl,x}aude/coordinator-monitor/rules.json',
    'cp x.txt ~/{.claude/coord,x}inator-monitor/rules.json',
  ])
    expect(sh(cmd)).toBe(true)
  for (const cmd of ['cp x.txt ~/.cl[x]ude/other/a', 'mkdir -p {src,test}/foo', 'cp [d-f]*/x.txt .', 'ls .git*/hooks'])
    expect(sh(cmd)).toBe(false)
})

test('an 8.3 short name of the folder is the folder, in a shell command and in PowerShell', () => {
  expect(sh('echo P > ~/CLAUDE~1/COORDI~1/rules.json')).toBe(true)
  expect(sh('echo P > C:/Users/carlo/CLAUDE~2/COORDI~1/rules.json')).toBe(true)
  expect(sh(`Set-Content ~${BS}CLAUDE~1${BS}COORDI~1${BS}rules.json P`, 'PowerShell')).toBe(true)
  expect(sh('cd ~/CLAUDE~1 && echo P > COORDI~1/rules.json')).toBe(true)
  expect(sh('echo P > ~/CLAUDE~1/settings.json')).toBe(false)
})

test('a `.` at the end of a cd target is the same folder', () => {
  expect(sh('cd ~/.claude/. && echo P > coordinator-monitor/rules.json')).toBe(true)
  expect(sh('cd ~/.claude/./. && echo P > coordinator-monitor/rules.json')).toBe(true)
  expect(sh(`cd ~${BS}.claude${BS}. && echo P > coordinator-monitor${BS}rules.json`)).toBe(true)
  expect(sh('cd ~/.claude/. && echo P > settings.json')).toBe(false)
})

test('a device or a share prefix on a file tool path is the same path', () => {
  const p = `C:${BS}Users${BS}carlo${BS}CLAUDE~1${BS}COORDI~1${BS}rules.json`
  for (const prefix of [`${BS}${BS}.${BS}`, `${BS}${BS}?${BS}`, `${BS}${BS}localhost${BS}`]) {
    const path = prefix.endsWith('localhost' + BS) ? p.replace('C:', 'C$') : p
    for (const tool of ['Write', 'Edit']) expect(file(prefix + path, tool)).toBe(true)
  }
  expect(file(`${BS}${BS}.${BS}C:${BS}Users${BS}carlo${BS}.claude${BS}coordinator-monitor${BS}rules.json`)).toBe(true)
  expect(file(`${BS}${BS}?${BS}C:${BS}Users${BS}carlo${BS}.claude${BS}settings.json`)).toBe(false)
  // A bus folder outside .claude, behind an administrative share.
  const at = (file_path: string) => touchesBus({ tool: 'Write', input: { file_path }, isReadOnly: false }, 'D:/bus', HOME)
  expect(at(`${BS}${BS}localhost${BS}D$${BS}bus${BS}answers.json`)).toBe(true)
  expect(at(`${BS}${BS}?${BS}D:${BS}bus${BS}answers.json`)).toBe(true)
  expect(at(`${BS}${BS}?${BS}D:${BS}other${BS}a.json`)).toBe(false)
})

test('a path that only starts like the folder, a link inside a repo and a URL stay quiet', () => {
  for (const cmd of [
    'ls C:/repos/claude-*/README.md',
    'ln -s ../shared C:/repos/claude-environment/x',
    'curl "https://example.com/search?q=claude/code"',
    'du -sh .*/',
    'cp x C:/repos/claude-environment/docs/a.md',
  ])
    expect(sh(cmd)).toBe(false)
  expect(sh('ln -s ../shared C:/repos/x', 'Bash')).toBe(false)
})

test('a bare cd into the folder is denied, a cd elsewhere and a quoted mention are not', () => {
  expect(sh('cd ~/.claude/coordinator-monitor')).toBe(true)
  expect(sh('cd "~/.claude/coordinator-monitor"')).toBe(true)
  expect(sh("pushd '~/.claude/coordinator-monitor' && ls")).toBe(true)
  expect(sh('cd ~/.claude && cd coordinator-monitor')).toBe(true)
  expect(sh('cd ~/.claude && cat coordinator-notes.md')).toBe(false)
  expect(sh('cd ~/repos && echo "~/.claude/coordinator-monitor"')).toBe(false)
})

const CM = 'coordinator-monitor'

test('a link or a junction whose target is a glob is a link to the folder', () => {
  expect(sh(`ln -s ~/.claud? /tmp/x && echo P > /tmp/x/${CM}/rules.json`)).toBe(true)
  expect(
    sh(`New-Item -ItemType Junction -Path C:${BS}tmp${BS}j -Target (Resolve-Path ~${BS}.claud?); Set-Content C:${BS}tmp${BS}j${BS}${CM}${BS}rules.json x`, 'PowerShell'),
  ).toBe(true)
  expect(sh('ln -s a b')).toBe(false)
})

test('a brace sequence, a -f placeholder and an extglob are wildcards', () => {
  expect(sh(`echo P > ~/.cla{u..u}de/${CM}/rules.json`)).toBe(true)
  expect(sh(`Set-Content ("{0}${BS}.cl{1}${BS}${CM}${BS}rules.json" -f $HOME,'aude') x`, 'PowerShell')).toBe(true)
  expect(sh(`echo P > ~/.claude/@(coord*)/rules.json`)).toBe(true)
  expect(sh(`echo P > ~/.claude/+(coordinator)-monitor/rules.json`)).toBe(true)
  expect(sh('mkdir -p src/{a..c}')).toBe(false)
})

test('a copy, an extract or a cd into the .claude folder reaches the bus, a copy elsewhere does not', () => {
  for (const cmd of [
    `cp -r /tmp/t/${CM} ~/.claude/`,
    'tar -xf x.tar -C ~/.claude',
    `cd ~/.cl* && echo P > ${CM}/rules.json`,
    `cd ~/.claude && echo P>${CM}/rules.json`,
    `cd ~/.claude/skills/.. && echo P > ${CM}/rules.json`,
    'cd ~/.claude && cp x .',
    'unzip x.zip -d ~/.claude',
    '7z x a.7z -o~/.claude',
    'mv /tmp/t ~/.claude/',
    'cp -t ~/.claude /tmp/x',
  ])
    expect(sh(cmd)).toBe(true)
  for (const cmd of [`Copy-Item x -Destination ~${BS}.claude`, `robocopy C:${BS}tmp${BS}t C:${BS}Users${BS}carlo${BS}.claude /E`, `Expand-Archive x.zip -DestinationPath ~${BS}.claude`])
    expect(sh(cmd, 'PowerShell')).toBe(true)
  for (const cmd of [
    'ls ~/.claude',
    'cp x ~/.claude/skills/foo',
    'cp ~/.claude/settings.json /tmp/',
    'tar -xf x.tar -C /tmp/y',
    'unzip x.zip -d /tmp/q',
    'cd /tmp && echo P > a',
    'cd ~/.claude/skills && ls',
    'cd ~ && ls .*/',
  ])
    expect(sh(cmd)).toBe(false)
  expect(sh('Copy-Item a b', 'PowerShell')).toBe(false)
})

test('every regex family of the guard reads a 64 KB input in under 200 ms', () => {
  const big = (unit: string) => unit.repeat(Math.ceil(65536 / unit.length))
  for (const unit of ['cd ~/.claude ', 'cd -a ', 'cp ', 'cp x ~/.claude/y ', 'tar -xf a -C ', 'ln -s ', 'New-Item -ItemType Junction ', '~/.cl*/', '{a,b}', '{u..u}', '{0}', '@(a|b)', '.cl{1} ', '7z x a -o', 'xcopy ', 'copy ', 'cd ~/.claude/skills/.. ', 'mklink ']) {
    const s = big(unit)
    // The best of three runs: the suite runs files side by side, and one slow slice is not a slow regex.
    for (const tool of ['Bash', 'PowerShell']) expect(Math.min(took(() => sh(s, tool)), took(() => sh(s, tool)), took(() => sh(s, tool)))).toBeLessThan(200)
  }
})

// Round 9. The folder's names are spelt in pieces: this file is not a place to write them out.
const D = '.' + 'claude'

test('extracting or copying a tree over the base or one of its ancestors is denied', () => {
  for (const cmd of [
    'tar -xf /tmp/evil.tar -C ~',
    'cd ~ && tar -xf /tmp/evil.tar',
    `cp -r /tmp/e/${D} ~/`,
    'cp -R /tmp/e ~/',
    'cp -a /tmp/e ~',
    'rsync -a /tmp/e/ ~/',
    'unzip -o /tmp/e.zip -d ~',
    'cd ~ && unzip -o /tmp/e.zip',
    'cd ~ && rsync -a /tmp/e/ .',
    'cd ~ && cp -r /tmp/e .',
    'cd ~ && 7z x /tmp/e.7z',
    `cd C:/Users && tar -xf /tmp/evil.tar -C carlo`,
    'tar -xf /tmp/evil.tar -C C:/Users/carlo',
    'tar xf /tmp/evil.tar -C /c/Users/carlo',
  ])
    expect(sh(cmd)).toBe(true)
  for (const cmd of [
    `Expand-Archive /tmp/evil.zip -DestinationPath $HOME -Force`,
    `Expand-Archive /tmp/evil.zip -DestinationPath:$HOME -Force`,
    `Copy-Item -Recurse /tmp/e $HOME -Force`,
    `Set-Location ~; Expand-Archive /tmp/evil.zip -Force`,
  ])
    expect(sh(cmd, 'PowerShell')).toBe(true)
  for (const cmd of [
    'git push origin feat',
    'cp x ~/projects/foo',
    'cp x ~/',
    'tar -xf a.tar -C /tmp/x',
    'tar -cf a.tar ~/projects',
    'cd ~ && ls',
    'cd ~/projects && tar -xf /tmp/a.tar',
    'cd ~ && tar -xf /tmp/a.tar -C /tmp/y',
    'unzip -o /tmp/e.zip -d /tmp/q',
    'rsync -a /tmp/e/ ~/projects/e/',
    'cd /tmp && cp -r a b',
  ])
    expect(sh(cmd)).toBe(false)
  expect(sh('Expand-Archive a.zip -DestinationPath C:/tmp/q', 'PowerShell')).toBe(false)
})

test('chdir, cd /d and a colon-bound parameter move the shell like cd', () => {
  for (const cmd of [`cmd //c "cd /d %USERPROFILE%${BS}${D} && echo pwn > ${CM}${BS}answers${BS}x"`, `cmd //c "chdir /d %USERPROFILE%${BS}${D} && echo pwn > ${CM}${BS}answers${BS}x"`, `chdir ~/${D} && rm -rf ${CM}`]) expect(sh(cmd)).toBe(true)
  for (const cmd of [
    `cmd /c "cd /d %USERPROFILE%${BS}${D} && echo pwn > ${CM}${BS}answers${BS}x"`,
    `cmd /c "chdir /d %USERPROFILE%${BS}${D} && echo pwn > ${CM}${BS}answers${BS}x"`,
    `chdir $HOME${BS}${D}; Remove-Item -Recurse -Force ${CM}`,
    `Set-Location -Path:$HOME${BS}${D}; Remove-Item -Recurse -Force ${CM}`,
    `Set-Location -Path $HOME${BS}${D}; Remove-Item -Recurse -Force ${CM}`,
  ])
    expect(sh(cmd, 'PowerShell')).toBe(true)
  expect(sh('cd /d C:/tmp && echo a > b')).toBe(false)
  expect(sh(`chdir $HOME${BS}projects; Remove-Item -Recurse -Force build`, 'PowerShell')).toBe(false)
})

test('a substitution inside a word stands for any text', () => {
  for (const cmd of [`echo pwn > "$HOME/.cla$(echo)ude/${CM}/answers/x"`, `echo pwn > ~/.cla$(:)ude/${CM}/answers/x`, `echo pwn > ~/$(echo .cl)aude/${CM}/answers/x`, `echo pwn > ~/$(printf .claude)/${CM}/answers/x`])
    expect(sh(cmd)).toBe(true)
  for (const cmd of [`Set-Content "$HOME${BS}.cla$()ude${BS}${CM}${BS}rules.json" '{}'`, `Set-Content "$HOME${BS}$('.cla')ude${BS}${CM}${BS}rules.json" "{}"`])
    expect(sh(cmd, 'PowerShell')).toBe(true)
  for (const cmd of ['echo "$(date)/notes" > ~/log.txt', 'cp x "$(pwd)/y"', 'echo $(git rev-parse HEAD)/x > out.txt']) expect(sh(cmd)).toBe(false)
})

test('.. is collapsed at any depth, whatever the names before it hold', () => {
  for (const cmd of [
    `echo pwn > "$HOME/${D}/a b/../${CM}/answers/x"`,
    `echo pwn > ~/${D}/a/a/a/a/a/a/a/a/a/../../../../../../../../../${CM}/rules.json`,
    `echo pwn > "$HOME/${D}/a b/c d/../../${CM}/answers/x"`,
  ])
    expect(sh(cmd)).toBe(true)
  expect(sh(`Set-Content "$HOME${BS}${D}${BS}q r${BS}..${BS}${CM}${BS}rules.json" '{}'`, 'PowerShell')).toBe(true)
  expect(file(`C:/Users/carlo/${D}/a b/../${CM}/answers/x`)).toBe(true)
  expect(file(`C:/Users/carlo/${D}/a b/../../${D}/${CM}/rules.json`)).toBe(true)
  expect(sh(`echo ok > "$HOME/projects/a b/../c/x"`)).toBe(false)
  expect(file('C:/Users/carlo/projects/a b/../c/x')).toBe(false)
})

test('a PowerShell path built with .NET or joined at run time is denied', () => {
  for (const cmd of [
    `Set-Content ([System.IO.Path]::Combine($HOME,"${D}","${CM}","rules.json")) "{}"`,
    `Set-Content ([IO.Path]::Join($HOME,"${D}","${CM}","rules.json")) "{}"`,
    `Set-Content (Join-Path $HOME ('.cla','ude' -join '')) x`,
    `Set-Content (Join-Path (Join-Path $HOME $a) ($b + 'x')) x`,
  ])
    expect(sh(cmd, 'PowerShell')).toBe(true)
  for (const cmd of [`Set-Content ([IO.Path]::Combine($HOME,"projects","a.txt")) "{}"`, `Join-Path $HOME 'projects'`, '$n = 1 + 2; Get-Date']) expect(sh(cmd, 'PowerShell')).toBe(false)
})

test('a path too long or with too many parts is denied before the file system is asked, and no input is slow', () => {
  const long = (unit: string) => unit.repeat(Math.ceil(65536 / unit.length))
  expect(file(long('a/'))).toBe(true)
  expect(file(long('$HOME/'))).toBe(true)
  expect(file('$HOME/'.repeat(70))).toBe(true)
  expect(file(`C:/Users/carlo/projects/${'a/'.repeat(30)}x`)).toBe(false)
  for (const unit of ['a/', '$HOME/', '~/', 'a b/../', `${D}/`, '../', '$(', '$(echo)', 'cp -r a ~/ ; ', 'cd ~ && tar -xf a ; ', 'cd /d ', 'chdir ', '-path:', 'tar -xf a -C ~/ ; ', 'tar -C ', 'cp -t ', 'cp git -c "']) {
    const s = long(unit)
    // Best of three, stopping at the first run under the bound: the sum of 153 runs is otherwise near the runner's 5 s limit.
    for (const run of [() => file(s), () => sh(s), () => sh(s, 'PowerShell')]) expect([run, run, run].some(r => took(r) < 200)).toBe(true)
  }
})

test('round 10: a text that holds the bus path as written is a hit, whatever follows it', () => {
  // `..)x` is an ordinary name on Windows, not a `..`: the path is the bus folder's own.
  for (const cmd of [
    `echo pwned > ~/${D}/${CM}/..${BS})x/../answers/a.json`,
    `echo pwned > ~/${D}/${CM}/..${BS} x/../answers/a.json`,
    `echo pwned > "$HOME/${D}/${CM}/..)x/../answers/a.json"`,
    `echo pwned > "$HOME/${D}/${CM}/..;x/../answers/a.json"`,
  ])
    expect(sh(cmd)).toBe(true)
  expect(sh(`Set-Content -Path "$HOME${BS}${D}${BS}${CM}${BS}..)x${BS}..${BS}answers${BS}a.json" -Value x`, 'PowerShell')).toBe(true)
  expect(file(`C:${BS}Users${BS}carlo${BS}${D}${BS}${CM}${BS}..)x${BS}..${BS}answers${BS}a.json`)).toBe(true)
  // A `..` that is a whole segment still collapses.
  expect(sh('echo ok > ~/projects/a/../c/x')).toBe(false)
  expect(sh(`cd ~/${D}/skills/.. && cp x ${CM}/rules.json`)).toBe(true)
})

test('round 10: a drive colon is not an alternate data stream, in a custom bus folder', () => {
  const own = (command: string, tool = 'Bash') => touchesBus({ tool, input: { command }, isReadOnly: false }, 'D:/bus', HOME)
  for (const cmd of ['echo {} >>D:/bus/rules.json', 'cp evil.json --target-directory=D:/bus', 'echo {} > D:/bus/rules.json', 'echo {} >D:/x/../bus/rules.json', 'echo {} >D:/bus/sub/../rules.json'])
    expect(own(cmd)).toBe(true)
  expect(own(`Set-Content D:${BS}bus${BS}rules.json x`, 'PowerShell')).toBe(true)
  for (const cmd of ['echo {} >>D:/other/rules.json', 'cp a.json --target-directory=D:/work']) expect(own(cmd)).toBe(false)
})

test('round 10: a quoted word after a value flag is read in linear time', () => {
  const fill = (unit: string, head: string) => head + unit.repeat(Math.floor((65536 - head.length) / unit.length))
  for (const s of [fill(" -m '-x'", 'git commit'), fill(" -b '-x'", 'gh pr create'), fill(" -e '-x'", 'grep'), fill(" -m '-x' -m '-y'", 'git commit')])
    for (const run of [() => sh(s), () => sh(s, 'PowerShell')]) expect(Math.min(took(run), took(run), took(run))).toBeLessThan(200)
})
