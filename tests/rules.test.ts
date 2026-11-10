import { expect, test } from 'claude-code/testing'

import { DEFAULT_RULES, matchRule } from '../hooks/rules'

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
    // A test file written with cat: the body is data.
    "cat > tests/x.test.ts <<'EOF'\nexpect(run('gh pr merge 7')).toBe(1)\nEOF",
    // A commit message in the usual form.
    "git commit -m \"$(cat <<'EOF'\nfix: stop matching gh pr merge 7 in text\n\nCo-Authored-By: x\nEOF\n)\"",
    "git commit -F - <<'EOF'\nwe no longer ask for git merge here\nEOF",
    "cat <<'EOF'\ngit merge x\nEOF",
    "echo 'gh pr merge 7'",
    "git commit -m 'git merge fix'",
    "grep 'git push origin main' notes.md",
    "gh pr create --title t --body 'will git merge later'",
  ])
    expect(label(cmd)).toBe(undefined)
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
