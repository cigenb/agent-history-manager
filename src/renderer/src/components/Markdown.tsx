import { useT } from '../i18n'
import { memo, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from './Icons'

export function CopyButton({
  getText,
  label,
  iconRight,
}: {
  getText: () => string
  label?: string
  iconRight?: boolean
}) {
  const t = useT()
  const [done, setDone] = useState(false)
  const icon = done ? <Check width={14} height={14} /> : <Copy width={14} height={14} />
  return (
    <button
      className="icon-btn copy-btn"
      title={t.copy}
      aria-label={done ? t.copied : (label || t.copy)}
      onClick={() => {
        void navigator.clipboard.writeText(getText()).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
    >
      {!iconRight && icon}
      {label && <span>{done ? t.copied : label}</span>}
      {iconRight && icon}
    </button>
  )
}

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const t = useT()
  const ref = useRef<HTMLPreElement>(null)
  const lang = /language-([\w+-]+)/.exec(
    ((children as { props?: { className?: string } } | undefined)?.props?.className as string) || '',
  )?.[1]
  return (
    <div className={className ? `code-block ${className}` : 'code-block'}>
      <div className="code-head">
        <span>{lang || 'text'}</span>
        <CopyButton getText={() => ref.current?.innerText ?? ''} label={t.copy} />
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

const components: Components = {
  pre: ({ children, className }) => <CodeBlock className={className}>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
}

const remarkPlugins = [remarkGfm]
// Auto-detection over every untagged block is slow on long sessions; only tagged blocks are highlighted.
const rehypePlugins = [[rehypeHighlight, { detect: false }]] as const

/** How a source line of the Markdown changed; see the `marks` prop. */
export type LineMark = 'added' | 'modified'

interface HastNode {
  type: string
  tagName?: string
  properties?: { className?: string[] }
  children?: HastNode[]
  position?: { start: { line: number }; end: { line: number } }
}

// Innermost blocks; a list item counts only when its text is not wrapped in paragraphs (a tight list).
const MARKABLE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'tr', 'hr', 'li'])

/** Adds `md-added` / `md-modified` to every rendered block whose source lines include a marked line. */
function rehypeLineMarks(marks: ReadonlyMap<number, LineMark>) {
  return (tree: HastNode) => {
    const visit = (n: HastNode) => {
      const markable =
        n.type === 'element' &&
        MARKABLE.has(n.tagName!) &&
        !(n.tagName === 'li' && n.children?.some((c) => c.tagName === 'p'))
      if (markable && n.position) {
        let mark: LineMark | undefined
        for (let l = n.position.start.line; l <= n.position.end.line && mark !== 'modified'; l++) mark = marks.get(l) ?? mark
        if (mark) n.properties = { ...n.properties, className: [...(n.properties?.className ?? []), `md-${mark}`] }
      }
      n.children?.forEach(visit)
    }
    visit(tree)
  }
}

/** `marks`: source line (1-based) → change, highlighted on the blocks rendered from those lines. */
export default memo(function Markdown({ text, marks }: { text: string; marks?: ReadonlyMap<number, LineMark> }) {
  const plugins = useMemo(
    () => (marks?.size ? [...rehypePlugins, [rehypeLineMarks, marks]] : rehypePlugins),
    [marks],
  )
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={plugins as unknown as never}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
