import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/page-header.js'
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
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Card, CardContent } from '@/components/ui/card.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.js'
import { listSessions, revokeSession, type SessionSummary } from '@/lib/api.js'
import { describeUserAgent } from '@/lib/user-agent.js'

const sessionsKey = ['sessions'] as const

export default function SessionsPage() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const sessions = useQuery({ queryKey: sessionsKey, queryFn: listSessions })

  const revoke = useMutation({
    mutationFn: revokeSession,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionsKey }),
  })

  // 当前设备置顶，其余按最近登录排——用户最想先看到「最近是谁登的」
  const rows = useMemo(() => {
    const data = sessions.data ?? []
    return [...data].sort((a, b) =>
      a.current !== b.current ? (a.current ? -1 : 1) : b.createdAt.localeCompare(a.createdAt),
    )
  }, [sessions.data])

  return (
    <>
      <PageHeader
        title={t('settings.sessions.title')}
        description={t('settings.sessions.description')}
      />
      <Card>
        <CardContent>
          {revoke.isError && (
            <p className="mb-4 text-sm text-destructive">
              {t('settings.sessions.revokeFailed')}
            </p>
          )}
          {sessions.isPending && (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
          {sessions.isError && (
            <p className="text-sm text-destructive">{t('settings.sessions.loadFailed')}</p>
          )}

          {sessions.data !== undefined && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('settings.sessions.device')}</TableHead>
                  <TableHead className="hidden sm:table-cell">
                    {t('settings.sessions.ip')}
                  </TableHead>
                  <TableHead className="hidden md:table-cell">
                    {t('settings.sessions.signedInAt')}
                  </TableHead>
                  <TableHead className="text-right">
                    {t('settings.sessions.actions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="font-medium">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>
                          {describeUserAgent(session.userAgent) ||
                            t('settings.sessions.unknownDevice')}
                        </span>
                        {session.current && (
                          <Badge variant="secondary">{t('settings.sessions.current')}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {session.ipAddress ?? '—'}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {new Date(session.createdAt).toLocaleString(i18n.language)}
                    </TableCell>
                    <TableCell className="text-right">
                      {!session.current && (
                        <RevokeSessionButton
                          session={session}
                          pending={revoke.isPending && revoke.variables === session.id}
                          onConfirm={() => revoke.mutate(session.id)}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  )
}

function RevokeSessionButton({
  session,
  pending,
  onConfirm,
}: {
  session: SessionSummary
  pending: boolean
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const device =
    describeUserAgent(session.userAgent) || t('settings.sessions.unknownDevice')

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>
        {t('settings.sessions.revoke')}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('settings.sessions.revokeTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('settings.sessions.revokeDescription', { device })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('settings.sessions.revoke')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
