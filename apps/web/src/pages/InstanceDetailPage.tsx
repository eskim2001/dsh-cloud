import { useQuery } from '@tanstack/react-query'
import { ArrowLeftIcon, ArrowRightIcon, FileIcon, SettingsIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { StatusBadge } from '@/components/status-badge.js'
import { Button } from '@/components/ui/button.js'
import { getInstance } from '@/lib/api.js'
import { formatMb } from '@/lib/format.js'
import { instanceRefetchInterval } from '@/lib/instance-status.js'
import { keys } from '@/lib/query-keys.js'

export default function InstanceDetailPage() {
  const { id = '' } = useParams()
  const { t, i18n } = useTranslation()

  const instance = useQuery({
    queryKey: keys.instance(id),
    queryFn: () => getInstance(id),
    enabled: id !== '',
    // 编排进行中每 3 秒跟一次；其余每 10 秒兜底（见 lib/instance-status.ts 的说明）
    refetchInterval: (query) => instanceRefetchInterval(query.state.data),
  })

  if (instance.isError) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <BackLink />
        <p className="text-sm text-destructive">{t('workspaceDetail.notFound')}</p>
      </div>
    )
  }

  if (instance.data === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <BackLink />
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  const item = instance.data
  const version = item.image.slice(item.image.lastIndexOf(':') + 1)

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 py-4 md:py-8">
      <BackLink />
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-3"><h1 className="text-2xl font-medium">{item.slug}</h1><StatusBadge status={item.status} statusText={item.statusText} /></div>
          <p className="mt-2 text-sm text-muted-foreground">{t('workspaceDetail.created', { time: new Date(item.createdAt).toLocaleDateString(i18n.language) })}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" render={<Link to={`/workspaces/${id}/settings`} />} nativeButton={false}><SettingsIcon />{t('workspaceDetail.settings')}</Button>
          <Button render={<Link to={`/workspaces/${id}/open`} />} nativeButton={false}>{t('workspaceDetail.open')}<ArrowRightIcon /></Button>
        </div>
      </header>

      {item.lastError !== null && <div className="border-y border-destructive/30 py-4"><p className="text-sm font-medium">{t('workspaceDetail.attention')}</p><p className="mt-1 text-sm text-muted-foreground">{item.lastError}</p></div>}

      <section>
        <h2 className="text-sm font-medium">{t('workspaceDetail.workspace')}</h2>
        <div className="mt-4 grid border-y sm:grid-cols-3">
          <Summary icon={FileIcon} label={t('workspaceDetail.files')} value={t('workspaceDetail.openFiles')} />
          <Summary label={t('workspaceDetail.storage')} value={item.diskUsedMb === undefined ? t('instanceDetail.noData') : formatMb(item.diskUsedMb)} />
          <Summary label={t('workspaceDetail.version')} value={version} />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium">{t('workspaceDetail.recent')}</h2>
        <div className="mt-4 flex items-center justify-between border-y py-5"><div><p className="text-sm">{item.stoppedAt === null ? t('workspaceDetail.available') : t('activity.stopped')}</p><p className="mt-1 text-xs text-muted-foreground">{item.slug}</p></div><time className="text-xs text-muted-foreground">{new Date(item.stoppedAt ?? item.createdAt).toLocaleString(i18n.language)}</time></div>
      </section>
    </div>
  )
}

function Summary({ icon: Icon, label, value }: { icon?: typeof FileIcon; label: string; value: string }) {
  return <div className="flex min-h-28 flex-col justify-between border-b py-5 sm:border-r sm:border-b-0 sm:px-5 first:pl-0 last:border-r-0"><div className="flex items-center gap-2 text-xs text-muted-foreground">{Icon !== undefined && <Icon className="size-3.5" />}{label}</div><p className="mt-6 truncate text-sm font-medium">{value}</p></div>
}

function BackLink() {
  const { t } = useTranslation()
  return (
    <Link
      to="/workspaces"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      {t('workspaceDetail.back')}
    </Link>
  )
}
