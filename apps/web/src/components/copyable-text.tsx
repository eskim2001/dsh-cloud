import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { cn } from '@/lib/utils.js'

/**
 * 一行可复制的文本（实例域名、镜像 digest、卷标识）。
 *
 * 为什么要它：这些东西原先要么只挂在 tooltip 里（digest），要么得手动选中——运维要拿它
 * 去核对部署、贴进工单时，手选字符串是纯粹的摩擦。
 */
export function CopyableText({
  value,
  className,
  mono = true,
  children,
}: {
  /** 复制到剪贴板的内容（可以与显示的不一样，比如显示截断、复制完整）。 */
  value: string
  className?: string
  mono?: boolean
  children?: React.ReactNode
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // 非安全上下文（http）下 clipboard 不可用 —— 退回到"选中"，用户还能自己按 ⌘C。
      const el = document.createElement('textarea')
      el.value = value
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      el.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <span className={cn('truncate', mono && 'font-mono text-xs')}>{children ?? value}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        onClick={() => void copy()}
        aria-label={t('common.copy')}
        title={t('common.copy')}
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </span>
  )
}
