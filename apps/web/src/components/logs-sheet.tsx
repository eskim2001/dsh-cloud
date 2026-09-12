import { useTranslation } from 'react-i18next'
import { LogPanel } from '@/components/log-panel.js'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet.js'

/** 谁在看日志 —— 决定走哪条接口（用户面 / 管理面）。 */
export type LogsScope = 'user' | 'admin'

export interface LogsTarget {
  id: string
  slug: string
  scope: LogsScope
}

/**
 * 日志抽屉。**列表页与详情页共用同一个**（原先只有管理面的实例表挂了日志弹窗，
 * 用户列表要看日志得先进详情页）。
 *
 * 关掉即卸载 → `LogPanel` 的 `useEffect` 清理里 `es.close()`，EventSource 跟着断，
 * 不会留一条后台连接。
 */
export function LogsSheet({ target, onClose }: { target: LogsTarget | null; onClose: () => void }) {
  const { t } = useTranslation()
  const base = target?.scope === 'admin' ? '/api/admin/instances' : '/api/instances'

  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent side="right" className="w-full gap-3 sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>
            {t('logs.title')} · {target?.slug}
          </SheetTitle>
          {/* 管理面看日志要顺带说清边界：日志能读，实例里的 /data 不能浏览。 */}
          {target?.scope === 'admin' && (
            <SheetDescription>{t('admin.instances.logHint')}</SheetDescription>
          )}
        </SheetHeader>
        {target !== null && <LogPanel src={`${base}/${target.id}/logs?tail=200`} />}
      </SheetContent>
    </Sheet>
  )
}
