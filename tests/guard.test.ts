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
/** The best of up to three runs, stopping at the first fast one: the suite runs files side by side. */
const fast = (f: () => unknown): number => {
  let best = took(f)
  for (let k = 0; k < 2 && best >= 200; k++) best = Math.min(best, took(f))
  return best
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
    for (const tool of ['Bash', 'PowerShell']) expect(fast(() => sh(s, tool))).toBeLessThan(200)
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

test('round 11: an alternate-data-stream strip is linear, and a glob, a custom bus and a read of the .claude folder are judged', () => {
  const s = 'aa:'.repeat(21800) + ' '
  for (const tool of ['Bash', 'PowerShell']) expect(Math.min(took(() => sh(s, tool)), took(() => sh(s, tool)), took(() => sh(s, tool)))).toBeLessThan(200)
  const at = (command: string, base: string, tool = 'Bash') => touchesBus({ tool, input: { command }, isReadOnly: false }, base, HOME)
  for (const cmd of [`cd ~/${D} && echo x > co*r/rules.json`, `cd ~/${D} && rm -rf ./[c]oordinator-monitor`, `cd ~/${D} && touch {c,}oordinator-monitor/answers/x.json`, `cd ~/${D} && rm -rf ./*/answers`, `cd ~/${D} && rm -rf *`, `cd ~/${D} && cp x ${CM}/rules.json`, `cd ~/${D} && cd ${CM} && echo x > rules.json`, `cd ~/${D} && echo x > ${CM}/rules.json`, `cd ~/${D} && tar xzf dl.tgz`]) expect(sh(cmd)).toBe(true)
  expect(sh(`Set-Location $HOME/${D}; Remove-Item -Recurse c?ordinator-monitor`, 'PowerShell')).toBe(true)
  for (const cmd of [`cd ~/${D} && cp settings.json settings.bak`, `cd ${D} && mv settings.local.json x.json`, `cd ~/${D} && ls ${CM}`, 'ln -sf ../.env.$NODE_ENV .env', `cd ~/${D} && cp *.json bak/`]) expect(sh(cmd)).toBe(false)
  expect(at('echo x > /d/bus/rules.json', 'D:/bus')).toBe(true)
  expect(at('cd /d/bus && echo x > rules.json', 'D:/bus')).toBe(true)
  expect(at('echo x >~/bus/rules.json', 'C:/Users/carlo/bus')).toBe(true)
  expect(at('echo x > /d/other/rules.json', 'D:/bus')).toBe(false)
})

test('round 12: a long word after a cd into the .claude folder is judged in linear time, and an awk, jq, python or script-block word is not a glob', () => {
  const dots = '.'.repeat(65000)
  const long = [['Bash', `cd ~/${D} && x {${dots}a`], ['Bash', `cd ~/${D} && x {a${'..'.repeat(32500)}b`], ['Bash', `cd ~/.cl* && x {${dots}a`], ['PowerShell', `cd ~/${D}; x {${dots}a`], ['Bash', `cd ~/${D} && x ${'{a}'.repeat(21000)}`]]
  for (const [tool, cmd] of long) expect(fast(() => sh(cmd, tool))).toBeLessThan(200)
  for (const cmd of [`cd ~/${D} && ls -la | awk '{print $9}'`, `cd ~/${D} && jq '.permissions.allow[]' settings.json`, `cd ~/${D} && jq '{model: .model}' settings.json`, `cd ~/${D} && cat settings.json | jq '.hooks[]'`, `cd ~/${D} && python3 -c 'import json; d=json.load(open("settings.json")); print(d["model"])'`])
    expect(sh(cmd)).toBe(false)
  for (const cmd of [`cd ~/${D}; Get-ChildItem | ForEach-Object { $_.Name }`, `cd ~/${D}; dir | % { $_.FullName }`, `cd ~/${D}; Get-ChildItem | Where-Object { $_.Length -gt 1MB }`]) expect(sh(cmd, 'PowerShell')).toBe(false)
  for (const cmd of [`cd ~/${D} && rm -rf [c]oordinator-monitor`, `cd ~/${D} && rm -rf "c"*`, `cd ~/${D} && rm -rf {c,x}*`, `cd ~/${D} && rm -rf c${BS}o*`]) expect(sh(cmd)).toBe(true)
  expect(sh(`cd ~/${D}; ri c${String.fromCharCode(96)}oord*`, 'PowerShell')).toBe(true)
})

test('round 13: a hostile 64 KB input is judged in under 250 ms, and never allowed under a cd into the folder', () => {
  const soup = `*[${'b'.repeat(185)}]{${','.repeat(60)}}`
  const words = (suffix: string) => {
    let s = ''
    while (s.length < 65536) s += `${soup}${suffix} `
    return s
  }
  const pre = 'rm a' + BS + 'b "q" @(x) c d/.. ; '
  const cases: [string, boolean][] = [
    [`cd ~/${D} && rm ` + words(''), true],
    [`cd ~/${D} && ` + pre + words(''), true],
    [pre + words('/x').replace(/\*\[/g, '.*['), false],
  ]
  for (const [cmd, under] of cases) {
    expect(fast(() => sh(cmd))).toBeLessThan(250)
    if (under) expect(sh(cmd)).toBe(true)
  }
})

test('round 13: a path built with Join-Path, -join or Combine that could name the folder is a hit', () => {
  const p = (cmd: string) => sh(cmd, 'PowerShell')
  const dir = `$HOME,'${D}','${CM}','rules.json'`
  for (const cmd of [
    `Set-Content (Join-Path ~/${D} 'coordi*/rules.json') x`,
    `Set-Content ((${dir}) -join '/') x`,
    `Set-Content ('~/${D}', 'coordi*/rules.json' -join '/') x`,
    `[IO.Path]::Combine($HOME,'${D}','c*','rules.json')`,
    `Set-Content ('~/${D}', 'coord' -join '/') x`,
  ])
    expect(p(cmd)).toBe(true)
  expect(p(`Set-Content (Join-Path ~/docs 'notes.txt') x`)).toBe(false)
  expect(p(`$a = ('x','y') -join ','; Write-Output $a`)).toBe(false)
})

test('round 13: an abbreviated PowerShell destination parameter is read as the destination', () => {
  const p = (cmd: string) => sh(cmd, 'PowerShell')
  expect(p(`Copy-Item -Destin ~/${D} -Recurse -Force -Path C:/tmp/x/${CM}`)).toBe(true)
  expect(p(`Expand-Archive -DestinationPa ~/${D} -Path C:/tmp/x.zip -Force`)).toBe(true)
  expect(p(`Copy-Item -Destin C:/tmp/y -Recurse -Path C:/tmp/x`)).toBe(false)
})

test('round 13: a cd into the folder followed by an archive or a copy out of it is not a hit; one into it still is', () => {
  for (const cmd of [`cd ~/${D} && tar -czf /tmp/b.tgz .`, `cd ~/${D} && 7z a /tmp/b.7z .`, `cd ~/${D} && cp -r . /tmp/backup`, `cd ~/${D} && rsync -a ./ /tmp/backup/`]) expect(sh(cmd)).toBe(false)
  expect(sh(`Set-Location ~/${D}; Compress-Archive -Path * -DestinationPath C:/tmp/b.zip`, 'PowerShell')).toBe(false)
  for (const cmd of [`cd ~/${D} && tar -xzf x.tgz`, `cd ~/${D} && cp -r /tmp/x .`, `cd ~/${D} && tar -czf ${CM}/x.tgz .`]) expect(sh(cmd)).toBe(true)
})

test('round 13: python zipfile and tarfile extracts and ExtractToDirectory write their destination', () => {
  expect(sh(`python -m zipfile -e /tmp/x.zip ~/${D}`)).toBe(true)
  expect(sh(`python3 -m tarfile -e /tmp/x.tar ~/${D}`)).toBe(true)
  expect(sh(`python -m zipfile -e /tmp/x.zip /tmp/out`)).toBe(false)
  expect(sh(`[IO.Compression.ZipFile]::ExtractToDirectory('C:/tmp/x.zip', '~/${D}')`, 'PowerShell')).toBe(true)
  expect(sh(`[IO.Compression.ZipFile]::ExtractToDirectory('C:/tmp/x.zip', 'C:/tmp/out')`, 'PowerShell')).toBe(false)
})

test('round 14: a 64 KB run of home expansions is judged in under 200 ms', () => {
  for (const unit of ["'~|", "'~;", "'~&", '"~|'])
    for (const tool of ['Bash', 'PowerShell']) {
      const ms = fast(() => sh(unit.repeat(Math.ceil(65536 / 3)), tool))
      expect(ms).toBeLessThan(200)
    }
})

test('round 14: a path joined with -join or + at run time, in any spacing, that could name the folder is a hit', () => {
  const p = (cmd: string) => sh(cmd, 'PowerShell')
  const bt = String.fromCharCode(96)
  const half = `coord','inator-monitor/answers/x.json`
  for (const cmd of [
    `Set-Content (-join ('~/${D}/${half}')) 1`,
    `Set-Content (-join('~/${D}/${half}')) 1`,
    `Set-Content (('~/${D}/${half}')-join'') 1`,
    `Set-Content (('~/${D}/${half}') -join'') 1`,
    `Set-Content (-join ('~/${D}/coord','inator-monitor/answers/x.json')) 1`,
    `Set-Content (("$HOME/${D}/"+'coordi')+'nator-monitor/answers/x.json') 1`,
    `Set-Content ('~/${D}/coordi'+ <#x#> 'nator-monitor/answers/x.json') 1`,
    `Set-Content ('~/${D}/coordi'+${bt}\n'nator-monitor/answers/x.json') 1`,
    `Set-Content ('~/${D}/coordi'+(${bt}\n'nator-monitor/answers/x.json')) 1`,
    // A comment marker inside a string is no comment.
    `Set-Content '<#' ~/${D}/${CM}/answers/x.json '#>'`,
  ])
    expect(p(cmd)).toBe(true)
})

test('round 14: a path joined with a globbed .claude is a hit', () => {
  const p = (cmd: string) => sh(cmd, 'PowerShell')
  for (const cmd of [
    `Set-Content (Join-Path ~/.cl* ${CM}/rules.json) 1`,
    `Set-Content ([IO.Path]::Combine($HOME,'.cl?ude','${CM}','rules.json')) 1`,
    `Set-Content (Join-Path ~ .cl* ${CM}/rules.json) 1`,
    `Set-Content (Join-Path ~/.cl[a]ude ${CM}/rules.json) 1`,
    `Set-Content (Join-Path $HOME '.cl?ude' '${CM}' 'rules.json') 1`,
  ])
    expect(p(cmd)).toBe(true)
})

test('round 14: everyday joins and sums in PowerShell are no hit', () => {
  const p = (cmd: string) => sh(cmd, 'PowerShell')
  const bt = String.fromCharCode(96)
  for (const cmd of [
    `$path = Join-Path $root ($name + '.txt')`,
    `Set-Content (Join-Path $PWD 'a.txt') (($lines) -join "${bt}n")`,
    `[IO.Path]::Combine($base, $name + '.json')`,
    `Get-ChildItem (Join-Path $env:TEMP 'logs') | ForEach-Object { $n = $n + 1 }`,
  ])
    expect(p(cmd)).toBe(false)
  // ...while a join under the home folder with a piece of the folder's name still is.
  expect(p(`$path = Join-Path $HOME ($name + '.cl')`)).toBe(true)
})

test('round 13: tree -o writes a file, so it is not read-only', () => {
  expect(sh(`cd ~/${D} && tree -o ${CM}/rules.json .`)).toBe(true)
  expect(sh(`cd ~/${D} && tree -L 2`)).toBe(false)
})
