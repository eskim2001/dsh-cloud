import { useQuery } from '@tanstack/react-query'
import { ArrowRightIcon, HardDriveIcon, UsersIcon, WorkflowIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AdminMetricStrip, AdminPage } from '@/components/admin/admin-page.js'
import { Button } from '@/components/ui/button.js'
import { listAdminInstances, listAdminUsers } from '@/lib/api.js'
import { formatMb } from '@/lib/format.js'
import { needsAttention } from '@/lib/instance-status.js'
import { keys } from '@/lib/query-keys.js'

export default function AdminOverviewPage() {
  const { t } = useTranslation()
  const instances = useQuery({ queryKey: keys.adminInstances, queryFn: listAdminInstances })
  const users = useQuery({ queryKey: keys.adminUsers, queryFn: listAdminUsers })
  const workspaces = instances.data ?? []
  const usedStorage = workspaces.reduce((total, item) => total + (item.diskUsedMb ?? 0), 0)
  const attention = workspaces.filter(needsAttention).length

  return <AdminPage title={t('admin.overview.title')} description={t('admin.overview.description')}>
    <AdminMetricStrip items={[
      { icon: WorkflowIcon, label: t('admin.overview.workspaces'), value: instances.isPending ? '—' : workspaces.length, detail: t('admin.overview.attention', { count: attention }) },
      { icon: UsersIcon, label: t('admin.overview.users'), value: users.isPending ? '—' : users.data?.users.length ?? 0, detail: t('admin.overview.activeUsers') },
      { icon: HardDriveIcon, label: t('admin.overview.storage'), value: instances.isPending ? '—' : formatMb(usedStorage), detail: t('admin.overview.measured') },
    ]} />
    <section><h2 className="text-sm font-medium">{t('admin.overview.operations')}</h2><div className="mt-4 border-t">
      <AdminLink to="/admin/instances" title={t('nav.adminInstances')} body={t('admin.overview.manageWorkspaces')} />
      <AdminLink to="/admin/users" title={t('nav.adminUsers')} body={t('admin.overview.manageUsers')} />
      <AdminLink to="/admin/versions" title={t('nav.adminVersions')} body={t('admin.overview.manageVersions')} />
    </div></section>
  </AdminPage>
}

function AdminLink({ to, title, body }: { to: string; title: string; body: string }) { return <div className="flex items-center justify-between gap-4 border-b py-5"><div><p className="text-sm font-medium">{title}</p><p className="mt-1 text-xs text-muted-foreground">{body}</p></div><Button variant="ghost" size="icon" render={<Link to={to} />} nativeButton={false} aria-label={title}><ArrowRightIcon /></Button></div> }