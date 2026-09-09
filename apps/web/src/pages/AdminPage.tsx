import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { LogPanel } from '@/components/log-panel.js'
import { PageHeader } from '@/components/page-header.js'
import { StatusBadge } from '@/components/status-badge.js'
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.js'
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
  banUser,
  getAdminInstanceImage,
  listAdminInstances,
  listAdminUsers,
  rollbackAdminInstanceImage,
  setAdminInstanceImage,
  setInstanceQuota,
  setUserQuota,
  setUserRole,
  unbanUser,
  type AdminInstance,
  type AdminUser,
} from '@/lib/api.js'
import { formatMb } from '@/lib/format.js'
import { sessionKey, useSession } from '@/lib/use-session.js'

const usersKey = ['admin', 'users'] as const
const instancesKey = ['admin', 'instances'] as const

/** 服务端给的文案（如「已用 200 MB，不能缩到 128 MB」）比笼统的「操作失败」有用。 */
function errorTextOf(error: unknown, fallback: string): string | null {
  if (error === null || error === undefined) return null
  return error instanceof ApiError ? error.message : fallback
}

/**
 * 平台管理面。能改账号与配额、能看全站实例状态与容器日志；
 * **不能直接浏览用户实例里的 `/data`**——那是隔离边界，不是权限问题。
 */
