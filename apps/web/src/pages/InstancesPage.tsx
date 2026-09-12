import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrandMark } from '@/components/brand-mark.js'
import { CreateInstanceForm } from '@/components/instances/create-instance-form.js'
import { InstanceCard } from '@/components/instances/instance-card.js'
import { PageHeader } from '@/components/page-header.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent } from '@/components/ui/card.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog.js'
import {
  ApiError,
  listInstances,
  removeInstance,
  restartInstance,
  startInstance,
  stopInstance,
} from '@/lib/api.js'
import { listRefetchInterval } from '@/lib/instance-status.js'
import { invalidateInstances, keys } from '@/lib/query-keys.js'

/**
 * 我的实例。列表本身只做三件事：拉数据、把编排动作发出去、给出空态。
 * 卡片长什么样在 `components/instances/instance-card.tsx`，建实例表单在
 * `create-instance-form.tsx`。
 */
export default function InstancesPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)

  const instances = useQuery({
    queryKey: keys.instances,
    queryFn: listInstances,
    // 编排进行中每 3 秒跟一次；其余每 10 秒兜底（见 lib/instance-status.ts 的说明）
    refetchInterval: (query) => listRefetchInterval(query.state.data),
  })

  const invalidate = () => invalidateInstances(queryClient)

  const restart = useMutation({ mutationFn: restartInstance, onSuccess: invalidate })
  const stop = useMutation({ mutationFn: stopInstance, onSuccess: invalidate })
  const start = useMutation({ mutationFn: startInstance, onSuccess: invalidate })

  // 删除失败时卡片还在，把错误挂回对应的那张卡（多个实例同时删也各自显示各自的）
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null)

  const remove = useMutation({
    mutationFn: ({
      id,
      purge,
      confirmSlug,
    }: {
      id: string
      purge?: boolean
      confirmSlug?: string
    }) =>
      removeInstance(id, {
        // exactOptionalPropertyTypes：没传的键不要显式塞 undefined
        ...(purge === undefined ? {} : { purge }),
        ...(confirmSlug === undefined ? {} : { confirmSlug }),
      }),
    onSuccess: async (_data, { id }) => {
      setDeleteError((prev) => (prev?.id === id ? null : prev))
      await invalidate()
    },
    onError: (err, { id }) => {
      setDeleteError({
        id,
        message: err instanceof ApiError ? err.message : t('instances.deleteFailed'),
      })
    },
  })

  /** 这个实例上有没有正在飞的编排动作——有就把按钮全禁掉，别叠加。 */
  const busyFor = (id: string) =>
    (restart.isPending && restart.variables === id) ||
    (stop.isPending && stop.variables === id) ||
    (start.isPending && start.variables === id) ||
    (remove.isPending && remove.variables?.id === id)

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <PageHeader
        title={t('instances.title')}
        description={t('instances.subtitle')}
        actions={
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger render={<Button />}>
              <PlusIcon />
              {t('instances.create')}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('instances.newTitle')}</DialogTitle>
                <DialogDescription>{t('instances.newDescription')}</DialogDescription>
              </DialogHeader>
              <CreateInstanceForm onCreated={() => setCreateOpen(false)} />
            </DialogContent>
          </Dialog>
        }
      />

      {instances.isPending && (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      )}
      {instances.isError && <p className="text-sm text-destructive">{t('instances.loadFailed')}</p>}

      {instances.data?.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <BrandMark className="mb-1 size-10 text-muted-foreground/40" />
            <p className="font-medium">{t('instances.emptyTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('instances.emptyHint')}</p>
            <Button className="mt-2" onClick={() => setCreateOpen(true)}>
              {t('instances.emptyAction')}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {instances.data?.map((instance) => (
          <InstanceCard
            key={instance.id}
            instance={instance}
            busy={busyFor(instance.id)}
            deleteError={deleteError?.id === instance.id ? deleteError.message : null}
            onRestart={() => restart.mutate(instance.id)}
            onStop={() => stop.mutate(instance.id)}
            onStart={() => start.mutate(instance.id)}
            onDelete={() => remove.mutate({ id: instance.id })}
            onPurge={(confirmSlug) => remove.mutate({ id: instance.id, purge: true, confirmSlug })}
          />
        ))}
      </div>
    </div>
  )
}
