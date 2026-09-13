import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { PageHeader } from '@/components/page-header.js'
import { cn } from '@/lib/utils.js'

export function AdminPage({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 py-4 md:py-8">
      <PageHeader
        title={title}
        {...(description === undefined ? {} : { description })}
        {...(actions === undefined ? {} : { actions })}
      />
      {children}
    </div>
  )
}

export function AdminMetricStrip({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; icon: LucideIcon; detail?: string; alert?: boolean }>
}) {
  return (
    <div className="grid border-y sm:grid-cols-3">
      {items.map(({ label, value, icon: Icon, detail, alert }) => (
        <div
          key={label}
          className="flex min-h-24 items-center gap-4 border-b py-5 sm:border-r sm:border-b-0 sm:px-6 first:pl-0 last:border-r-0"
        >
          <Icon className={cn('size-4 text-muted-foreground', alert && 'text-destructive')} />
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-medium tabular-nums">{value}</p>
            {detail !== undefined && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
          </div>
        </div>
      ))}
    </div>
  )
}

export function AdminTableSection({
  toolbar,
  children,
}: {
  toolbar?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      {toolbar !== undefined && (
        <div className="flex flex-col justify-between gap-4 border-b pb-4 lg:flex-row lg:items-center">
          {toolbar}
        </div>
      )}
      <div className="min-w-0">{children}</div>
    </section>
  )
}
