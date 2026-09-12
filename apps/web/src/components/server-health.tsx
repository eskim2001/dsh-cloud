import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { keys } from '@/lib/query-keys.js'
import { cn } from '@/lib/utils.js'

/** 探针自己发请求：它要判定的正是「`request()` 还能不能通」，不能复用会抛错的包装。 */
const HEALTH_POLL_MS = 30_000

/**
 * 平台存活指示灯（`/healthz`）。
 *
 * 它的价值在**故障时**：服务端挂了的话，页面各处只会显示一堆「加载失败」，
 * 分不清是自己操作错了还是平台没了。这一颗点先给出答案。
 *
 * 失败不重试、不弹错——它本身就是一个「正在失败」的信号。
 */
export function ServerHealth() {
  const { t } = useTranslation()
  const health = useQuery({
    queryKey: keys.health,
    queryFn: async () => {
      const res = await fetch('/healthz')
      return res.ok
    },
    refetchInterval: HEALTH_POLL_MS,
    retry: false,
  })

  const up = health.data === true
  // 还没答案（首帧）时是中性的——别把「不知道」画成「挂了」
  const unknown = health.isPending
  const text = unknown
    ? t('common.checking')
    : up
      ? t('health.ok')
      : t('health.down')

  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
      title={text}
    >
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          unknown ? 'bg-muted-foreground/40' : up ? 'bg-emerald-500' : 'bg-destructive',
        )}
      />
      <span className="truncate group-data-[collapsible=icon]:hidden">{text}</span>
    </div>
  )
}
