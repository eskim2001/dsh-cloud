import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import type { AdminUser } from '@/lib/api.js'

/**
 * 改**用户的上限**（能开几个实例）。
 *
 * 留空 = 用平台默认上限（placeholder 显示默认值）—— 这是"没有个人覆盖"的表达方式，
 * 所以空值要能提交（`onSave(null)`），不能当成非法输入。
 */
export function UserQuotaEditor({
  user,
  fallback,
  pending,
  onSave,
}: {
  user: AdminUser
  /** 平台默认上限，显示在 placeholder 里。 */
  fallback: number
  pending: boolean
  /** `null` = 清掉个人覆盖，回落平台默认。 */
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
