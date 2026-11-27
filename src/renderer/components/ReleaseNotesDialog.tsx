import { Fragment, type ReactNode } from 'react'
import type { ReleaseNote } from '../../shared/releaseNotes'
import { UsageDialog } from './UsageDialog'

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'paragraph'; text: string }

/** A deliberately small Markdown subset: headings, bullet lists, bold and inline code. */
function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  let list: string[] | null = null
  const flush = () => {
    if (list?.length) blocks.push({ kind: 'list', items: list })
    list = null
  }
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.startsWith('### ')) {
      flush()
      blocks.push({ kind: 'heading', text: line.slice(4).trim() })
    } else if (line.startsWith('- ')) {
      list ??= []
      list.push(line.slice(2).trim())
    } else if (!line.trim()) {
      flush()
    } else {
      flush()
      blocks.push({ kind: 'paragraph', text: line.trim() })
    }
  }
  flush()
  return blocks
}

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  for (const [index, part] of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).entries()) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**')) {
      nodes.push(<strong key={index}>{part.slice(2, -2)}</strong>)
    } else if (part.startsWith('`') && part.endsWith('`')) {
      nodes.push(<code key={index}>{part.slice(1, -1)}</code>)
    } else {
      nodes.push(<Fragment key={index}>{part}</Fragment>)
    }
  }
  return nodes
}

export function ReleaseNotesDialog({ note, onClose }: { note: ReleaseNote; onClose: () => void }) {
  return (
    <UsageDialog title="更新公告" subtitle={`v${note.version}`} onClose={onClose}>
      <div className="dialog-body release-notes-body">
        <div className="release-notes-markdown">
          {parseBlocks(note.markdown).map((block, index) => {
            if (block.kind === 'heading') return <h3 key={index}>{inline(block.text)}</h3>
            if (block.kind === 'list') {
              return <ul key={index}>{block.items.map((item, at) => <li key={at}>{inline(item)}</li>)}</ul>
            }
            return <p key={index}>{inline(block.text)}</p>
          })}
        </div>
      </div>
      <footer className="dialog-footer">
        <button type="button" className="action-button primary-action" onClick={onClose}>知道了</button>
      </footer>
    </UsageDialog>
  )
}
