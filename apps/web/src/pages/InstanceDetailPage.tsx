import { useQuery } from '@tanstack/react-query'
import { ArrowLeftIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { OverviewCard } from '@/components/instances/overview-card.js'
import { UsageCard } from '@/components/instances/usage-card.js'
import { VersionCard } from '@/components/instances/version-card.js'
import { LogPanel } from '@/components/log-panel.js'
import { PageHeader } from '@/components/page-header.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js'
import { getInstance } from '@/lib/api.js'
import { hostOf } from '@/lib/format.js'
import { canOpen, instanceRefetchInterval } from '@/lib/instance-status.js'
import { keys } from '@/lib/query-keys.js'

/** 实例详情。页面自己只做三件事：定位实例、决定能开不能开、把几张卡摆好。 */
export default function InstanceDetailPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation()

  const instance = useQuery({
    queryKey: keys.instance(id),
    queryFn: () => getInstance(id),
    enabled: id !== '',
    // 编排进行中每 3 秒跟一次；其余每 10 秒兜底（见 lib/instance-status.ts 的说明）
    refetchInterval: (query) => instanceRefetchInterval(query.state.data),
  })

  const running = instance.data !== undefined && canOpen(instance.data.status)

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

      <UsageCard id={id} running={running} instance={instance.data} />

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
