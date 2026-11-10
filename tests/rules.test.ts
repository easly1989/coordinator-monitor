import { expect, test } from 'claude-code/testing'

import { DEFAULT_RULES, dataMask, matchRule } from '../hooks/rules'

const label = (cmd: string) => matchRule(DEFAULT_RULES, cmd)?.label

test('a rule matches the whole text: no here-doc, quote or script hides a protected command', () => {
  for (const cmd of [
    // A quote in the line, so the here-doc looks like it goes to cat.
    "cat ''; bash <<B\ngh pr merge 7\nB",
    // Two here-docs on one line.
    "cat > a <<A; bash <<B\nnotes\nA\ngh pr merge 7\nB",
    // One nested inside another that ends after it.
    "bash <<A\ncat > f <<B\nx\nB\ngh pr merge 7\nA",
    // An unquoted body: its $( ) runs while the file is written.
    'cat > f <<EOF\n$(gh pr merge 7)\nEOF',
    // A script written, then run.
    "cat > s.sh <<'EOF'\ngh pr merge 7\nEOF\nbash s.sh",
    // An end line with a CR, which bash does not take as the end.
    "cat > f <<'EOF'\nx\nEOF\r\ngh pr merge 7\nEOF",
    // Inline scripts and plain stored text alike.
    `python -c "import os; os.system('gh pr merge 7')"`,
  ])
    expect(label(cmd)).toBe('merge')
})

test('a protected command only mentioned in text a program stores or prints raises no card', () => {
  for (const cmd of [
    // Notes written with cat to a .md or .txt file: the body is data.
    "cat > notes.md <<'EOF'\nrun gh pr merge 7 when ready\nEOF",
    "cat <<'EOF' > a.txt\ngit merge x\nEOF\ngit add -A",
    // A commit message in the usual form.
    "git commit -m \"$(cat <<'EOF'\nfix: stop matching gh pr merge 7 in text\n\nCo-Authored-By: x\nEOF\n)\"",
    "git add -A && git commit -m \"$(cat <<'EOF'\nfix: stop matching gh pr merge 7\nEOF\n)\"",
    "git commit -F - <<'EOF'\nwe no longer ask for git merge here\nEOF",
    "cat <<'EOF'\ngit merge x\nEOF",
    "echo 'gh pr merge 7'",
    "git commit -m 'git merge fix'",
    "cd repo && git commit -am 'git merge fix' && git status",
    "grep 'git push origin main' notes.md",
    "gh pr create --title t --body 'will git merge later'",
  ])
    expect(label(cmd)).toBe(undefined)
})

test('a step that is not on the allowlist of inert ones leaves the whole text unmasked', () => {
  for (const cmd of [
    // A variable as the command, set by printf -v.
    "printf -v c '%s' 'gh pr merge 5'; $c",
    // A file written by a flag, then run.
    "git log -1 --format='gh pr merge 5' --output=x.sh; sh x.sh",
    // The text goes through git and out into a pipe.
    "git commit --allow-empty -m 'gh pr merge 5'; git log -1 --format=%s | sh",
    "git notes add -m 'gh pr merge 5' HEAD; git notes show HEAD | bash",
    // A data file copied or renamed to a script, then run.
    "cat <<'EOF' > a.txt\ngh pr merge 5\nEOF\ncp a.txt b.sh; sh b.sh",
    "cat <<'EOF' > a.txt\ngh pr merge 5\nEOF\nmv a.txt b.sh; ./b.sh",
    // A file a tool runs: a test, a package script.
    "cat <<'EOF' > a.test.ts\ngh pr merge 5\nEOF\nbun test",
    "cat > tests/x.test.ts <<'EOF'\nexpect(run('gh pr merge 7')).toBe(1)\nEOF",
    'cat <<\'EOF\' > package.json\n{"scripts":{"x":"gh pr merge 5"}}\nEOF\nnpm run x',
    // A flag that runs something, on a command that otherwise only prints.
    "rg x --hostname-bin 'gh pr merge 5'",
    "grep x --pre 'gh pr merge 5' f",
    // A flag written in quotes: the allowlist cannot see it, and printf -v evaluates an array subscript.
    "printf '-v' 'a[$(gh pr merge 5)]' x",
    'printf "-v" "a[\\$(gh pr merge 5)]" x',
    "printf -v a 'gh pr merge 5'",
    "echo '-e' 'gh pr merge 5'",
    "git commit '-m' 'gh pr merge 5'",
    "grep '--pre=sh' 'gh pr merge 5'",
    "git diff '--output=x.sh' 'gh pr merge 5'",
    // A data step in the same call as one that runs.
    "echo 'gh pr merge 5'; npm test",
    "echo 'gh pr merge 5' | tee f; sh f",
  ])
    expect(label(cmd)).toBe('merge')
})

const M = 'gh pr ' + 'merge 5'