export default function AdminPage() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const session = useSession()

  const users = useQuery({ queryKey: usersKey, queryFn: listAdminUsers })
  // 实例状态由服务端从 Docker 现算，会漂（crash-loop / 外部停掉 / 宿主重启）→ 低频兜底
  const instances = useQuery({
    queryKey: instancesKey,
    queryFn: listAdminInstances,
    refetchInterval: 10_000,
  })

  /** 正在看日志的实例（null = 对话框关着）。 */
  const [logTarget, setLogTarget] = useState<{ id: string; slug: string } | null>(null)
  /** 正在改配额的实例（null = 对话框关着）。 */
  const [quotaTarget, setQuotaTarget] = useState<AdminInstance | null>(null)
  /** 正在改镜像的实例（null = 对话框关着）。 */
  const [imageTarget, setImageTarget] = useState<AdminInstance | null>(null)

  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: usersKey })
  const invalidateInstances = () => queryClient.invalidateQueries({ queryKey: instancesKey })

  const ban = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => banUser(id, reason),
    onSuccess: invalidateUsers,
  })
  const unban = useMutation({ mutationFn: unbanUser, onSuccess: invalidateUsers })
  const quota = useMutation({
    mutationFn: ({ id, value }: { id: string; value: number | null }) =>
      setUserQuota(id, value),
    onSuccess: invalidateUsers,
  })
  const role = useMutation({
    mutationFn: ({ id, next }: { id: string; next: 'user' | 'admin' }) =>
      setUserRole(id, next),
    onSuccess: (_result, variables) => {
      // 降的是自己：下一个 /api/admin/* 请求就 403，别去刷列表，直接回首页
      if (variables.id === session.data?.id) {
        void queryClient.invalidateQueries({ queryKey: sessionKey })
        navigate('/')
        return
      }
      void invalidateUsers()
    },
  })
  const instanceQuota = useMutation({
    mutationFn: ({
      id,
      value,
    }: {
      id: string
      value: { cpus: number; memoryMb: number; pidsLimit: number; diskMb: number }
    }) => setInstanceQuota(id, value),
    onSuccess: invalidateInstances,
  })
  const instanceImage = useMutation({
    mutationFn: ({ id, image }: { id: string; image: string }) => setAdminInstanceImage(id, image),
    onSuccess: invalidateInstances,
  })
  const instanceRollback = useMutation({
    mutationFn: rollbackAdminInstanceImage,
    onSuccess: invalidateInstances,
  })

  // 服务端文案（如「不能降级最后一名管理员」）比笼统的「操作失败」有用
  const failed = ban.isError || unban.isError || quota.isError || role.isError

  return (
    <>
      <PageHeader title={t('admin.title')} description={t('admin.description')} />

      {failed && (
        <p className="mb-4 text-sm text-destructive">
          {errorTextOf(
            role.error ?? ban.error ?? unban.error ?? quota.error,
            t('admin.actionFailed'),
          )}
        </p>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t('admin.users.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {users.isPending && (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
          {users.isError && <p className="text-sm text-destructive">{t('admin.users.loadFailed')}</p>}

          {users.data !== undefined && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.users.user')}</TableHead>
                  <TableHead>{t('admin.users.instances')}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t('admin.users.quota')}</TableHead>
                  <TableHead>{t('admin.users.status')}</TableHead>
                  <TableHead className="text-right">{t('admin.users.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data.users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{user.email}</span>
                        {user.role === 'admin' && (
                          <Badge variant="secondary">{t('admin.users.admin')}</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{user.name}</div>
                    </TableCell>
                    <TableCell>{user.instanceCount}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <QuotaEditor
                        user={user}
                        fallback={users.data.maxInstancesPerUser}
                        pending={quota.isPending && quota.variables?.id === user.id}
                        onSave={(value) => quota.mutate({ id: user.id, value })}
                      />
                    </TableCell>
                    <TableCell>
                      {user.banned ? (
                        <div className="flex flex-col gap-1">
                          <Badge variant="destructive">{t('admin.users.banned')}</Badge>
                          {user.banReason !== null && (
                            <span className="text-xs text-muted-foreground">{user.banReason}</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {t('admin.users.active')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <RoleButton
                          isAdmin={user.role === 'admin'}
                          self={user.id === session.data?.id}
                          email={user.email}
                          pending={role.isPending && role.variables?.id === user.id}
                          onConfirm={() =>
                            role.mutate({
                              id: user.id,
                              next: user.role === 'admin' ? 'user' : 'admin',
                            })
                          }
                        />
                        {user.banned ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={unban.isPending && unban.variables === user.id}
                            onClick={() => unban.mutate(user.id)}
                          >
                            {t('admin.users.unban')}
                          </Button>
                        ) : (
                          <BanButton
                            email={user.email}
                            pending={ban.isPending && ban.variables?.id === user.id}
                            onConfirm={(reason) => ban.mutate({ id: user.id, reason })}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('admin.instances.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {instances.isPending && (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
          {instances.isError && (
            <p className="text-sm text-destructive">{t('admin.instances.loadFailed')}</p>
          )}

          {instances.data !== undefined && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.instances.slug')}</TableHead>
                  <TableHead>{t('admin.instances.owner')}</TableHead>
                  <TableHead>{t('admin.instances.status')}</TableHead>
                  <TableHead className="hidden md:table-cell">
                    {t('admin.instances.spec')}
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">
                    {t('admin.instances.createdAt')}
                  </TableHead>
                  <TableHead>{t('admin.instances.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {instances.data.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.slug}</TableCell>
                    <TableCell className="text-muted-foreground">{item.ownerEmail}</TableCell>
                    <TableCell>
                      <StatusBadge status={item.status} statusText={item.statusText} />
                      {item.status === 'restarting' && item.statusText !== null && (
                        <div className="mt-1 font-mono text-xs text-destructive">
                          {item.statusText}
                        </div>
                      )}
                      {item.lastError !== null && (
                        <div className="mt-1 text-xs text-destructive">{item.lastError}</div>
                      )}
                    </TableCell>
                    {/* 规格串很长，允许换行，否则这一列会把整张表撑出卡片 */}
                    <TableCell className="hidden text-muted-foreground md:table-cell whitespace-normal">
                      {t('instances.cores', { count: item.cpus })} ·{' '}
                      {t('instances.gigabytes', { count: Math.round(item.memoryMb / 1024) })} ·{' '}
                      {t('instances.diskGb', { size: formatMb(item.diskMb) })} · {item.image}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {new Date(item.createdAt).toLocaleString(i18n.language)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setQuotaTarget(item)}>
                          {t('admin.instances.editQuota')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setImageTarget(item)}>
                          {t('admin.instances.editImage')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setLogTarget({ id: item.id, slug: item.slug })}
                        >
                          {t('admin.instances.logs')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={logTarget !== null}
        onOpenChange={(open) => {
          if (!open) setLogTarget(null)
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {t('admin.instances.logs')} · {logTarget?.slug}
            </DialogTitle>
            <DialogDescription>{t('admin.instances.logHint')}</DialogDescription>
          </DialogHeader>
          {/* 关掉对话框就卸载，EventSource 跟着断——别让日志流在后台一直挂着 */}
          {logTarget !== null && (
            <LogPanel src={`/api/admin/instances/${logTarget.id}/logs?tail=200`} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={quotaTarget !== null}
        onOpenChange={(open) => {
          if (!open) setQuotaTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('admin.instances.quotaTitle')} · {quotaTarget?.slug}
            </DialogTitle>
            <DialogDescription>{t('admin.instances.quotaHint')}</DialogDescription>
          </DialogHeader>
          {quotaTarget !== null && (
            <InstanceQuotaForm
              key={quotaTarget.id}
              item={quotaTarget}
              pending={instanceQuota.isPending}
              error={errorTextOf(instanceQuota.error, t('admin.actionFailed'))}
              onSubmit={(value) =>
                instanceQuota.mutate(
                  { id: quotaTarget.id, value },
                  { onSuccess: () => setQuotaTarget(null) },
                )
              }
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={imageTarget !== null}
        onOpenChange={(open) => {
          if (!open) setImageTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('admin.instances.imageTitle')} · {imageTarget?.slug}
            </DialogTitle>
            <DialogDescription>{t('admin.instances.imageHint')}</DialogDescription>
          </DialogHeader>
          {imageTarget !== null && (
            <InstanceImageForm
              key={imageTarget.id}
              item={imageTarget}
              pending={instanceImage.isPending}
              error={errorTextOf(instanceImage.error, t('admin.actionFailed'))}
              rollbackPending={instanceRollback.isPending}
              rollbackError={errorTextOf(instanceRollback.error, t('admin.actionFailed'))}
              onApply={(image) =>
                instanceImage.mutate(
                  { id: imageTarget.id, image },
                  { onSuccess: () => setImageTarget(null) },
                )
              }
              onRollback={() =>
                instanceRollback.mutate(imageTarget.id, {
                  onSuccess: () => setImageTarget(null),
                })
              }
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 留空 = 用平台默认上限（placeholder 显示默认值）。 */
function QuotaEditor({
  user,
  fallback,
  pending,
  onSave,
}: {
  user: AdminUser
  fallback: number
  pending: boolean
  onSave: (value: number | null) => void
}) {
  const { t } = useTranslation()
  const stored = user.instanceQuota === null ? '' : String(user.instanceQuota)
  const [value, setValue] = useState(stored)
  const parsed = value === '' ? null : Number(value)
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100)
  const dirty = value !== stored

  return (
    <div className="flex items-center gap-2">
      <Input
        className="w-16"
        inputMode="numeric"
        value={value}
        placeholder={String(fallback)}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={!dirty || !valid || pending}
        onClick={() => onSave(parsed)}
      >
        {t('admin.users.saveQuota')}
      </Button>
    </div>
  )
}

/**
 * 管理员改实例资源配额（D17 / D18）。上限比用户自助创建的宽（64 核 / 256GB / 1TB 磁盘）。
 * CPU、内存、进程数变化会**重建容器**；磁盘扩容不停机，缩容要停机——提示里要写清楚。
 */
function InstanceQuotaForm({
  item,
  pending,
  error,
  onSubmit,
}: {
  item: AdminInstance
  pending: boolean
  error: string | null
  onSubmit: (value: {
    cpus: number
    memoryMb: number
    pidsLimit: number
    diskMb: number
  }) => void
}) {
  const { t } = useTranslation()
  const [cpus, setCpus] = useState(String(item.cpus))
  const [memoryMb, setMemoryMb] = useState(String(item.memoryMb))
  const [pidsLimit, setPidsLimit] = useState(String(item.pidsLimit))
  const [diskMb, setDiskMb] = useState(String(item.diskMb))

  const value = {
    cpus: Number(cpus),
    memoryMb: Number(memoryMb),
    pidsLimit: Number(pidsLimit),
    diskMb: Number(diskMb),
  }
  const valid =
    Number.isFinite(value.cpus) &&
    value.cpus > 0 &&
    value.cpus <= 64 &&
    Number.isInteger(value.memoryMb) &&
    value.memoryMb > 0 &&
    value.memoryMb <= 262_144 &&
    Number.isInteger(value.pidsLimit) &&
    value.pidsLimit > 0 &&
    value.pidsLimit <= 4_096 &&
    Number.isInteger(value.diskMb) &&
    value.diskMb >= 128 &&
    value.diskMb <= 1_048_576
  const dirty =
    value.cpus !== item.cpus ||
    value.memoryMb !== item.memoryMb ||
    value.pidsLimit !== item.pidsLimit ||
    value.diskMb !== item.diskMb

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && dirty) onSubmit(value)
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="quota-cpus">{t('admin.instances.cpus')}</FieldLabel>
          <Input
            id="quota-cpus"
            inputMode="decimal"
            value={cpus}
            onChange={(e) => setCpus(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="quota-memory">{t('admin.instances.memoryMb')}</FieldLabel>
          <Input
            id="quota-memory"
            inputMode="numeric"
            value={memoryMb}
            onChange={(e) => setMemoryMb(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="quota-pids">{t('admin.instances.pidsLimit')}</FieldLabel>
          <Input
            id="quota-pids"
            inputMode="numeric"
            value={pidsLimit}
            onChange={(e) => setPidsLimit(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="quota-disk">{t('admin.instances.diskMb')}</FieldLabel>
          <Input
            id="quota-disk"
            inputMode="numeric"
            value={diskMb}
            onChange={(e) => setDiskMb(e.target.value)}
          />
        </Field>
      </FieldGroup>

      {error !== null && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button type="submit" disabled={!dirty || !valid || pending}>
          {t('admin.users.saveQuota')}
        </Button>
      </div>
    </form>
  )
}

/**
 * 管理员换镜像（D19）。可选宿主上**全部**本地 tag——用户面只给稳定版白名单。
 * 换镜像先打数据快照，所以失败能自动回滚；快照占用也在这里显示。
 */
function InstanceImageForm({
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
    queryKey: ['admin', 'instance-image', item.id],
    queryFn: () => getAdminInstanceImage(item.id),
  })

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

/**
 * 授予 / 撤销管理员。两个方向都弹确认——提权和降权都是敏感动作。
 * 「不能降级最后一名管理员」由后端拦（400），文案显示在页面顶部。
 */
function RoleButton({
  isAdmin,
  self,
  email,
  pending,
  onConfirm,
}: {
  isAdmin: boolean
  self: boolean
  email: string
  pending: boolean
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const label = isAdmin ? t('admin.users.revokeAdmin') : t('admin.users.grantAdmin')

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} />}>
        {label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}</AlertDialogTitle>
          <AlertDialogDescription>
            {isAdmin
              ? t('admin.users.revokeAdminConfirm', { email })
              : t('admin.users.grantAdminConfirm', { email })}
            {self && isAdmin && (
              <span className="mt-1 block">{t('admin.users.selfDemoteHint')}</span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{label}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function BanButton({
  email,
  pending,
  onConfirm,
}: {
  email: string
  pending: boolean
  onConfirm: (reason: string) => void
}) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>
        {t('admin.users.ban')}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('admin.users.banTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('admin.users.banDescription', { email })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={reason}
          placeholder={t('admin.users.banReasonPlaceholder')}
          onChange={(e) => setReason(e.target.value)}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm(reason)}>
            {t('admin.users.ban')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
