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
    const timer = window.setTimeout(() => window.location.assign(instance.data.url), 700)
    return () => window.clearTimeout(timer)
  }, [instance.data, ready])

  const status = instance.data?.status
  const pending = instance.isPending || (status !== undefined && isTransitioning(status)) || start.isPending || retry.isPending
  const error = instance.isError || status === 'error'
  const offline = status === 'stopped' || status === 'paused'

  return (
    <div className="mx-auto flex min-h-[65vh] w-full max-w-lg flex-col items-center justify-center text-center">
      {pending && <><LoaderCircleIcon className="size-6 animate-spin text-muted-foreground" /><h1 className="mt-6 text-xl font-medium">{t('workspaceOpen.preparing')}</h1><p className="mt-2 text-sm text-muted-foreground">{t('workspaceOpen.moment')}</p><div className="mt-8 h-px w-44 overflow-hidden bg-muted"><div className="h-full w-1/2 animate-pulse bg-foreground/40" /></div></>}
      {ready && !pending && <><div className="grid size-10 place-items-center rounded-full border"><ArrowRightIcon className="size-5" /></div><h1 className="mt-6 text-xl font-medium">{t('workspaceOpen.ready')}</h1><p className="mt-2 text-sm text-muted-foreground">{t('workspaceOpen.redirecting')}</p></>}
      {offline && !start.isPending && <><PowerIcon className="size-6 text-muted-foreground" /><h1 className="mt-6 text-xl font-medium">{t('workspaceOpen.offline')}</h1><p className="mt-2 text-sm text-muted-foreground">{t('workspaceOpen.offlineBody')}</p><Button className="mt-8" onClick={() => start.mutate()}>{t('workspaceOpen.start')}</Button></>}
      {error && !retry.isPending && <><CircleAlertIcon className="size-6 text-destructive" /><h1 className="mt-6 text-xl font-medium">{t('workspaceOpen.error')}</h1><p className="mt-2 text-sm text-muted-foreground">{t('workspaceOpen.errorBody')}</p><Button className="mt-8" onClick={() => retry.mutate()}>{t('workspaceOpen.retry')}</Button></>}
      <Link to={`/workspaces/${id}`} className="mt-10 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-4" />{t('workspaceDetail.backToWorkspace')}</Link>
    </div>
  )
}