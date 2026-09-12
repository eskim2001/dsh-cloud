import { useTranslation } from 'react-i18next'
import { formatMb } from '@/lib/format.js'
import { DISK_ATTENTION_RATIO } from '@/lib/instance-status.js'
import { cn } from '@/lib/utils.js'

/**
 * 磁盘用量条：**用量 vs 配额**。
 *
 * ⚠️ `enforced === false` 时**不显示任何比例**，只写「无上限」——
 * 那时 `quotaMb` 只是个声明值（开发机内核不支持配额、或这个实例没有池子），
 * 拿它算比例会造出"快满了"的假警报；而显示一个没生效的上限本身就是在撒谎。
 */
export function QuotaMeter({
  usedMb,
  quotaMb,
  enforced,
  className,
}: {
  /** `undefined` = 读不到（不是 0）。 */
  usedMb: number | undefined
  quotaMb: number
  enforced: boolean
  className?: string
}) {
  const { t } = useTranslation()

  if (!enforced) {
    return (
      <span className={cn('text-xs text-muted-foreground', className)}>
        {usedMb === undefined ? t('quota.unknown') : t('quota.usedNoLimit', { used: formatMb(usedMb) })}
      </span>
    )
  }
  if (usedMb === undefined) {
    return <span className={cn('text-xs text-muted-foreground', className)}>{t('quota.unknown')}</span>
  }

  const ratio = quotaMb > 0 ? Math.min(usedMb / quotaMb, 1) : 0
  const danger = quotaMb > 0 && usedMb / quotaMb >= DISK_ATTENTION_RATIO

  return (
    <div className={cn('flex min-w-[7rem] flex-col gap-1', className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className={cn('tabular-nums', danger ? 'text-destructive' : 'text-muted-foreground')}>
          {formatMb(usedMb)} / {formatMb(quotaMb)}
        </span>
        <span className={cn('tabular-nums', danger ? 'text-destructive' : 'text-muted-foreground')}>
          {Math.round(ratio * 100)}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="presentation">
        <div
          className={cn('h-full rounded-full', danger ? 'bg-destructive' : 'bg-primary')}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  )
}
