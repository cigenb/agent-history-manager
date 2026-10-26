import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import type { UiState } from '../shared/types'

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

interface StoreData {
  ui: UiState
  window?: WindowBounds
  /** Chromium zoom level (0 = 100%) */
  zoom?: number
}

const DEFAULTS: StoreData = {
  ui: { projectOrder: [], expanded: [], showTemp: false, sessionOrder: {}, source: 'claude' },
}

/** App-owned state (project order, window size). Lives in userData; never written into ~/.claude. */
export class Store {
  data: StoreData
  private timer: NodeJS.Timeout | null = null
  private path: string

  constructor(path: string) {
    this.path = path
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreData>
      this.data = { ...DEFAULTS, ...raw, ui: { ...DEFAULTS.ui, ...raw.ui } }
    } catch {
      this.data = structuredClone(DEFAULTS)
    }
  }

  setUi(patch: Partial<UiState>): void {
    this.data.ui = { ...this.data.ui, ...patch }
    this.save()
  }

  getUi(systemLocale: string): UiState {
    const saved = this.data.ui.language
    return {
      ...this.data.ui,
      language: saved === 'zh' || saved === 'en' ? saved : (systemLocale.toLowerCase().startsWith('zh') ? 'zh' : 'en'),
    }
  }

  setZoom(level: number): void {
    if (this.data.zoom === level) return
    this.data.zoom = level
    this.save()
  }

  setWindow(bounds: WindowBounds): void {
    this.data.window = bounds
    this.save()
  }

  private save(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void fs.writeFile(this.path, JSON.stringify(this.data, null, 2)).catch(() => undefined)
    }, 300)
  }

  flush(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    try {
      writeFileSync(this.path, JSON.stringify(this.data, null, 2))
    } catch {
      /* best effort on quit */
    }
  }
}
