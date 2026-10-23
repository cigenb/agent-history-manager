export interface DiffLine {
  type: ' ' | '+' | '-'
  text: string
}

const lines = (s: string): string[] => (s === '' ? [] : s.split('\n'))

/** Above this many cells the LCS table is skipped and the change is shown as remove-all / add-all. */
const MAX_CELLS = 250_000

/**
 * Line diff between an edit's old and new text. Common leading and trailing lines are matched first, so the
 * LCS table only covers the changed middle, which keeps typical edits tiny.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = lines(oldText)
  const b = lines(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++

  const x = a.slice(start, a.length - end)
  const y = b.slice(start, b.length - end)
  const head = a.slice(0, start).map((text): DiffLine => ({ type: ' ', text }))
  const tail = a.slice(a.length - end).map((text): DiffLine => ({ type: ' ', text }))

  if (x.length * y.length > MAX_CELLS) {
    return [
      ...head,
      ...x.map((text): DiffLine => ({ type: '-', text })),
      ...y.map((text): DiffLine => ({ type: '+', text })),
      ...tail,
    ]
  }

  // dp[i][j] = LCS length of x[i..] and y[j..]
  const n = x.length
  const m = y.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const mid: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      mid.push({ type: ' ', text: x[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      mid.push({ type: '-', text: x[i++] })
    } else {
      mid.push({ type: '+', text: y[j++] })
    }
  }
  while (i < n) mid.push({ type: '-', text: x[i++] })
  while (j < m) mid.push({ type: '+', text: y[j++] })
  return [...head, ...mid, ...tail]
}
