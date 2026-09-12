import { MoreHorizontalIcon, PauseIcon, PlayIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { CopyableText } from '@/components/copyable-text.js'
import { QuotaMeter } from '@/components/quota-meter.js'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js'
import { Field, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import type { InstanceSummary } from '@/lib/api.js'
import { hostOf } from '@/lib/format.js'
import { canOpen, isTransitioning } from '@/lib/instance-status.js'

/**
 * 列表里的一张实例卡片。第一屏要能回答三个问题：**在跑吗、地址是什么、磁盘还剩多少**，
 * 所以主按钮永远是「打开 dsh」（能打开时），其余动作（停止 / 重启 / 删除）收进 `⋯`。
 */
export function InstanceCard({
  instance,
  busy,
  deleteError,
  onRestart,
  onStop,
  onStart,
  onDelete,
}: {
  instance: InstanceSummary
  /** 这个实例上有正在飞的编排动作——按钮全禁掉，别叠加。 */
  busy: boolean
  /** 上次删除失败的原因（成功或换了别的操作就该消失）。 */
  deleteError: string | null
  onRestart: () => void
  onStop: () => void
  onStart: () => void
  /** 删除是**永久**的，调用方已经让用户手打过子域名。 */
  onDelete: (confirmSlug: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmInput, setConfirmInput] = useState('')
  const { status } = instance
  const openable = canOpen(status)
  // 创建中 / 删除中：编排还在跑，除了等什么都别做
  const transitioning = isTransitioning(status)
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
          <CopyableText value={address}>{address}</CopyableText>
          <p className="truncate text-xs text-muted-foreground">
            {t('instances.cores', { count: instance.cpus })} ·{' '}
            {t('instances.gigabytes', { count: Math.round(instance.memoryMb / 1024) })} ·{' '}
            {instance.image}
          </p>
          {/* 磁盘用量单列一行：配额是「写满就写不进去」，用户得在踩到之前看见它。
              读不到用量时这一行只剩「暂无数据」，所以必须带标签，否则像一句报错。 */}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <span className="text-xs text-muted-foreground">{t('instances.disk')}</span>
            <QuotaMeter
              usedMb={instance.diskUsedMb}
              quotaMb={instance.diskMb}
              enforced={instance.diskEnforced}
            />
          </div>
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

      {/*
        只有一道删除：**永久删除**（数据一起走）。所以确认必须够重 —— 手打子域名。
        从前这里是两道对话框（「删除」保留数据 / 「彻底删除」清数据），用户要在两个都叫
        "删除"的按钮里分辨哪个是哪个，而数据其实留着又没入口 —— 现在收敛成一条（D31）。

        AlertDialogAction 不是 Close，确认后要自己关，所以 open 受控。
      */}
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open)
          if (!open) setConfirmInput('')
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('instances.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('instances.deleteDescription', { slug: instance.slug })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor={`delete-${instance.id}`}>
              {t('instances.deleteConfirmLabel', { slug: instance.slug })}
            </FieldLabel>
            <Input
              id={`delete-${instance.id}`}
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={instance.slug}
              autoComplete="off"
            />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={confirmInput !== instance.slug}
              onClick={() => {
                setConfirmOpen(false)
                setConfirmInput('')
                onDelete(confirmInput)
              }}
            >
              {t('instances.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
