import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { BrandMark } from '@/components/brand-mark.js'
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
} from '@/components/ui/alert-dialog.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent } from '@/components/ui/card.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js'
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
  ApiError,
  createInstance,
  listImages,
  listInstances,
  removeInstance,
  restartInstance,
  startInstance,
  stopInstance,
  type InstanceSummary,
} from '../lib/api.js'
import { formatMb } from '../lib/format.js'

const instancesKey = ['instances'] as const

const MEMORY_MB_OPTIONS = [2048, 4096, 8192]
const CPU_OPTIONS = [1, 2, 4]
const DISK_MB_OPTIONS = [5120, 10_240, 20_480]

/** 版本下拉里「不指定」的哨兵值——Select 不接受空字符串。 */
const DEFAULT_IMAGE = '__default__'

/** 镜像引用里的 tag 部分（仓库前缀对所有版本都一样，摆出来只是噪音）。 */
function tagOf(ref: string): string {
  return ref.slice(ref.lastIndexOf(':') + 1)
}

/** 编排还在跑：每 3 秒跟一次，等它落定。 */
const IN_FLIGHT_STATUSES = new Set(['provisioning', 'removing'])

/**
 * 其余状态每 10 秒兜底一次。**状态是查询时从 Docker 算的**，落定态也会漂：
 * 容器可能 crash-loop（running → restarting）、被外部停掉、或随宿主重启拉起。
 * 一旦停止轮询，这三种情况就会永远停在旧值——正是 d15probe crash-loop 时
 * 列表还写着「运行中」的原因。
 */
const IDLE_POLL_MS = 10_000

export default function InstancesPage() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const [slug, setSlug] = useState('')
  const [memoryMb, setMemoryMb] = useState(2048)
  const [cpus, setCpus] = useState(1)
  const [diskMb, setDiskMb] = useState(10_240)
  const [image, setImage] = useState(DEFAULT_IMAGE)
  const [createOpen, setCreateOpen] = useState(false)

  const instances = useQuery({
    queryKey: instancesKey,
    queryFn: listInstances,
    // 编排进行中每 3 秒跟一次；其余每 10 秒兜底（状态由服务端从 Docker 现算，会漂）
    refetchInterval: (query) => {
      const list = query.state.data
      if (list === undefined) return false
      return list.some((i) => IN_FLIGHT_STATUSES.has(i.status)) ? 3000 : IDLE_POLL_MS
    },
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: instancesKey })

  // 只在弹窗打开时拉：版本列表平时用不上
  const images = useQuery({
    queryKey: ['create-images'],
    queryFn: listImages,
    enabled: createOpen,
    staleTime: 60_000,
  })

  const create = useMutation({
    mutationFn: () =>
      createInstance({
        slug: slug.trim(),
        cpus,
        memoryMb,
        diskMb,
        // 没选具体版本就不带这个键，让服务端用平台默认版本（D21）
        ...(image === DEFAULT_IMAGE ? {} : { image }),
      }),
    onSuccess: async () => {
      setSlug('')
      setImage(DEFAULT_IMAGE)
      setCreateOpen(false)
      await invalidate()
    },
  })

  const restart = useMutation({
    mutationFn: (id: string) => restartInstance(id),
    onSuccess: invalidate,
  })

  const stop = useMutation({
    mutationFn: (id: string) => stopInstance(id),
    onSuccess: invalidate,
  })

  const start = useMutation({
    mutationFn: (id: string) => startInstance(id),
    onSuccess: invalidate,
  })

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

  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }

  const memoryOptions = MEMORY_MB_OPTIONS.map((mb) => ({
    label: t('instances.gigabytes', { count: mb / 1024 }),
    value: mb,
  }))
  const cpuOptions = CPU_OPTIONS.map((n) => ({
    label: t('instances.cores', { count: n }),
    value: n,
  }))
  const diskOptions = DISK_MB_OPTIONS.map((mb) => ({
    label: formatMb(mb),
    value: mb,
  }))

  const defaultRef = images.data?.default ?? null
  const versionOptions = [
    {
      label:
        defaultRef === null
          ? t('instances.versionDefaultPlain')
          : t('instances.versionDefault', { version: tagOf(defaultRef) }),
      value: DEFAULT_IMAGE,
    },
    // 默认版本已经单列一项，不再重复出现在下面
    ...(images.data?.published ?? [])
      .filter((ref) => ref !== defaultRef)
      .map((ref) => ({ label: tagOf(ref), value: ref })),
  ]

  const createForm = (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="slug">{t('instances.slug')}</FieldLabel>
          <Input
            id="slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value)
              // 输入变了，上一次的失败原因就不作数了
              if (create.isError) create.reset()
            }}
            placeholder={t('instances.slugPlaceholder')}
            pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
            minLength={3}
            maxLength={32}
            aria-invalid={create.isError}
            required
          />
          {create.isError ? (
            <p className="text-xs text-destructive">
              {create.error instanceof ApiError
                ? create.error.message
                : t('instances.createFailed')}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{t('instances.slugHint')}</p>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="version">{t('instances.version')}</FieldLabel>
          <Select
            items={versionOptions}
            value={image}
            onValueChange={(value) => {
              if (typeof value === 'string') setImage(value)
            }}
          >
            <SelectTrigger id="version" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {versionOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {images.data !== undefined && images.data.published.length === 0
              ? t('instances.versionEmpty')
              : t('instances.versionHint')}
          </p>
        </Field>

        <div className="flex gap-3">
          <Field className="flex-1">
            <FieldLabel htmlFor="memory">{t('instances.memory')}</FieldLabel>
            <Select
              items={memoryOptions}
              value={memoryMb}
              onValueChange={(value) => {
                if (typeof value === 'number') setMemoryMb(value)
              }}
            >
              <SelectTrigger id="memory" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {memoryOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field className="flex-1">
            <FieldLabel htmlFor="cpu">{t('instances.cpu')}</FieldLabel>
            <Select
              items={cpuOptions}
              value={cpus}
              onValueChange={(value) => {
                if (typeof value === 'number') setCpus(value)
              }}
            >
              <SelectTrigger id="cpu" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {cpuOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="disk">{t('instances.disk')}</FieldLabel>
          <Select
            items={diskOptions}
            value={diskMb}
            onValueChange={(value) => {
              if (typeof value === 'number') setDiskMb(value)
            }}
          >
            <SelectTrigger id="disk" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {diskOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('instances.diskHint')}</p>
        </Field>
      </FieldGroup>

      <DialogFooter className="mt-6">
        <DialogClose render={<Button type="button" variant="outline" />}>
          {t('common.cancel')}
        </DialogClose>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? t('instances.creating') : t('instances.create')}
        </Button>
      </DialogFooter>
    </form>
  )

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
              {createForm}
            </DialogContent>
          </Dialog>
        }
      />

      {instances.isPending && (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      )}
      {instances.isError && (
        <p className="text-sm text-destructive">{t('instances.loadFailed')}</p>
      )}

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
            onPurge={(confirmSlug) =>
              remove.mutate({ id: instance.id, purge: true, confirmSlug })
            }
          />
        ))}
      </div>
    </div>
  )
}

