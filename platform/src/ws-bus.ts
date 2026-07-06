import type { WebSocket } from 'ws'

/** 按 runId 分组的 WebSocket 频道。 */
const channels = new Map<string, Set<WebSocket>>()

export function subscribe(runId: string, ws: WebSocket): () => void {
  let set = channels.get(runId)
  if (!set) {
    set = new Set()
    channels.set(runId, set)
  }
  set.add(ws)
  return () => {
    set!.delete(ws)
    if (set!.size === 0) channels.delete(runId)
  }
}

export function broadcast(runId: string, msg: unknown): void {
  const set = channels.get(runId)
  if (!set || set.size === 0) return
  const text = JSON.stringify(msg)
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(text)
  }
}
