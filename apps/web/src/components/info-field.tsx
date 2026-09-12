import { cn } from '@/lib/utils.js'

/**
 * 一行「标签 + 值」。详情页的信息块用它。
 *
 * 别和 `components/ui/field.tsx` 搞混：那个是**表单**字段（label + input + 校验提示），
 * 这个是只读的展示行。
 */
export function InfoField({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  )
}
