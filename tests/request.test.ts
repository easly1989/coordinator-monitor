import { expect, test } from 'claude-code/testing'

import { risksOf, stepsOf, viewOf } from '../hooks/request'

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

test('a file write reads as its path and code, an edit as a diff, anything else as itself', () => {
  expect(viewOf(JSON.stringify({ content: 'a\nb', file_path: 'C:/x/y.py' }))).toEqual({ kind: 'write', path: 'C:/x/y.py', content: 'a\nb' })
  expect(viewOf(JSON.stringify({ file_path: '/x/y.ts', new_string: 'b', old_string: 'a' }))).toEqual({ kind: 'edit', path: '/x/y.ts', diff: '@@ -1,1 +1,1 @@\n-a\n+b' })
  expect(viewOf(JSON.stringify({ url: 'https://example.com' }))).toBe(null)
  expect(viewOf('{ not json')).toBe(null)
})
