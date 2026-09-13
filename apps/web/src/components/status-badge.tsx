import { useTranslation } from 'react-i18next'

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
  const dot =
    status === 'running'
      ? 'bg-emerald-600/70'
      : status === 'error' || status === 'restarting'
        ? 'bg-destructive/80'
        : status === 'provisioning'
          ? 'animate-pulse bg-sky-600/60'
          : 'bg-muted-foreground/45'

  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" title={statusText ?? undefined}>
      <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {t(`status.${status}`, { defaultValue: status })}
    </span>
  )
}
