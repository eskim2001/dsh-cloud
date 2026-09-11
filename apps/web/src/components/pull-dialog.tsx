import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import { adminImagePullUrl } from '@/lib/api.js'

/** 留太多行会卡——超出从头部丢。拉取的进度行刷得很快。 */
const MAX_LINES = 500
/** 连接层连续失败这么多次就断开（EventSource 自己会无限重连）。 */
const MAX_ERRORS = 3

type PullState = 'pulling' | 'done' | 'failed'

/**
 * 预热镜像的进度对话框（D23，SSE）。
 *
 * 写法照抄 `log-panel.tsx`：原生 `EventSource`（只认 cookie，所以 `withCredentials`）、
 * 收到 `end` 主动 `close()`（否则会被当成断线一直重连）。两处不同：
 * - 服务端用 `event: error` 送**流内**失败（HTTP 200 + `{"error":…}`），它和连接层
 *   错误的 `error` 事件同名——靠 `instanceof MessageEvent` 区分（只有前者带 `data`）；
 * - 结束/失败后回调一次，让页面刷新（比如「已预热」标记）。
 */
export function PullDialog({
  imageRef,
  open,
  onOpenChange,
  onSettled,
}: {
  imageRef: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettled: () => void
}) {
  const { t } = useTranslation()
  const [lines, setLines] = useState<string[]>([])
  const [state, setState] = useState<PullState>('pulling')
  const preRef = useRef<HTMLPreElement>(null)
  // 父组件每次渲染都会传新的函数；用 ref 存住，避免把它写进依赖里重建 EventSource
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  useEffect(() => {
    if (!open) return
    let ended = false
    let errors = 0
    setLines([])
    setState('pulling')

    const es = new EventSource(adminImagePullUrl(imageRef), { withCredentials: true })

    const append = (line: string): void => {
      setLines((prev) =>
        prev.length >= MAX_LINES ? [...prev.slice(prev.length - MAX_LINES + 1), line] : [...prev, line],
      )
    }

    es.addEventListener('progress', (event) => {
      errors = 0
      append((event as MessageEvent<string>).data)
    })

    es.addEventListener('end', () => {
      ended = true
      setState('done')
      es.close()
      settledRef.current()
    })

    es.addEventListener('error', (event) => {
      // 连接层错误也走这个事件名，但它不是 MessageEvent（没有 data）
      if (!(event instanceof MessageEvent)) return
      ended = true
      setState('failed')
      append((event as MessageEvent<string>).data)
      es.close()
      settledRef.current()
    })

    es.onerror = () => {
      if (ended) return
      if (++errors >= MAX_ERRORS) {
        setState('failed')
        es.close()
      }
    }

    return () => {
      ended = true
      es.close()
    }
  }, [imageRef, open])

  useEffect(() => {
    const el = preRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('admin.versions.warmTitle', { ref: imageRef })}</DialogTitle>
          <DialogDescription>{t(`admin.versions.warmState.${state}`)}</DialogDescription>
        </DialogHeader>
        <pre
          ref={preRef}
          className="h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
        >
          {lines.length === 0 ? t('admin.versions.warmWaiting') : lines.join('\n')}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
