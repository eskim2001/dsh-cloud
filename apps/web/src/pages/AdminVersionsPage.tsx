import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontalIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CopyableText } from '@/components/copyable-text.js'
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
} from '@/components/ui/alert-dialog.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent } from '@/components/ui/card.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js'
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
} from '@/lib/api.js'

const versionsKey = ['admin', 'images'] as const

/** 服务端给的文案（如「上游没有镜像 …」）比笼统的「操作失败」有用。 */
function errorTextOf(error: unknown, fallback: string): string | null {
  if (error === null || error === undefined) return null
  return error instanceof ApiError ? error.message : fallback
}

/**
 * tag 形如 `<dsh版本>_<修订号>`（见 instance-spec 的 `isReleaseTag`）。
 * 拆开来给人看 —— `0.1.2-rc.1_2` 这种形状不解释很难读。
 */
function splitRef(ref: string): { tag: string; dsh: string | null; revision: string | null } {
  const tag = ref.slice(ref.lastIndexOf(':') + 1)
  const at = tag.lastIndexOf('_')
  if (at <= 0) return { tag, dsh: null, revision: null }
  return { tag, dsh: tag.slice(0, at), revision: tag.slice(at + 1) }
}

/** 表格里只摆 digest 的前 12 位十六进制——够认，又不会把列撑爆；复制走的是完整值。 */
function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, 12)
}

/**
 * 版本管理（D21 / D23）。
 *
 * 管理员的唯一问题：**我的用户能创建 / 升级到哪些 dsh 版本**。所以这一页是一张「货架」——
 * 每一行是一个版本，`上架` 就是摆上去、`下架` 就是撤下来，默认版本带一个醒目的标记。
 *
 * **刻意不暴露「本机缓存了没有」当门槛**：microsandbox 按需拉取（`create` 的 pullPolicy
 * 默认 `if-missing`），上架不要求先下载。缓存只作为一行安静的状态（`已预热`）+ 一个可选的
 * 加速动作出现 —— 老页面把「未下载 / 已下载 / 已发布」做成三态门槛，而 runtime 下「下载」
 * 是空操作，于是永远到不了「已发布」，整条链路死锁。
 *
 * 上架第一版时后端会自动把它设为默认，所以「已上架但一行默认都没有」这个死状态不存在。
 */
