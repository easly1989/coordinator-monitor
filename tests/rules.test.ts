import { expect, test } from 'claude-code/testing'

import { DEFAULT_RULES, matchRule } from '../hooks/rules'

const label = (cmd: string) => matchRule(DEFAULT_RULES, cmd)?.label

test('a here-doc handed to a command that only stores it is not matched; one that can run is', () => {
  // Stored: a test file, a commit message, a PR body.
  expect(label("cat > tests/x.test.ts <<'EOF'\nexpect(run('gh pr merge 7')).toBe(1)\nEOF")).toBe(undefined)
  expect(label("cat > f <<-EOF\n\tgh pr merge 7\n\tEOF")).toBe(undefined)
  expect(label("cd repo && git commit -F - <<'EOF'\nUndo the git merge of main\nEOF")).toBe(undefined)
  expect(label('gh pr create --title "x" --body-file - <<\'EOF\'\nThen gh pr merge 7.\nEOF')).toBe(undefined)
  // What follows the body still counts, as does the line that opens it.
  expect(label("cat > f <<'EOF'\nnotes\nEOF\ngh pr merge 7")).toBe('merge')
  expect(label("gh pr merge 7 && cat > f <<'EOF'\nnotes\nEOF")).toBe('merge')
  // Fed to a shell or an interpreter, the text can run: matched whole.
  expect(label("python - <<'EOF'\nos.system('gh pr merge 7')\nEOF")).toBe('merge')
  expect(label("bash <<'EOF'\ngh pr merge 7\nEOF")).toBe('merge')
  expect(label("cat <<'EOF' | bash\ngh pr merge 7\nEOF")).toBe('merge')
  expect(label("bash -c 'source /dev/stdin; cat ' <<'EOF'\ngh pr merge 7\nEOF")).toBe('merge')
  expect(label("cat > $(mktemp) <<'EOF'\ngh pr merge 7\nEOF")).toBe('merge')
  expect(label('node -e "run(\'gh pr merge 7\')"')).toBe('merge')
  // A body with no end line, or an end line that is not exactly the word, is matched whole.
  expect(label("cat > f <<'EOF'\ngh pr merge 7")).toBe('merge')
  expect(label("cat > f <<'EOF'\ngh pr merge 7\n EOF")).toBe('merge')
})
