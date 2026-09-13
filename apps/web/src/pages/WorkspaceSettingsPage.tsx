import { useQuery } from '@tanstack/react-query'
import { ArrowLeftIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { VersionCard } from '@/components/instances/version-card.js'
import { LogPanel } from '@/components/log-panel.js'
import { QuotaMeter } from '@/components/quota-meter.js'
import { StatusBadge } from '@/components/status-badge.js'
import { getInstance } from '@/lib/api.js'
import { formatMb } from '@/lib/format.js'
import { keys } from '@/lib/query-keys.js'

export default function WorkspaceSettingsPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation()
  const instance = useQuery({ queryKey: keys.instance(id), queryFn: () => getInstance(id), enabled: id !== '' })
  if (instance.data === undefined) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  const item = instance.data

  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 py-4 md:py-8">
    <Link to={`/workspaces/${id}`} className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-4" />{item.slug}</Link>
    <header><h1 className="text-2xl font-medium">{t('workspaceSettings.title')}</h1><p className="mt-2 text-sm text-muted-foreground">{t('workspaceSettings.subtitle')}</p></header>
    <SettingsSection title={t('workspaceSettings.general')}><SettingRow label={t('workspaceCreate.name')} value={item.slug} /></SettingsSection>
    <SettingsSection title={t('workspaceSettings.storage')}><div className="flex flex-col gap-3"><QuotaMeter usedMb={item.diskUsedMb} quotaMb={item.diskMb} enforced={item.diskEnforced} /><p className="text-xs text-muted-foreground">{item.diskUsedMb === undefined ? t('instanceDetail.noData') : t('workspaceSettings.storageUsed', { used: formatMb(item.diskUsedMb), total: item.diskEnforced ? formatMb(item.diskMb) : t('workspaceSettings.unlimited') })}</p></div></SettingsSection>
    <SettingsSection title={t('workspaceSettings.runtime')}><div className="flex items-center justify-between"><StatusBadge status={item.status} statusText={item.statusText} /></div><VersionCard id={id} instance={item} /></SettingsSection>
    <details className="border-y py-5"><summary className="cursor-pointer text-sm font-medium">{t('workspaceSettings.advanced')}</summary><div className="mt-6 space-y-6"><div className="grid gap-4 text-sm sm:grid-cols-3"><SettingRow label="CPU" value={`${item.cpus}`} /><SettingRow label={t('instances.memory')} value={formatMb(item.memoryMb)} /><SettingRow label={t('instances.disk')} value={formatMb(item.diskMb)} /></div>{item.hasContainer && <LogPanel key={item.status} src={`/api/instances/${id}/logs?tail=200`} />}</div></details>
  </div>
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) { return <section className="grid gap-5 border-t pt-6 sm:grid-cols-[140px_1fr]"><h2 className="text-sm font-medium">{title}</h2><div className="min-w-0 space-y-5">{children}</div></section> }
function SettingRow({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-sm">{value}</p></div> }