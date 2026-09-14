import { MoreHorizontalIcon, PauseIcon, PlayIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
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
import { Button, buttonVariants } from '@/components/ui/button.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js'
import { Field, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import type { InstanceSummary } from '@/lib/api.js'
import { formatMb } from '@/lib/format.js'
import { canOpen, isTransitioning } from '@/lib/instance-status.js'
import { cn } from '@/lib/utils.js'

export function InstanceCard({
  instance,
  busy,
  deleteError,
  onRestart,
  onStop,
  onStart,
  onDelete,
  compact = false,
  className,
}: {
  instance: InstanceSummary
  busy: boolean
  deleteError: string | null
  onRestart: () => void
  onStop: () => void
  onStart: () => void
  onDelete: (confirmSlug: string) => void
  compact?: boolean
  className?: string
}) {
  const { t, i18n } = useTranslation()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmInput, setConfirmInput] = useState('')
  const { status } = instance
  const openable = canOpen(status)
  const transitioning = isTransitioning(status)
  const lastUsedAt = instance.stoppedAt ?? instance.createdAt
  const lastUsed = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' }).format(
    -Math.max(1, Math.round((Date.now() - new Date(lastUsedAt).getTime()) / 86_400_000)),
    'day',
  )

  const version = instance.image.slice(instance.image.lastIndexOf(':') + 1)

  return (
    <div className={cn("group flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 transition-colors hover:bg-muted/40", className)}>
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <Link
            to={`/workspaces/${instance.id}`}
            className="truncate text-base font-medium text-foreground transition-colors hover:text-primary"
          >
            {instance.slug}
          </Link>
          <StatusBadge status={instance.status} statusText={instance.statusText} />
        </div>
        
        <div className="flex items-center gap-3 text-[13px] flex-wrap">
          <div className="flex items-center gap-1 text-muted-foreground font-mono">
            <span className="opacity-70">ID:</span>
            <span>{instance.id.slice(0, 8)}</span>
          </div>
          
          <div className="size-1 rounded-full bg-border" />
          
          <div className="flex items-center gap-1 text-muted-foreground font-mono" title={instance.image}>
            <span>{version}</span>
          </div>
          
          <div className="size-1 rounded-full bg-border" />
          
          <div className="flex items-center text-muted-foreground tabular-nums">
            <span>{instance.cpus}C / {formatMb(instance.memoryMb)} RAM / {formatMb(instance.diskMb)} Disk</span>
          </div>
          
          <div className="size-1 rounded-full bg-border hidden sm:block" />
          
          <span className="text-muted-foreground w-full sm:w-auto mt-1 sm:mt-0">
            {t('instances.lastUsed', { defaultValue: 'Last used {{time}}', time: lastUsed })}
          </span>
        </div>

        {instance.status === 'restarting' && instance.statusText !== null && (
          <p className="truncate font-mono text-xs text-destructive bg-destructive/5 px-2 py-1 rounded w-fit">{instance.statusText}</p>
        )}
        {instance.lastError !== null && (
          <p className="truncate text-xs text-destructive">{instance.lastError}</p>
        )}
        {deleteError !== null && <p className="text-xs text-destructive">{deleteError}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {compact ? (
          <Button variant="secondary" className="h-8 px-4 text-[13px] shadow-none" render={<Link to={`/workspaces/${instance.id}/open`} />} nativeButton={false}>
            {t('instances.open')}
          </Button>
        ) : openable ? (
          <Button variant="secondary" className="h-8 px-4 text-[13px] shadow-none" render={<Link to={`/workspaces/${instance.id}/open`} />} nativeButton={false}>
            {t('instances.open')}
          </Button>
        ) : status === 'stopped' ? (
          <Button variant="outline" className="h-8 px-4 text-[13px] shadow-none" onClick={onStart} disabled={busy}>
            <PlayIcon className="size-3.5 mr-1.5" />
            {busy ? t('instances.working') : t('instances.start')}
          </Button>
        ) : (
          <Button variant="outline" className="h-8 px-4 text-[13px] shadow-none" onClick={onRestart} disabled={busy || transitioning}>
            <RotateCcwIcon className="size-3.5 mr-1.5" />
            {busy ? t('instances.working') : t('instances.restart')}
          </Button>
        )}

        {!compact && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" />}
              aria-label={t('instances.more')}
            >
              <MoreHorizontalIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              {openable && (
                <DropdownMenuItem onClick={onStop} disabled={busy} className="text-xs">
                  <PauseIcon className="size-3.5 mr-2" />
                  {t('instances.stop')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onRestart} disabled={busy || transitioning} className="text-xs">
                <RotateCcwIcon className="size-3.5 mr-2" />
                {t('instances.restart')}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
                disabled={busy || transitioning}
                className="text-xs text-destructive focus:text-destructive"
              >
                <Trash2Icon className="size-3.5 mr-2" />
                {t('instances.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

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
          <Field className="my-2">
            <FieldLabel htmlFor={`delete-${instance.id}`} className="text-xs font-medium">
              {t('instances.deleteConfirmLabel', { slug: instance.slug })}
            </FieldLabel>
            <Input
              id={`delete-${instance.id}`}
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={instance.slug}
              autoComplete="off"
              className="mt-2 h-9 text-sm font-mono"
            />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-9 text-xs">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={confirmInput !== instance.slug}
              className="h-9 text-xs"
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
    </div>
  )
}
