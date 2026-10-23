import { Component, type ReactNode } from 'react'
import { useT } from '../i18n'

function Crash({ error }: { error: Error }) {
  const t = useT()
  return (
    <div className="crash">
      <h2>{t.crash}</h2>
      <pre>{error.stack || error.message}</pre>
      <button className="btn" onClick={() => location.reload()}>{t.reload}</button>
    </div>
  )
}

/** Without this, any render error unmounts the whole tree and leaves a blank window with no clue why. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return <Crash error={error} />
  }
}
