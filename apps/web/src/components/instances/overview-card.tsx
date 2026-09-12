import { useTranslation } from 'react-i18next'
import { InfoField } from '@/components/info-field.js'
import { StatusBadge } from '@/components/status-badge.js'
import { Card, CardContent } from '@/components/ui/card.js'
import type { InstanceSummary } from '@/lib/api.js'
import { formatMb } from '@/lib/format.js'

/** 详情页顶部的信息块：状态、规格、镜像、时间。**这里只描述实例记录本身**，
 *  实时用量（含磁盘用了多少）在 `usage-card.tsx`，别在两处量同一个东西。 */
export function OverviewCard({ instance }: { instance: InstanceSummary }) {
  const { t, i18n } = useTranslation()
  const format = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    )

  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <InfoField label={t('instanceDetail.status')}>
          <div className="flex flex-col items-start gap-1">
            <StatusBadge status={instance.status} statusText={instance.statusText} />
            {instance.status === 'restarting' && instance.statusText !== null && (
              <span className="font-mono text-xs text-destructive">{instance.statusText}</span>
            )}
          </div>
        </InfoField>
        <InfoField label={t('instanceDetail.spec')}>
          {t('instances.cores', { count: instance.cpus })} ·{' '}
          {t('instances.gigabytes', { count: Math.round(instance.memoryMb / 1024) })} ·{' '}
          {t('instances.diskGb', { size: formatMb(instance.diskMb) })}
        </InfoField>
        <InfoField label={t('instanceDetail.image')}>{instance.image}</InfoField>
        <InfoField label={t('instanceDetail.createdAt')}>{format(instance.createdAt)}</InfoField>
        <InfoField label={t('instanceDetail.stoppedAt')}>
          {/* stoppedAt 是 DB 写的，只在 DB 也认为停着时才配得上当前状态——
              实时状态可能已经是 restarting，这时候显示「停止于」是自相矛盾 */}
          {instance.status === 'stopped' && instance.stoppedAt !== null
            ? format(instance.stoppedAt)
            : '—'}
        </InfoField>
        {instance.lastError !== null && (
          <InfoField label={t('instanceDetail.lastError')} className="col-span-full">
            <span className="text-destructive">{instance.lastError}</span>
          </InfoField>
        )}
      </CardContent>
    </Card>
  )
}
