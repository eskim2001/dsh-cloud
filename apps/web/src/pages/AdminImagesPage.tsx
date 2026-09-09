import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/page-header.js'
import { PullDialog } from '@/components/pull-dialog.js'
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
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent } from '@/components/ui/card.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.js'
import {
  ApiError,
  getAdminImages,
  publishAdminImage,
  setDefaultAdminImage,
  syncAdminImages,
  unpublishAdminImage,
  type AdminImage,
  type AdminImageState,
} from '@/lib/api.js'

const imagesKey = ['admin', 'images'] as const

/**
 * 三态徽章。**不复用 `StatusBadge`**——那套绑的是 `status.running` 这类 i18n 键，
 * 和镜像的「未下载 / 已下载 / 已发布」不是一回事。
 */
const STATE_VARIANT: Record<AdminImageState, 'secondary' | 'outline'> = {
  published: 'secondary',
  local: 'outline',
  remote: 'outline',
}

/** 服务端给的文案（如「宿主上没有镜像 …」）比笼统的「操作失败」有用。 */
function errorTextOf(error: unknown, fallback: string): string | null {
  if (error === null || error === undefined) return null
  return error instanceof ApiError ? error.message : fallback
}

/** digest 只用来认版本，取前 12 位十六进制就够；完整值挂 title。 */
function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, 12)
}

/**
 * 镜像版本管理（D21 / D23）。一张表按三态展示：
 * 未下载（注册表有，宿主上没有）→ 「下载」；已下载 → 「发布」；已发布 → 用户面可选。
 * 宿主存在性是运行时事实，所以「已发布」和「宿主上有没有」分开显示。
 */
export default function AdminImagesPage() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [pulling, setPulling] = useState<string | null>(null)

  const images = useQuery({ queryKey: imagesKey, queryFn: getAdminImages })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: imagesKey })

  const sync = useMutation({ mutationFn: syncAdminImages, onSuccess: invalidate })
  const publish = useMutation({ mutationFn: publishAdminImage, onSuccess: invalidate })
  const unpublish = useMutation({ mutationFn: unpublishAdminImage, onSuccess: invalidate })
  const setDefault = useMutation({ mutationFn: setDefaultAdminImage, onSuccess: invalidate })

  const failed = sync.isError || publish.isError || unpublish.isError || setDefault.isError
  const rows = images.data?.images ?? []
  const syncedAt = images.data?.syncedAt ?? null

  return (
    <>
      <PageHeader
        title={t('admin.images.title')}
        description={t('admin.images.description')}
        actions={
          <>
            <span className="text-xs text-muted-foreground">
              {syncedAt === null
                ? t('admin.images.neverSynced')
                : t('admin.images.syncedAt', {
                    time: new Date(syncedAt).toLocaleString(i18n.language),
                  })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
            >
              {sync.isPending ? t('admin.images.syncing') : t('admin.images.sync')}
            </Button>
          </>
        }
      />

      {failed && (
        <p className="mt-4 text-sm text-destructive">
          {errorTextOf(
            sync.error ?? publish.error ?? unpublish.error ?? setDefault.error,
            t('admin.actionFailed'),
          )}
        </p>
      )}

      {sync.data !== undefined && (
        <p className="mt-4 text-sm text-muted-foreground">
          {t('admin.images.syncResult', { count: sync.data.count })}
          {sync.data.skipped > 0 && t('admin.images.syncSkipped', { skipped: sync.data.skipped })}
        </p>
      )}

      <Card className="mt-6">
        <CardContent>
          {images.isPending && (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
          {images.isError && (
            <p className="text-sm text-destructive">{t('admin.images.loadFailed')}</p>
          )}

          {images.data !== undefined &&
            (rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('admin.images.empty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('admin.images.ref')}</TableHead>
                    <TableHead>{t('admin.images.state')}</TableHead>
                    <TableHead>{t('admin.images.digest')}</TableHead>
                    <TableHead>{t('admin.images.publishedAt')}</TableHead>
                    <TableHead className="text-right">{t('admin.images.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((image) => (
                    <TableRow key={image.ref}>
                      <TableCell className="font-medium">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{image.ref}</span>
                          {image.isDefault && (
                            <Badge variant="secondary">{t('admin.images.default')}</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={STATE_VARIANT[image.state]}
                          title={
                            image.state === 'published' && !image.onHost
                              ? t('admin.images.notOnHost')
                              : undefined
                          }
                        >
                          {t(`admin.images.stateLabel.${image.state}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {image.digest === null ? (
                          '—'
                        ) : (
                          <span title={image.digest}>{shortDigest(image.digest)}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {image.publishedAt === null
                          ? '—'
                          : new Date(image.publishedAt).toLocaleString(i18n.language)}
                      </TableCell>
                      <TableCell className="text-right">
                        <ImageActions
                          image={image}
                          onDownload={() => setPulling(image.ref)}
                          publishPending={publish.isPending && publish.variables === image.ref}
                          unpublishPending={
                            unpublish.isPending && unpublish.variables === image.ref
                          }
                          defaultPending={setDefault.isPending && setDefault.variables === image.ref}
                          onPublish={() => publish.mutate(image.ref)}
                          onUnpublish={() => unpublish.mutate(image.ref)}
                          onSetDefault={() => setDefault.mutate(image.ref)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ))}
        </CardContent>
      </Card>

      {pulling !== null && (
        <PullDialog
          imageRef={pulling}
          open
          onOpenChange={(open) => {
            if (!open) setPulling(null)
          }}
          onSettled={invalidate}
        />
      )}
    </>
  )
}

/** 行内动作按状态给：未下载 → 下载；已下载 → 发布；已发布 → 设为默认 / 下架。 */
function ImageActions({
  image,
  onDownload,
  onPublish,
  onUnpublish,
  onSetDefault,
  publishPending,
  unpublishPending,
  defaultPending,
}: {
  image: AdminImage
  onDownload: () => void
  onPublish: () => void
  onUnpublish: () => void
  onSetDefault: () => void
  publishPending: boolean
  unpublishPending: boolean
  defaultPending: boolean
}) {
  const { t } = useTranslation()

  if (image.state === 'remote') {
    return (
      <Button variant="outline" size="sm" onClick={onDownload}>
        {t('admin.images.download')}
      </Button>
    )
  }

  if (image.state === 'local') {
    return (
      <Button variant="outline" size="sm" disabled={publishPending} onClick={onPublish}>
        {t('admin.images.publish')}
      </Button>
    )
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={image.isDefault || defaultPending}
        onClick={onSetDefault}
      >
        {t('admin.images.setDefault')}
      </Button>
      <UnpublishButton
        image={image}
        pending={unpublishPending}
        onConfirm={onUnpublish}
      />
    </div>
  )
}

/**
 * 下架要确认：它会让用户面的「换版本」里少一个选项。默认版本不能下架——
 * 否则新建实例就没镜像了，服务端也会 400（这里直接把按钮禁掉）。
 */
function UnpublishButton({
  image,
  pending,
  onConfirm,
}: {
  image: AdminImage
  pending: boolean
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button variant="outline" size="sm" disabled={image.isDefault || pending} />}
      >
        {t('admin.images.unpublish')}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('admin.images.unpublishTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('admin.images.unpublishConfirm', { ref: image.ref })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('admin.images.unpublish')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
