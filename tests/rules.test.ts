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
    "cat > tests/x.test.ts <<'EOF'\nexpect(run('gh pr merge 7')).toBe(1)\nEOF",
  ])
    expect(label(cmd)).toBe('merge')
})
