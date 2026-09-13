import { useQuery } from '@tanstack/react-query'
import { ActivityIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/page-header.js'
import { listInstances } from '@/lib/api.js'
import { keys } from '@/lib/query-keys.js'

export default function ActivityPage() {
  const { t, i18n } = useTranslation()
  const instances = useQuery({ queryKey: keys.instances, queryFn: listInstances })
  const events = (instances.data?.instances ?? []).flatMap((item) => [
    { id: `${item.id}-created`, at: item.createdAt, title: t('activity.created'), workspace: item.slug },
    ...(item.stoppedAt === null ? [] : [{ id: `${item.id}-stopped`, at: item.stoppedAt, title: t('activity.stopped'), workspace: item.slug }]),
    ...(item.lastError === null ? [] : [{ id: `${item.id}-error`, at: item.stoppedAt ?? item.createdAt, title: t('activity.error'), workspace: item.slug }]),
  ]).sort((a, b) => b.at.localeCompare(a.at))

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 py-4 md:py-8">
      <PageHeader title={t('activity.title')} description={t('activity.subtitle')} />
      {instances.isPending && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {events.length === 0 && instances.data !== undefined ? (
        <div className="border-y py-14 text-center"><ActivityIcon className="mx-auto size-5 text-muted-foreground" /><p className="mt-4 text-sm font-medium">{t('activity.empty')}</p><p className="mt-2 text-sm text-muted-foreground">{t('activity.emptyBody')}</p></div>
      ) : (
        <ol className="border-t">{events.map((event) => <li key={event.id} className="grid grid-cols-[1fr_auto] gap-4 border-b py-5"><div><p className="text-sm font-medium">{event.title}</p><p className="mt-1 text-xs text-muted-foreground">{event.workspace}</p></div><time className="text-xs text-muted-foreground">{new Date(event.at).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })}</time></li>)}</ol>
      )}
    </div>
  )
}