test('a here-doc end line, a continuation or a substitution in the body cannot hide a protected command', () => {
  for (const cmd of [
    // Inside `$( )` bash ends the body at a line that only starts with the word.
    ...[')', ' )', ';)', ')x', ' ;', '|'].map(suf => `git commit -m "$(cat <<'EOF'\nx\nEOF${suf}"; ${M}; echo "\nEOF\n)"`),
    // A backslash-newline hides the `(` of a substitution in an unquoted body.
    `cat <<EOF\n$\\\n(${M})\nEOF`,
    `tee notes.md <<EOF\n$\\\n(${M})\nEOF`,
    `git commit -F - <<EOF\n$\\\n(${M})\nEOF`,
    // A split end line ends the body early.
    `cat <<EOF\nx\nEO\\\nF\n${M}\nEOF`,
    `cat <<-EOF\nx\n\tEO\\\nF\n${M}\n\tEOF`,
  ])
    expect(label(cmd)).toBe('merge')
  // The same hiding of `${x@P}` (which runs the value of x as a prompt string): the text is not masked.
  expect(dataMask('cat <<EOF\n$\\\n{x@P}\nEOF')).toBe(null)
})

test('plain text that mentions a protected command stays quiet, with or without a dash in it', () => {
  for (const cmd of [
    `git commit -m "$(cat <<'EOF'\nfix: avoid ${M}\nEOF\n)"`,
    `cat <<'EOF' > notes.md\n${M}\nEOF`,
    `echo '- item ${M}'`,
    `git commit -m '- fix ${M}'`,
    `git commit -m '-fix ${M}'`,
    `git commit -m '-fix' -m 'docs: avoid ${M}'`,
    `gh pr comment 5 --body '- ${M}'`,
    `git commit -m "- fix ${M}"`,
    `git commit -m 'docs: ${M}'`,
    `echo '${M}'`,
    `gh pr comment 5 --body '${M}'`,
    `grep -n '${M}' a.md`,
  ])
    expect(label(cmd)).toBe(undefined)
})

test('a flag written in quotes, or joined from quoted parts, leaves the text unmasked', () => {
  for (const cmd of [
    `printf -'v' 'a[$(${M})]' x`,
    `printf '-'v 'a[$(${M})]' x`,
    `echo -'e' '${M}'`,
    `grep "--pre"=sh '${M}' x`,
    `grep --'pre'=sh '${M}' x`,
    `git diff --'output'=x.sh '${M}' x`,
    // A flag that takes a value on grep (-F, -b, -n) does not make the next word a value there.
    `grep -F '--pre=sh' '${M}' x`,
    `grep -n '--pre=sh' '${M}' x`,
    `git commit -m x '-x' '${M}'`,
    // Another pipe or write in the same call.
    `echo '${M}' | sh`,
    `echo x '${M}' > a.sh; sh a.sh`,
    `cd 'x' && ${M}`,
  ])
    expect(label(cmd)).toBe('merge')
})

test('PowerShell text is never masked', () => {
  expect(matchRule(DEFAULT_RULES, "echo 'git push origin main' -OutVariable c; iex \"$c\"", true)?.label).toBe('merge')
  expect(matchRule(DEFAULT_RULES, "echo 'gh pr merge 7'", true)?.label).toBe('merge')
  expect(matchRule(DEFAULT_RULES, "echo 'gh pr merge 7'")?.label).toBe(undefined)
})

test('the text is read raw whenever it cannot be split with certainty', () => {
  for (const cmd of [
    // Code strings given to a shell or an interpreter.
    "bash -c 'git merge x'",
    `python -c "subprocess.run('git merge')"`,
    "eval 'git merge x'",
    "ssh h 'git merge x'",
    "pwsh -Command 'gh pr merge 7'",
    // A quoted string that is piped on or stored to be run.
    "echo 'gh pr merge 7' | bash",
    "echo 'gh pr merge 7' > s.sh; bash s.sh",
    // A here-doc body that runs: to a pipe, to a shell, to a script, to a file run later, to no known file.
    "cat <<'EOF' | bash\ngit merge x\nEOF",
    "cat > s.sh <<'EOF'\ngit merge x\nEOF",
    "cat > f.txt <<'EOF'\ngit merge x\nEOF\nbash f.txt",
    "cat > f <<'EOF'\ngit merge x\nEOF",
    'cat <<EOF\n$(git merge x)\nEOF',
    // Here-string, unbalanced quote, continuation.
    "bash <<< 'git merge x'",
    "echo 'x; git merge y",
    "echo hi \\\n&& git merge y",
    // A quote opened earlier cannot turn code into a body.
    `echo "\ncat > f <<'EOF'\n"; gh pr merge 7; echo "\nEOF`,
    // A protected command next to quoted text.
    'git commit -m "x" && git push origin main',
    "git commit -m 'x'; git merge y",
  ])
    expect(label(cmd)).toBeTruthy()
})
