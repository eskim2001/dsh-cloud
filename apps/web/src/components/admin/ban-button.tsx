import { useState } from 'react'
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
import { Input } from '@/components/ui/input.js'

/** 封禁账号，要填原因（可选）。原因会存下来并显示在用户行上——封禁不是无声操作。 */
export function BanButton({
  email,
  pending,
  onConfirm,
}: {
  email: string
  pending: boolean
  onConfirm: (reason: string) => void
}) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>
        {t('admin.users.ban')}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('admin.users.banTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('admin.users.banDescription', { email })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={reason}
          placeholder={t('admin.users.banReasonPlaceholder')}
          onChange={(e) => setReason(e.target.value)}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm(reason)}>
            {t('admin.users.ban')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
