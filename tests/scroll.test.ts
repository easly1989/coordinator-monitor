import { expect, test } from 'claude-code/testing'

import { rowsOf } from '../hooks/scroll'

test('rowsOf puts every character back, in order, and marks continuation rows', () => {
  const rows = rowsOf([{ text: 'abcdefghijklmnopqrstuvwxyz' }, { text: 'one\ntwo' }], 10)
  expect(rows.map(r => r.text)).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz', 'one', 'two'])
  expect(rows.map(r => !!r.isCont)).toEqual([false, true, true, false, false])
  expect(rowsOf([{ text: '' }], 10)).toEqual([{ text: '' }])
})

test('rowsOf counts a wide character as two cells and a tab as eight', () => {
  // 8 columns: four wide letters fill a row, an emoji is wide too.
  expect(rowsOf([{ text: '日本語の漢字' }], 8).map(r => r.text)).toEqual(['日本語の', '漢字'])
  expect(rowsOf([{ text: '😀😀😀😀😀' }], 8).map(r => r.text)).toEqual(['😀😀😀😀', '😀'])
  expect(rowsOf([{ text: 'ab한글' }], 8).map(r => r.text)).toEqual(['ab한글'])
  // A tab takes a whole row at width 8: nothing else fits beside it.
  expect(rowsOf([{ text: 'a\tb' }], 8).map(r => r.text)).toEqual(['a', '\t', 'b'])
  expect(rowsOf([{ text: 'a\tb\tc' }], 10).map(r => r.text)).toEqual(['a\tb', '\tc'])
  expect(rowsOf([{ text: 'a\tb\tc' }], 20).map(r => r.text)).toEqual(['a\tb\tc'])
  // Nothing is lost whatever the width.
  const text = 'x\t日本\u{20000}y😀z'
  for (const w of [8, 9, 11, 40]) expect(rowsOf([{ text }], w).map(r => r.text).join('')).toBe(text)
})

test('rowsOf counts a BMP emoji as two cells', () => {
  expect(rowsOf([{ text: '✅✅✅✅✅' }], 8).map(r => r.text)).toEqual(['✅✅✅✅', '✅'])
})

test('rowsOf keeps tone and block flags, and narrows a block by its gutter', () => {
  const rows = rowsOf([{ text: '0123456789', isBlock: true, tone: 'label' }], 10)
  expect(rows).toEqual([
    { text: '01234567', tone: 'label', isBlock: true },
    { text: '89', tone: 'label', isBlock: true, isCont: true },
  ])
  // A tiny width never drops below 8 cells.
  expect(rowsOf([{ text: 'abcdefghi' }], 1).map(r => r.text)).toEqual(['abcdefgh', 'i'])
})
