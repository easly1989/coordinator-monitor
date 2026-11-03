import { expect, test } from 'claude-code/testing'

import { risksOf, stepsOf, viewOf, visible } from '../hooks/request'

test('a shell command splits into its steps, quotes and $( ) kept whole, with what each kind of step can do', () => {
  const cmd = `mkdir -p "$P/bin" && cd $P/bin && gh release download -R a/b --pattern '*x64.zip;*.txt' | tee log; python -c "import x; print(1)" && echo $(date +%s) > out.txt`
  expect(stepsOf(cmd)).toEqual([
    'mkdir -p "$P/bin"',
    'cd $P/bin',
    "gh release download -R a/b --pattern '*x64.zip;*.txt'",
    'tee log',
    'python -c "import x; print(1)"',
    'echo $(date +%s) > out.txt',
  ])
  expect(risksOf(cmd)).toEqual(['net', 'exec', 'write'])
  expect(risksOf('git status 2>/dev/null')).toEqual([])
  expect(risksOf('rm -rf build')).toEqual(['del'])
})

test('quotes are read as the asking shell reads them, so no step hides inside another', () => {
  // `\"` escapes in bash; in PowerShell it ends the string, and what follows runs.
  const cmd = 'Write-Host "a\\"; Remove-Item x; \\""'
  expect(stepsOf(cmd, 'bash')).toEqual([cmd])
  expect(stepsOf(cmd, 'powershell')).toEqual(['Write-Host "a\\"', 'Remove-Item x', '\\""'])
  // In bash a backslash inside single quotes is literal; in PowerShell a doubled quote stays inside.
  expect(stepsOf("echo 'a\\'; rm x", 'bash')).toEqual(["echo 'a\\'", 'rm x'])
  expect(stepsOf("echo 'it''s; fine'", 'powershell')).toEqual(["echo 'it''s; fine'"])
  expect(stepsOf('echo "a`"; b"', 'powershell')).toEqual(['echo "a`"; b"'])
})

test('where the split is not certain there are no steps at all', () => {
  for (const cmd of ['echo "open', 'echo $(date', 'cat <<EOF\nrm x\nEOF', 'echo `rm x`', 'a \\\nb; c']) expect(stepsOf(cmd, 'bash')).toBe(null)
  for (const cmd of ['$s = @"\nrm x; y\n"@', "echo 'open", 'a `\nb; c']) expect(stepsOf(cmd, 'powershell')).toBe(null)
  expect(viewOf('Bash', 'echo "open; rm -rf /')).toBe(null)
  expect(viewOf('Bash', Array.from({ length: 41 }, (_, n) => `echo ${n}`).join('; '))).toBe(null)
})

test('the view follows the tool that asks, not the look of the text', () => {
  expect(viewOf('PowerShell', 'Write-Host "a\\"; Remove-Item x')).toEqual({ kind: 'shell', steps: ['Write-Host "a\\"', 'Remove-Item x'], risks: ['del'] })
  expect(viewOf('Bash', '{ "content": "x", "file_path": "a" }')).toBe(null)
  expect(viewOf('Read', JSON.stringify({ content: 'x', file_path: 'a' }))).toBe(null)
  expect(viewOf('Write', JSON.stringify({ content: 'a\nb', file_path: 'C:/x/y.py' }))).toEqual({ kind: 'write', path: 'C:/x/y.py', content: 'a\nb' })
  expect(viewOf('Edit', JSON.stringify({ file_path: '/x/y.ts', new_string: 'b', old_string: 'a' }))).toEqual({ kind: 'edit', path: '/x/y.ts', diff: '@@ -1,1 +1,1 @@\n-a\n+b' })
  expect(viewOf('Edit', JSON.stringify({ file_path: '/x/y.ts', new_string: 'b', old_string: 'a', replace_all: true }))).toEqual({ kind: 'edit', path: '/x/y.ts', diff: '@@ -1,1 +1,1 @@\n-a\n+b', isEveryMatch: true })
  expect(viewOf('Edit', JSON.stringify({ old_string: 'a', new_string: 'b' }))).toBe(null)
  expect(viewOf('Write', '{ not json')).toBe(null)
})

test('characters that hide or reorder text show as codes; tab and newline stay', () => {
  expect(visible('a\u202Eb\u2066c\u200Bd\u001B[31m\te\nf\u0007\uFEFF')).toBe('a\\u202Eb\\u2066c\\u200Bd\\u001B[31m\te\nf\\u0007\\uFEFF')
  expect(visible('plain → text')).toBe('plain → text')
})
