import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'

/**
 * 实例状态徽章。状态由服务端**查询时从 Docker 现算**（见 docs/DECISIONS.md D16），
 * 不是 DB 快照——所以 running 之外都可能是「和意图不一致」，restarting 尤其要显眼。
 * `statusText` 是 Docker 的原文（如 `Restarting (3) 20 seconds ago`），挂成 tooltip。
 */
export function StatusBadge({
  status,
  statusText,
}: {
  status: string
  statusText?: string | null | undefined
}) {
  const { t } = useTranslation()
  const variant =
    status === 'running'
      ? 'secondary'
      : status === 'error' || status === 'restarting'
        ? 'destructive'
        : 'outline'

  return (
    <Badge variant={variant} title={statusText ?? undefined}>
      {t(`status.${status}`, { defaultValue: status })}
    </Badge>
  )
}
