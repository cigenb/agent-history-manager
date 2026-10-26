import type { SessionDetail } from '../../../shared/types'

/** Product name for the front matter, and the speaker heading of answers */
const NAMES = { claude: ['Claude Code', 'Claude'], codex: ['Codex', 'Codex'], grok: ['Grok', 'Grok'] } as const

const cleanPrompt = (text: string): string => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

export function markdownFileName(title: string): string {
  let name = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 100)
  if (!name) name = 'conversation'
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`
  return `${name}.md`
}

export function exportMarkdown(detail: SessionDetail, title: string, now = new Date()): string {
  const [product, speaker] = NAMES[detail.source]
  const firstPrompt = detail.turns.find((turn) => turn.kind === 'user' && turn.time)
  const date = new Date(firstPrompt?.time || detail.firstTime || now.getTime())
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const header = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `date: ${day}`,
    `exported: ${now.toISOString()}`,
    `project: ${JSON.stringify(detail.path)}`,
    `session: ${JSON.stringify(detail.id)}`,
    `source: ${product}`,
    '---',
    '',
    `# ${title.replace(/[\r\n]+/g, ' ')}`,
  ]
  const messages: string[] = []
  for (const turn of detail.turns) {
    if (turn.kind === 'user') {
      const body = [...turn.images.map(() => '*[Image]*'), cleanPrompt(turn.text)].filter(Boolean).join('\n\n')
      if (body) messages.push(`### **Human**\n\n${body}`)
    } else if (turn.kind === 'assistant' && turn.text.trim()) {
      messages.push(`### **${speaker}**\n\n${turn.text}`)
    }
  }
  return [header.join('\n'), ...messages].join('\n\n---\n\n') + '\n'
}
