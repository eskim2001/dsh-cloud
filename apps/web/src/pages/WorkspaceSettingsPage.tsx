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

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 pt-6 md:pt-8 relative z-10 pb-16">
      <div className="-mb-2">
        <Link
          to={`/workspaces/${id}`}
          className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-primary outline-none"
        >
          <ArrowLeftIcon className="size-3.5" />
          {item.slug}
        </Link>
      </div>
      <header className="mb-4">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">{t('workspaceSettings.title')}</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">{t('workspaceSettings.subtitle')}</p>
      </header>
      
      <div className="space-y-8">
        <SettingsSection title={t('workspaceSettings.general')}>
          <SettingRow label={t('workspaceCreate.name')} value={item.slug} />
        </SettingsSection>
        
        <SettingsSection title={t('workspaceSettings.storage')}>
          <div className="flex flex-col gap-3">
            <QuotaMeter usedMb={item.diskUsedMb} quotaMb={item.diskMb} enforced={item.diskEnforced} />
            <p className="text-[13px] text-muted-foreground">
              {item.diskUsedMb === undefined ? t('instanceDetail.noData') : t('workspaceSettings.storageUsed', { used: formatMb(item.diskUsedMb), total: item.diskEnforced ? formatMb(item.diskMb) : t('workspaceSettings.unlimited') })}
            </p>
          </div>
        </SettingsSection>
        
        <SettingsSection title={t('workspaceSettings.runtime')}>
          <div className="flex items-center justify-between mb-4">
            <StatusBadge status={item.status} statusText={item.statusText} />
          </div>
          <VersionCard id={id} instance={item} />
        </SettingsSection>
        
        <section className="flex flex-col rounded-xl border border-border/80 bg-card shadow-sm overflow-hidden">
          <details className="group">
            <summary className="cursor-pointer border-b border-transparent bg-muted/30 px-6 py-5 text-sm font-medium tracking-tight text-foreground marker:text-muted-foreground transition-colors hover:bg-muted/50 group-open:border-border/60">
              {t('workspaceSettings.advanced')}
            </summary>
            <div className="p-6 space-y-8 relative z-10">
              <div className="grid gap-6 sm:grid-cols-3">
                <SettingRow label="CPU" value={`${item.cpus}`} />
                <SettingRow label={t('instances.memory')} value={formatMb(item.memoryMb)} />
                <SettingRow label={t('instances.disk')} value={formatMb(item.diskMb)} />
              </div>
              {item.hasContainer && <LogPanel key={item.status} src={`/api/instances/${id}/logs?tail=200`} />}
            </div>
          </details>
        </section>
      </div>
    </div>
  )
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) { 
  return (
    <section className="flex flex-col rounded-xl border border-border/80 bg-card shadow-sm overflow-hidden">
      <div className="border-b border-border/60 bg-muted/30 px-6 py-5">
        <h2 className="text-sm font-medium tracking-tight text-foreground">{title}</h2>
      </div>
      <div className="p-6 relative z-10">{children}</div>
    </section>
  )
}

function SettingRow({ label, value }: { label: string; value: string }) { 
  return (
    <div>
      <p className="text-[12px] font-medium uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-[14px] text-foreground font-medium">{value}</p>
    </div>
  )
}
