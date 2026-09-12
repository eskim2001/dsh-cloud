import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.js'
import { getAdminInstanceImage, type AdminInstance } from '@/lib/api.js'
import { formatMb } from '@/lib/format.js'
import { keys } from '@/lib/query-keys.js'

/**
 * 管理员换镜像。
 *
 * 可选宿主上**全部**本地 tag —— 用户面只给上架过的白名单版本，管理员能看到本机缓存的全部，
 * 这样"先把 rc 拉到宿主、挑一台灰度"这种操作不用去开 shell。
 *
 * 换镜像会先给数据打快照再重建容器，所以失败能自动回滚；上一版存在时这里也提供手动回滚，
 * 并显示快照占用了多少磁盘。
 */
export function InstanceImageForm({
  item,
  pending,
  error,
  rollbackPending,
  rollbackError,
  onApply,
  onRollback,
}: {
  item: AdminInstance
  pending: boolean
  error: string | null
  rollbackPending: boolean
  rollbackError: string | null
  onApply: (image: string) => void
  onRollback: () => void
}) {
  const { t } = useTranslation()
  const [target, setTarget] = useState('')

  const info = useQuery({
    queryKey: keys.adminInstanceImage(item.id),
    queryFn: () => getAdminInstanceImage(item.id),
  })

  // 当前版本从候选里去掉：换到自己没有意义，只会白重建一次容器。
  const options = (info.data?.local ?? []).filter((tag) => tag !== item.image)
  const busy = pending || rollbackPending
  const previousImage = info.data?.previousImage ?? null

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel>{t('admin.instances.imageCurrent')}</FieldLabel>
          <span className="font-mono text-sm">{info.data?.image ?? item.image}</span>
        </Field>
        <Field>
          <FieldLabel htmlFor="image-target">{t('admin.instances.imageTarget')}</FieldLabel>
          {info.isPending ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : options.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('admin.instances.imageLocalEmpty')}</p>
          ) : (
            <Select
              items={options.map((tag) => ({ value: tag, label: tag }))}
              value={target}
              onValueChange={(value) => {
                if (typeof value === 'string') setTarget(value)
              }}
            >
              <SelectTrigger id="image-target" className="w-full">
                <SelectValue />
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
          )}
        </Field>
      </FieldGroup>

      {previousImage !== null && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm">
              {t('instanceDetail.previousVersion', { image: previousImage })}
            </span>
            {info.data?.snapshotMb != null && (
              <span className="text-xs text-muted-foreground">
                {t('admin.instances.imageSnapshot', { size: formatMb(info.data.snapshotMb) })}
              </span>
            )}
          </div>
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={busy} />}>
              {t('admin.instances.imageRollback')}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('admin.instances.imageRollback')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('admin.instances.imageRollbackConfirm', { image: previousImage })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={onRollback}>
                  {t('admin.instances.imageRollback')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {info.isError && (
        <p className="text-sm text-destructive">{t('admin.instances.imageLoadFailed')}</p>
      )}
      {error !== null && <p className="text-sm text-destructive">{error}</p>}
      {rollbackError !== null && <p className="text-sm text-destructive">{rollbackError}</p>}

      <div className="flex justify-end">
        <Button disabled={target === '' || busy} onClick={() => onApply(target)}>
          {pending ? t('admin.instances.imageApplying') : t('admin.instances.imageApply')}
        </Button>
      </div>
    </div>
  )
}