function InstanceCard({
  instance,
  busy,
  deleteError,
  onRestart,
  onStop,
  onStart,
  onDelete,
  onPurge,
}: {
  instance: InstanceSummary
  busy: boolean
  deleteError: string | null
  onRestart: () => void
  onStop: () => void
  onStart: () => void
  onDelete: () => void
  /** 连数据文件系统一起删——调用方已要求输入子域名确认。 */
  onPurge: (confirmSlug: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [purgeInput, setPurgeInput] = useState('')
  const { status } = instance
  const openable = status === 'running'
  // 创建中 / 删除中：编排还在跑，除了等什么都别做
  const transitioning = status === 'provisioning' || status === 'removing'
  const address = hostOf(instance.url)
  const createdAt = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(instance.createdAt))

  return (
    <Card size="sm">
      <CardContent className="flex flex-row items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <Link
              to={`/instances/${instance.id}`}
              className="truncate font-medium hover:underline"
            >
              {instance.slug}
            </Link>
            <StatusBadge status={instance.status} statusText={instance.statusText} />
          </div>
          {/* crash-loop 时把 Docker 的原文摆出来——「重启中」看不出它在循环 */}
          {instance.status === 'restarting' && instance.statusText !== null && (
            <p className="truncate font-mono text-xs text-destructive">{instance.statusText}</p>
          )}
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-xs text-muted-foreground">{address}</span>
            <CopyButton value={address} />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {t('instances.cores', { count: instance.cpus })} ·{' '}
            {t('instances.gigabytes', { count: Math.round(instance.memoryMb / 1024) })} ·{' '}
            {t('instances.diskGb', { size: formatMb(instance.diskMb) })} · {instance.image}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('instances.createdAt')} {createdAt}
          </p>
          {instance.lastError !== null && (
            <p className="truncate text-xs text-destructive">{instance.lastError}</p>
          )}
          {deleteError !== null && <p className="text-xs text-destructive">{deleteError}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {openable ? (
            <Button
              render={<a href={instance.url} target="_blank" rel="noreferrer" />}
              nativeButton={false}
            >
              {t('instances.open')}
            </Button>
          ) : status === 'stopped' ? (
            <Button onClick={onStart} disabled={busy}>
              <PlayIcon />
              {busy ? t('instances.working') : t('instances.start')}
            </Button>
          ) : (
            <Button onClick={onRestart} disabled={busy || transitioning}>
              <RotateCcwIcon />
              {busy ? t('instances.working') : t('instances.restart')}
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="icon" />}
              aria-label={t('instances.more')}
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              {openable && (
                <DropdownMenuItem onClick={onStop} disabled={busy}>
                  <PauseIcon />
                  {t('instances.stop')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onRestart} disabled={busy || transitioning}>
                <RotateCcwIcon />
                {t('instances.restart')}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
                disabled={busy || transitioning}
              >
                <Trash2Icon />
                {t('instances.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>

      {/* AlertDialogAction 不是 Close，确认后要自己关——所以 open 受控 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('instances.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('instances.deleteDescription', { slug: instance.slug })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:justify-between">
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={() => {
                setConfirmOpen(false)
                setPurgeOpen(true)
              }}
            >
              {t('instances.purge')}
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setConfirmOpen(false)
                  onDelete()
                }}
              >
                {t('instances.delete')}
              </AlertDialogAction>
            </div>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 不可逆：删卷，必须手打子域名 */}
      <AlertDialog
        open={purgeOpen}
        onOpenChange={(open) => {
          setPurgeOpen(open)
          if (!open) setPurgeInput('')
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('instances.purgeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('instances.purgeDescription', { slug: instance.slug })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor={`purge-${instance.id}`}>
              {t('instances.purgeConfirmLabel', { slug: instance.slug })}
            </FieldLabel>
            <Input
              id={`purge-${instance.id}`}
              value={purgeInput}
              onChange={(e) => setPurgeInput(e.target.value)}
              placeholder={instance.slug}
              autoComplete="off"
            />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={purgeInput !== instance.slug}
              onClick={() => {
                setPurgeOpen(false)
                setPurgeInput('')
                onPurge(purgeInput)
              }}
            >
              {t('instances.purge')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/** 从入口 URL 取出主机名——用户要复制的是地址，不是带 token 的完整路径。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? t('instances.copied') : t('instances.copy')}
    </Button>
  )
}

