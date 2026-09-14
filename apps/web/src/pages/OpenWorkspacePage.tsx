import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, ArrowRightIcon, CircleAlertIcon, LoaderCircleIcon, PowerIcon } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button.js'
import { getInstance, restartInstance, startInstance } from '@/lib/api.js'
import { canOpen, instanceRefetchInterval, isTransitioning } from '@/lib/instance-status.js'
import { invalidateInstances, keys } from '@/lib/query-keys.js'

export default function OpenWorkspacePage() {
  const { id = '' } = useParams()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const instance = useQuery({ queryKey: keys.instance(id), queryFn: () => getInstance(id), enabled: id !== '', refetchInterval: (query) => instanceRefetchInterval(query.state.data) })
  const start = useMutation({ mutationFn: () => startInstance(id), onSuccess: () => invalidateInstances(queryClient, id) })
  const retry = useMutation({ mutationFn: () => restartInstance(id), onSuccess: () => invalidateInstances(queryClient, id) })
  const ready = instance.data !== undefined && canOpen(instance.data.status)

  useEffect(() => {
    if (!ready || instance.data === undefined) return
    const timer = window.setTimeout(() => {
      const newWin = window.open(instance.data.url, '_blank')
      if (newWin) {
        // If popup was successful, seamlessly return the current tab to the dashboard/detail page
        window.history.back()
      }
      // If blocked by browser popup blocker, newWin is null. 
      // The user will simply remain on this page and can click the manual "Launch Workspace" button.
    }, 700)
    return () => window.clearTimeout(timer)
  }, [instance.data, ready])

  const status = instance.data?.status
  const pending = instance.isPending || (status !== undefined && isTransitioning(status)) || start.isPending || retry.isPending
  const error = instance.isError || status === 'error'
  const offline = status === 'stopped' || status === 'paused'

  return (
    <div className="relative mx-auto flex min-h-[65vh] w-full max-w-lg flex-col items-center justify-center text-center z-10 px-6">
      {pending && (
        <div className="flex flex-col items-center animate-in fade-in zoom-in-95 duration-500">
          <LoaderCircleIcon className="size-8 animate-spin text-primary/80" />
          <h1 className="mt-6 font-heading text-xl font-semibold tracking-tight text-foreground">{t('workspaceOpen.preparing')}</h1>
          <p className="mt-2 text-[14px] leading-5 text-muted-foreground">{t('workspaceOpen.moment')}</p>
          <div className="mt-8 h-[2px] w-44 overflow-hidden rounded-full bg-muted/50">
            <div className="h-full w-1/2 animate-pulse bg-primary/40 rounded-full" />
          </div>
        </div>
      )}
      
      {ready && !pending && (
        <div className="flex flex-col items-center animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="grid size-12 place-items-center rounded-full border border-primary/20 bg-primary/10 text-primary shadow-[0_0_15px_rgba(8,127,113,0.2)]">
            <ArrowRightIcon className="size-5" />
          </div>
          <h1 className="mt-6 font-heading text-xl font-semibold tracking-tight text-foreground">{t('workspaceOpen.ready')}</h1>
          <p className="mt-2 text-[14px] leading-5 text-muted-foreground">{t('workspaceOpen.readyHint')}</p>
          <div className="mt-8 flex gap-3">
            <Button
              className="h-10 px-6 shadow-sm"
              render={<a href={instance.data.url} target="_blank" rel="noreferrer" onClick={() => window.history.back()} />}
              nativeButton={false}
            >
              {t('workspaceOpen.launch')}
              <ArrowRightIcon className="ml-2 size-4" />
            </Button>
          </div>
        </div>
      )}

      {offline && !start.isPending && (
        <div className="flex flex-col items-center animate-in fade-in duration-300">
          <PowerIcon className="size-8 text-muted-foreground" />
          <h1 className="mt-6 font-heading text-xl font-semibold tracking-tight text-foreground">{t('workspaceOpen.offline')}</h1>
          <p className="mt-2 text-[14px] leading-5 text-muted-foreground">{t('workspaceOpen.offlineBody')}</p>
          <Button className="mt-8 h-10 px-6 text-[14px] shadow-sm" onClick={() => start.mutate()}>{t('workspaceOpen.start')}</Button>
        </div>
      )}

      {error && !retry.isPending && (
        <div className="flex flex-col items-center animate-in fade-in duration-300">
          <CircleAlertIcon className="size-8 text-destructive" />
          <h1 className="mt-6 font-heading text-xl font-semibold tracking-tight text-foreground">{t('workspaceOpen.error')}</h1>
          <p className="mt-2 text-[14px] leading-5 text-muted-foreground">{t('workspaceOpen.errorBody')}</p>
          <Button className="mt-8 h-10 px-6 text-[14px] shadow-sm bg-destructive hover:bg-destructive/90 text-destructive-foreground" onClick={() => retry.mutate()}>{t('workspaceOpen.retry')}</Button>
        </div>
      )}

      <Link to={`/workspaces/${id}`} className="mt-12 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-primary">
        <ArrowLeftIcon className="size-3.5" />
        {t('workspaceDetail.backToWorkspace')}
      </Link>
    </div>
  )
}
