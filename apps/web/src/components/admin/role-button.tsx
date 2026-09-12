import { useTranslation } from 'react-i18next'
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
import { Button } from '@/components/ui/button.js'

/**
 * 授予 / 撤销管理员。**两个方向都弹确认**——提权和降权都是敏感动作，
 * 误点一下就把全站权限给出去了。
 *
 * 「不能降级最后一名管理员」由后端拦（400），文案显示在页面顶部。
 */
export function RoleButton({
  isAdmin,
  self,
  email,
  pending,
  onConfirm,
}: {
  isAdmin: boolean
  /** 改的是自己的账号吗——降自己会立刻失去管理台权限。 */
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
