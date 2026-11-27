'use client'

type Commit = (() => void) | void
type Reader = () => Commit

interface BatchQueue {
  frame: number
  tasks: Map<object, Reader>
}

const queues = new WeakMap<Window, BatchQueue>()

/**
 * 同じフレーム内の表計測（操作幅・行の高さ・列幅）で、
 * 全員の読取を終えてから書込をまとめて実行し、読取と書込の交互発生による再計算の連鎖を防ぐ。
 */
export function scheduleTableMeasure(view: Window, key: object, read: Reader): () => void {
  let queue = queues.get(view)
  if (!queue) {
    queue = { frame: 0, tasks: new Map() }
    queues.set(view, queue)
  }
  queue.tasks.set(key, read)
  if (!queue.frame) {
    const activeQueue = queue
    activeQueue.frame = view.requestAnimationFrame(() => {
      activeQueue.frame = 0
      const batch = [...activeQueue.tasks.values()]
      activeQueue.tasks.clear()
      const commits: (() => void)[] = []
      for (const task of batch) {
        const commit = task()
        if (typeof commit === 'function') commits.push(commit)
      }
      for (const commit of commits) commit()
    })
  }
  return () => {
    const current = queues.get(view)
    if (!current) return
    current.tasks.delete(key)
    if (current.tasks.size === 0 && current.frame) {
      view.cancelAnimationFrame(current.frame)
      current.frame = 0
    }
  }
}
