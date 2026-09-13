import { useQuery } from '@tanstack/react-query'
import { ArrowRightIcon, PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { StatusBadge } from '@/components/status-badge.js'
import { buttonVariants } from '@/components/ui/button.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import { listInstances } from '@/lib/api.js'
import { listRefetchInterval } from '@/lib/instance-status.js'
import { keys } from '@/lib/query-keys.js'
import { useSession } from '@/lib/use-session.js'
import { cn } from '@/lib/utils.js'

export default function HomePage() {
  const { t, i18n } = useTranslation()
  const { data: user } = useSession()
  const instances = useQuery({
    queryKey: keys.instances,
    queryFn: listInstances,
    refetchInterval: (query) => listRefetchInterval(query.state.data?.instances),
  })
  const recent = instances.data?.instances ?? []
  const current = recent[0]
  const name = user?.name?.split(/\s+/)[0] || user?.email.split('@')[0] || ''
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-14 py-6 md:py-14">
      <header className="animate-in fade-in slide-in-from-bottom-2 duration-500">
        <p className="text-2xl font-medium tracking-normal">
          {t(`home.${greeting}`, { name })}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{t('home.subtitle')}</p>
      </header>

      <section>
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-medium">{t('home.continue')}</h1>
        </div>

        {instances.isPending && (
          <div className="mt-4 border-y">
            {[0, 1].map((item) => <Skeleton key={item} className="my-3 h-14 rounded-md" />)}
          </div>
        )}
        {instances.isError && <p className="text-sm text-destructive">{t('instances.loadFailed')}</p>}
        {instances.data !== undefined && current === undefined && (
          <div className="mt-4 border-y py-14 text-center">
            <p className="font-medium">{t('home.emptyTitle')}</p>
            <p className="mt-2 text-sm text-muted-foreground">{t('home.emptyBody')}</p>
            <Link className={cn(buttonVariants(), 'mt-6')} to="/workspaces/new">
              <PlusIcon />
              {t('home.create')}
            </Link>
          </div>
        )}
        {current !== undefined && (
          <Link to={`/workspaces/${current.id}/open`} className="group mt-4 grid min-h-28 grid-cols-[1fr_auto] items-center gap-6 border-y py-6">
            <div className="min-w-0"><p className="truncate text-lg font-medium">{current.slug}</p><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1"><StatusBadge status={current.status} statusText={current.statusText} /><span className="text-xs text-muted-foreground">{t('instances.lastUsed', { time: relativeDate(current.stoppedAt ?? current.createdAt, i18n.language) })}</span></div></div>
            <span className="inline-flex items-center gap-2 text-sm font-medium">{t('instances.open')}<ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-1" /></span>
          </Link>
        )}
      </section>

      {current !== undefined && (
        <div className="grid gap-10 md:grid-cols-[1fr_1.35fr]">
          <section>
            <h2 className="text-sm font-medium">{t('home.quickActions')}</h2>
            <div className="mt-4 border-t">
              <Link to="/workspaces/new" className="group flex items-center justify-between border-b py-4 text-sm"><span className="flex items-center gap-3"><PlusIcon className="size-4 text-muted-foreground" />{t('home.create')}</span><ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" /></Link>
              <Link to="/files" className="group flex items-center justify-between border-b py-4 text-sm"><span>{t('home.browseFiles')}</span><ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" /></Link>
            </div>
          </section>
          <section>
            <div className="flex items-center justify-between"><h2 className="text-sm font-medium">{t('home.activity')}</h2><Link to="/activity" className="text-xs text-muted-foreground hover:text-foreground">{t('home.viewActivity')}</Link></div>
            <div className="mt-4 border-t">{recent.slice(0, 3).map((item) => <div key={item.id} className="flex items-center justify-between gap-4 border-b py-4"><div><p className="text-sm">{t('workspaceDetail.available')}</p><p className="mt-1 text-xs text-muted-foreground">{item.slug}</p></div><time className="text-xs text-muted-foreground">{relativeDate(item.stoppedAt ?? item.createdAt, i18n.language)}</time></div>)}</div>
          </section>
        </div>
      )}
    </div>
  )
}

function relativeDate(value: string, locale: string): string {
  const days = -Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 86_400_000))
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day')
}