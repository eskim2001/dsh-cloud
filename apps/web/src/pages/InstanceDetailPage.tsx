import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { LogPanel } from '@/components/log-panel.js'
import { PageHeader } from '@/components/page-header.js'
import { StatusBadge } from '@/components/status-badge.js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.js'
import {
  ApiError,
  getInstance,
  getInstanceImage,
  getInstanceMetrics,
  getInstanceStats,
  rollbackInstanceImage,
  setInstanceImage,
  type InstanceSummary,
} from '../lib/api.js'
import { formatMb } from '../lib/format.js'

/** 编排进行中每 3 秒跟一次；其余每 10 秒兜底——状态由服务端从 Docker 现算，落定态也会漂。 */
const IN_FLIGHT_STATUSES = new Set(['provisioning', 'removing'])
const IDLE_POLL_MS = 10_000

export default function InstanceDetailPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation()

  const instance = useQuery({
    queryKey: ['instance', id],
    queryFn: () => getInstance(id),
    enabled: id !== '',
    refetchInterval: (query) => {
      const status = query.state.data?.status
      if (status === undefined) return false
      return IN_FLIGHT_STATUSES.has(status) ? 3000 : IDLE_POLL_MS
    },
  })

  const running = instance.data?.status === 'running'

  // 磁盘是独立于容器的一路：容器停着文件系统还挂着，用量照样读得到
  const stats = useQuery({
    queryKey: ['instance-stats', id],
    queryFn: () => getInstanceStats(id),
    enabled: id !== '',
    refetchInterval: 10_000,
  })

  const metrics = useQuery({
    queryKey: ['instance-metrics', id],
    queryFn: () => getInstanceMetrics(id),
    enabled: id !== '' && running,
    // 后端一分钟采一次，跟着它走就行
    refetchInterval: 60_000,
  })

  if (instance.isError) {
    return (
      <div className="flex w-full max-w-4xl flex-col gap-6">
        <BackLink />
        <p className="text-sm text-destructive">{t('instanceDetail.loadFailed')}</p>
      </div>
    )
  }

  if (instance.data === undefined) {
    return (
      <div className="flex w-full max-w-4xl flex-col gap-6">
        <BackLink />
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <BackLink />

      <PageHeader
        title={instance.data.slug}
        description={hostOf(instance.data.url)}
        actions={
          // 用原生按钮而不是 `<a>`：base-ui 的 Button 给 `<a>` 挂 disabled 只是
          // `aria-disabled`，锚点照样能点——实例没跑时会跳到一个 502 页面
          <Button
            onClick={() => window.open(instance.data.url, '_blank', 'noopener,noreferrer')}
            disabled={!running}
          >
            {t('instances.open')}
          </Button>
        }
      />

      <OverviewCard instance={instance.data} />

      <VersionCard id={id} instance={instance.data} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('instanceDetail.usageTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-8">
            <Metric
              label={t('instanceDetail.cpu')}
              value={
                stats.data?.usage == null
                  ? null
                  : `${stats.data.usage.cpuPercent.toFixed(1)}%`
              }
            />
            <Metric
              label={t('instanceDetail.memory')}
              value={stats.data?.usage == null ? null : `${stats.data.usage.memMb} MB`}
            />
            <Metric
              label={t('instanceDetail.disk')}
              value={
                stats.data?.disk == null
                  ? null
                  : `${formatMb(stats.data.disk.usedMb)} / ${formatMb(stats.data.disk.quotaMb)}`
              }
            />
          </div>

          {!running ? (
            <p className="text-sm text-muted-foreground">{t('instanceDetail.usageStopped')}</p>
          ) : metrics.data === undefined || metrics.data.length === 0 ? (
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
        </CardContent>
      </Card>

      {instance.data.hasContainer && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('instanceDetail.logTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            {/* 状态一变就重挂：容器被重建后旧日志流已断，得重新连 */}
            <LogPanel key={instance.data.status} src={`/api/instances/${id}/logs?tail=200`} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function BackLink() {
  const { t } = useTranslation()
  return (
    <Link
      to="/instances"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      {t('instanceDetail.back')}
    </Link>
  )
}

function OverviewCard({ instance }: { instance: InstanceSummary }) {
  const { t, i18n } = useTranslation()
  const format = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    )

  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <Field label={t('instanceDetail.status')}>
          <div className="flex flex-col items-start gap-1">
            <StatusBadge status={instance.status} statusText={instance.statusText} />
            {instance.status === 'restarting' && instance.statusText !== null && (
              <span className="font-mono text-xs text-destructive">{instance.statusText}</span>
            )}
          </div>
        </Field>
        <Field label={t('instanceDetail.spec')}>
          {t('instances.cores', { count: instance.cpus })} ·{' '}
          {t('instances.gigabytes', { count: Math.round(instance.memoryMb / 1024) })} ·{' '}
          {t('instances.diskGb', { size: formatMb(instance.diskMb) })}
        </Field>
        <Field label={t('instanceDetail.image')}>{instance.image}</Field>
        <Field label={t('instanceDetail.createdAt')}>{format(instance.createdAt)}</Field>
        <Field label={t('instanceDetail.stoppedAt')}>
          {/* stoppedAt 是 DB 写的，只在 DB 也认为停着时才配得上当前状态——
              实时状态可能已经是 restarting，这时候显示「停止于」是自相矛盾 */}
          {instance.status === 'stopped' && instance.stoppedAt !== null
            ? format(instance.stoppedAt)
            : '—'}
        </Field>
        {instance.lastError !== null && (
          <Field label={t('instanceDetail.lastError')} className="col-span-full">
            <span className="text-destructive">{instance.lastError}</span>
          </Field>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * 版本（D19）。升级 = 换镜像，**先给数据打一份快照**，所以失败能回滚。
 * 用户只能选平台提供的稳定版——那些 tag 是平台回归过才写进白名单的。
 */
function VersionCard({ id, instance }: { id: string; instance: InstanceSummary }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [target, setTarget] = useState('')

  const info = useQuery({
    queryKey: ['instance-image', id],
    queryFn: () => getInstanceImage(id),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['instance', id] })
    void queryClient.invalidateQueries({ queryKey: ['instance-image', id] })
    void queryClient.invalidateQueries({ queryKey: ['instances'] })
  }

  const upgrade = useMutation({
    mutationFn: (image: string) => setInstanceImage(id, image),
    onSuccess: () => {
      setTarget('')
      refresh()
    },
  })
  const rollback = useMutation({
    mutationFn: () => rollbackInstanceImage(id),
    onSuccess: refresh,
  })

  const options = (info.data?.stable ?? []).filter((tag) => tag !== instance.image)
  const busy = upgrade.isPending || rollback.isPending
  const error = upgrade.error ?? rollback.error

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('instanceDetail.versionTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field label={t('instanceDetail.currentVersion')}>
            <span className="font-mono">{instance.image}</span>
          </Field>

          {info.data !== undefined && options.length > 0 && (
            <div className="flex items-end gap-2">
              <Field label={t('instanceDetail.upgradeTo')}>
                <Select
                  items={options.map((tag) => ({ value: tag, label: tag }))}
                  value={target}
                  onValueChange={(value) => {
                    if (typeof value === 'string') setTarget(value)
                  }}
                >
                  <SelectTrigger id="version-target" className="w-56">
                    <SelectValue placeholder={t('instanceDetail.upgradePlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {options.map((tag) => (
                        <SelectItem key={tag} value={tag}>
                          {tag}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Button disabled={target === '' || busy} onClick={() => upgrade.mutate(target)}>
                {upgrade.isPending ? t('instanceDetail.upgrading') : t('instanceDetail.upgrade')}
              </Button>
            </div>
          )}

          {info.data !== undefined && options.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('instanceDetail.noStable')}</p>
          )}
        </div>

        <p className="text-sm text-muted-foreground">{t('instanceDetail.upgradeHint')}</p>

        {instance.previousImage !== null && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm">
                {t('instanceDetail.previousVersion', { image: instance.previousImage })}
              </span>
              {info.data?.snapshotMb != null && (
                <span className="text-xs text-muted-foreground">
                  {t('instanceDetail.snapshotUsage', { size: formatMb(info.data.snapshotMb) })}
                </span>
              )}
            </div>
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={busy} />}>
                {t('instanceDetail.rollback')}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('instanceDetail.rollbackTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('instanceDetail.rollbackDescription', {
                      slug: instance.slug,
                      image: instance.previousImage,
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => rollback.mutate()}>
                    {t('instanceDetail.rollbackConfirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}

        {info.isError && (
          <p className="text-sm text-destructive">{t('instanceDetail.versionLoadFailed')}</p>
        )}
        {error !== null && (
          <p className="text-sm text-destructive">
            {error instanceof ApiError ? error.message : t('instanceDetail.versionActionFailed')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className === undefined ? 'flex flex-col gap-1' : `flex flex-col gap-1 ${className}`}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
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

/**
 * 手写 SVG 折线，不引图表库——数据就是一条序列，够用。
 * 纵轴按**实测范围**归一化（不是 0 起），否则低负载下曲线会贴成一条直线。
 */
function Trend({
  label,
  points,
  format,
}: {
  label: string
  points: number[]
  format: (v: number) => string
}) {
  const W = 480
  const H = 56
  const PAD = 4
  const max = points.length === 0 ? 0 : Math.max(...points)
  const min = points.length === 0 ? 0 : Math.min(...points)
  const span = max - min

  // 全平的时候放中间，不然线会贴在顶或底
  const y = (v: number) => (span === 0 ? H / 2 : H - PAD - ((v - min) / span) * (H - PAD * 2))
  const x = (i: number) => (points.length === 1 ? W / 2 : PAD + i * ((W - PAD * 2) / (points.length - 1)))
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ')
  const last = points[points.length - 1] ?? 0

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {format(last)} · {format(max)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full text-primary" preserveAspectRatio="none">
        {points.length === 1 ? (
          <circle cx={W / 2} cy={y(points[0]!)} r={3} fill="currentColor" />
        ) : (
          <path
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  )
}

/** 从入口 URL 取主机名——和列表页一样，用户要看的是地址不是带 token 的路径。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
