import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InfoField } from '@/components/info-field.js'
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
  getInstanceImage,
  rollbackInstanceImage,
  setInstanceImage,
  type InstanceSummary,
} from '@/lib/api.js'
import { formatMb } from '@/lib/format.js'
import { invalidateInstances, keys } from '@/lib/query-keys.js'

/**
 * 版本（D19）。升级 = 换镜像，**先给数据打一份快照**，所以失败能回滚。
 * 用户只能选平台提供的稳定版——那些 tag 是平台回归过才写进白名单的。
 */
export function VersionCard({ id, instance }: { id: string; instance: InstanceSummary }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [target, setTarget] = useState('')

  const info = useQuery({
    queryKey: keys.instanceImage(id),
    queryFn: () => getInstanceImage(id),
  })

  const refresh = () => invalidateInstances(queryClient, id)

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
          <InfoField label={t('instanceDetail.currentVersion')}>
            <span className="font-mono">{instance.image}</span>
          </InfoField>

          {info.data !== undefined && options.length > 0 && (
            <div className="flex items-end gap-2">
              <InfoField label={t('instanceDetail.upgradeTo')}>
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
              </InfoField>
              <Button disabled={target === '' || busy} onClick={() => upgrade.mutate(target)}>
                {upgrade.isPending ? t('instanceDetail.upgrading') : t('instanceDetail.upgrade')}
              </Button>
            </div>
          )}
        </div>

        {info.data !== undefined && options.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('instanceDetail.noStable')}</p>
        )}

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
        {error != null && (
          <p className="text-sm text-destructive">
            {error instanceof ApiError ? error.message : t('instanceDetail.versionActionFailed')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
