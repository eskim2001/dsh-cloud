import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  /** 右侧操作区，例如「新建」按钮。 */
  actions?: ReactNode
}

/** 每个页面顶部的统一标题区。页面内容不要自己写 h1。 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold">{title}</h1>
        {description !== undefined && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
