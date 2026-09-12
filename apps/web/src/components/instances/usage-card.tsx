import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { QuotaMeter } from '@/components/quota-meter.js'
import { Trend } from '@/components/trend.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js'
import { getInstanceMetrics, getInstanceStats, type InstanceSummary } from '@/lib/api.js'
import { formatMb } from '@/lib/format.js'
import { keys } from '@/lib/query-keys.js'

/**
 * 采样条数 → 时间长度。后端一分钟一条，所以 120 = 2 小时、360 = 6 小时、
 * 1000（服务端上限）= 约 16 小时。
 */
const RANGES = [
  { value: 120, label: 'instanceDetail.range2h' },
  { value: 360, label: 'instanceDetail.range6h' },
  { value: 1000, label: 'instanceDetail.range16h' },
] as const

const DEFAULT_RANGE = 120

/**
 * 用量卡：实时快照（CPU / 内存 / 磁盘）+ 走势图。
 *
 * 时间范围放在 **URL 上**（`?range=360`）而不是组件状态里——运维贴一条链接给别人
 * 时，"我看到的那段曲线"要能一起带过去；刷新也不该跳回 2 小时。
 */
export function UsageCard({
  id,
  running,
  instance,
}: {
  id: string
  /** 容器在跑才有实时值和采样（见 instance-status 的 canOpen）。 */
  running: boolean
  instance: InstanceSummary
}) {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()

  const requested = Number(params.get('range'))
  const range = RANGES.some((r) => r.value === requested) ? requested : DEFAULT_RANGE

  const setRange = (value: number) => {
    const next = new URLSearchParams(params)
    // 默认值不写进 URL：干净的链接优先，`?range=120` 和被剥掉的等价
    if (value === DEFAULT_RANGE) next.delete('range')
    else next.set('range', String(value))
    setParams(next, { replace: true })
  }

  const stats = useQuery({
    queryKey: keys.instanceStats(id),
    queryFn: () => getInstanceStats(id),
    // 实时快照读的是宿主上的 cgroup 和文件系统，跟实例状态一起 10 秒一次
    refetchInterval: 10_000,
  })

  const metrics = useQuery({
    queryKey: keys.instanceMetrics(id, range),
    queryFn: () => getInstanceMetrics(id, range),
    enabled: running,
    // 后端一分钟采一次，跟着它走就行
    refetchInterval: 60_000,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('instanceDetail.usageTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-8">
          <Metric
            label={t('instanceDetail.cpu')}
            value={stats.data?.usage == null ? null : `${stats.data.usage.cpuPercent.toFixed(1)}%`}
          />
          <Metric
            label={t('instanceDetail.memory')}
            // 服务端给的是 cgroup 的原始字节数换算结果（`269.3515625` 这种），
            // 直接摆出来是没意义的精度
            value={stats.data?.usage == null ? null : `${Math.round(stats.data.usage.memMb)} MB`}
          />
          {/* 磁盘用配额条而不是一个大数字：**没有生效的配额要写成「无上限」**，
              摆一个 `5 GB / 10 GB` 出来是在撒谎（见 quota-meter.tsx） */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('instanceDetail.disk')}</span>
            <QuotaMeter
              usedMb={instance.diskUsedMb}
              quotaMb={instance.diskMb}
              enforced={instance.diskEnforced}
            />
          </div>
        </div>

        {!running ? (
          <p className="text-sm text-muted-foreground">{t('instanceDetail.usageStopped')}</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              {RANGES.map((item) => (
                <Button
                  key={item.value}
                  variant={item.value === range ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setRange(item.value)}
                >
                  {t(item.label)}
                </Button>
              ))}
            </div>

            {metrics.data === undefined || metrics.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('instanceDetail.usageEmpty')}</p>
            ) : (
              <div className="flex flex-col gap-3">
                <Trend
                  label={t('instanceDetail.cpuTrend')}
                  points={metrics.data.map((m) => m.cpuPercent)}
                  format={(v) => `${v.toFixed(1)}%`}
                />
                <Trend
                  label={t('instanceDetail.memoryTrend')}
                  points={metrics.data.map((m) => m.memMb)}
                  format={(v) => `${Math.round(v)} MB`}
                />
                <Trend
                  label={t('instanceDetail.diskTrend')}
                  points={metrics.data.map((m) => m.diskUsedMb)}
                  format={formatMb}
                />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string | null }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-heading text-2xl font-semibold tabular-nums">
        {value ?? t('instanceDetail.noData')}
      </span>
    </div>
  )
}