export default function AdminVersionsPage() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [warming, setWarming] = useState<string | null>(null)
  const [unpublishing, setUnpublishing] = useState<string | null>(null)

  const versions = useQuery({ queryKey: versionsKey, queryFn: getAdminImages })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: versionsKey })

  const check = useMutation({ mutationFn: syncAdminImages, onSuccess: invalidate })
  const publish = useMutation({ mutationFn: publishAdminImage, onSuccess: invalidate })
  const unpublish = useMutation({ mutationFn: unpublishAdminImage, onSuccess: invalidate })
  const setDefault = useMutation({ mutationFn: setDefaultAdminImage, onSuccess: invalidate })

  const failed = check.isError || publish.isError || unpublish.isError || setDefault.isError
  const rows = versions.data?.images ?? []
  const checkedAt = versions.data?.syncedAt ?? null
  /** 一版都没上架 = 用户开不出实例。空状态和提示都按它判，不是按「表里有没有行」。 */
  const hasPublished = rows.some((v) => v.published)

  const rowPending = (ref: string): boolean =>
    (publish.isPending && publish.variables === ref) ||
    (unpublish.isPending && unpublish.variables === ref) ||
    (setDefault.isPending && setDefault.variables === ref)

  return (
    <>
      <PageHeader
        title={t('admin.versions.title')}
        description={t('admin.versions.description')}
        actions={
          <>
            <span className="text-xs text-muted-foreground">
              {checkedAt === null
                ? t('admin.versions.neverChecked')
                : t('admin.versions.checkedAt', {
                    time: new Date(checkedAt).toLocaleString(i18n.language),
                  })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={check.isPending}
              onClick={() => check.mutate()}
            >
              {check.isPending ? t('admin.versions.checking') : t('admin.versions.check')}
            </Button>
          </>
        }
      />

      {failed && (
        <p className="mt-4 text-sm text-destructive">
          {errorTextOf(
            check.error ?? publish.error ?? unpublish.error ?? setDefault.error,
            t('admin.actionFailed'),
          )}
        </p>
      )}

      {check.data !== undefined && (
        <p className="mt-4 text-sm text-muted-foreground">
          {t('admin.versions.checkResult', { count: check.data.count })}
          {check.data.skipped > 0 &&
            t('admin.versions.checkSkipped', { skipped: check.data.skipped })}
        </p>
      )}

      <Card className="mt-6">
        <CardContent>
          {versions.isPending && (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
          {versions.isError && (
            <p className="text-sm text-destructive">{t('admin.versions.loadFailed')}</p>
          )}

          {versions.data !== undefined &&
            (rows.length === 0 ? (
              // 一行都没有：还没「检查更新」过，没什么可在表里上架的，给一个直接入口。
              <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-6">
                <div>
                  <p className="font-medium">{t('admin.versions.emptyTitle')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('admin.versions.emptyBody')}
                  </p>
                </div>
                <Button size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
                  {check.isPending ? t('admin.versions.checking') : t('admin.versions.check')}
                </Button>
              </div>
            ) : (
              <>
                {!hasPublished && (
                  <p className="mb-4 text-sm text-muted-foreground">
                    {t('admin.versions.emptyTitle')}
                  </p>
                )}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('admin.versions.ref')}</TableHead>
                      <TableHead className="hidden lg:table-cell">
                        {t('admin.versions.digest')}
                      </TableHead>
                      <TableHead>{t('admin.versions.state')}</TableHead>
                      <TableHead className="hidden sm:table-cell">
                        {t('admin.versions.publishedAt')}
                      </TableHead>
                      <TableHead className="text-right">{t('admin.versions.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((version) => (
                      <VersionRow
                        key={version.ref}
                        version={version}
                        locale={i18n.language}
                        pending={rowPending(version.ref)}
                        onPublish={() => publish.mutate(version.ref)}
                        onWarm={() => setWarming(version.ref)}
                        onSetDefault={() => setDefault.mutate(version.ref)}
                        onUnpublish={() => setUnpublishing(version.ref)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </>
            ))}
        </CardContent>
      </Card>

      {warming !== null && (
        <PullDialog
          imageRef={warming}
          open
          onOpenChange={(open) => {
            if (!open) setWarming(null)
          }}
          onSettled={invalidate}
        />
      )}

      {/* 下架要确认：用户面的「换版本」里会少一个选项。默认版本服务端会拒（行内也禁掉了）。 */}
      <AlertDialog
        open={unpublishing !== null}
        onOpenChange={(open) => {
          if (!open) setUnpublishing(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.versions.unpublishTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.versions.unpublishConfirm', { ref: unpublishing ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (unpublishing !== null) unpublish.mutate(unpublishing)
              }}
            >
              {t('admin.versions.unpublish')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * 一行的展示与操作。
 *
 * **不复用 `StatusBadge`** —— 那套绑的是实例的 `status.*` 键，和版本的
 * 「默认 / 已上架 / 未上架」不是一回事。
 */
function VersionRow({
  version,
  locale,
  pending,
  onPublish,
  onWarm,
  onSetDefault,
  onUnpublish,
}: {
  version: AdminImage
  locale: string
  pending: boolean
  onPublish: () => void
  onWarm: () => void
  onSetDefault: () => void
  onUnpublish: () => void
}) {
  const { t } = useTranslation()
  const { tag, dsh, revision } = splitRef(version.ref)

  return (
    <TableRow>
      <TableCell>
        {/* 认版本靠 tag；完整 ref 挂 title，不占列 */}
        <div className="font-mono text-sm" title={version.ref}>
          {tag}
        </div>
        {dsh !== null && revision !== null && (
          <div className="text-xs text-muted-foreground">
            {t('admin.versions.dshLine', { dsh, revision })}
          </div>
        )}
      </TableCell>

      {/* Digest 单列可复制：核对部署、给工单钉版本时要用的是它，不是下面那个 tag */}
      <TableCell className="hidden lg:table-cell">
        {version.digest === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <CopyableText value={version.digest}>{shortDigest(version.digest)}</CopyableText>
        )}
      </TableCell>

      <TableCell>
        {version.published ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={version.isDefault ? 'secondary' : 'outline'}>
              {version.isDefault
                ? t('admin.versions.stateLabel.default')
                : t('admin.versions.stateLabel.published')}
            </Badge>
            {version.onHost ? (
              <span
                className="text-xs text-muted-foreground"
                title={t('admin.versions.warmedHint')}
              >
                {t('admin.versions.warmed')}
              </span>
            ) : (
              // 没预热不是「状态」，但运维要判断「要不要现在拉」就得知道
              <span className="text-xs text-muted-foreground" title={t('admin.versions.notOnHost')}>
                —
              </span>
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t('admin.versions.stateLabel.unpublished')}
          </span>
        )}
      </TableCell>

      <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
        {version.publishedAt === null
          ? '—'
          : new Date(version.publishedAt).toLocaleString(locale)}
      </TableCell>

      <TableCell className="text-right">
        {!version.published ? (
          <Button variant="outline" size="sm" disabled={pending} onClick={onPublish}>
            {t('admin.versions.publish')}
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="icon" />}
              disabled={pending}
              aria-label={t('admin.versions.actions')}
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem disabled={version.isDefault || pending} onClick={onSetDefault}>
                {t('admin.versions.setDefault')}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={pending} onClick={onWarm}>
                {t('admin.versions.warm')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={version.isDefault || pending} onClick={onUnpublish}>
                {t('admin.versions.unpublish')}
              </DropdownMenuItem>
              {version.isDefault && (
                // 禁用按钮自己不解释原因，就在它下面说清楚 —— 比一个点不动的灰条有用。
                // **必须包在 Group 里**：`DropdownMenuLabel` 底下是 base-ui 的 `GroupLabel`，
                // 没有 `Group` 祖先会直接抛 `MenuGroupContext is missing`。
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    {t('admin.versions.unpublishDefault')}
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  )
}
