import { useQuery } from '@tanstack/react-query'
import { ArrowUpRightIcon, FileIcon, SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/page-header.js'
import { StatusBadge } from '@/components/status-badge.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { listInstances } from '@/lib/api.js'
import { canOpen } from '@/lib/instance-status.js'
import { keys } from '@/lib/query-keys.js'

export default function FilesPage() {
  const { t, i18n } = useTranslation()
  const [query, setQuery] = useState('')
  const instances = useQuery({ queryKey: keys.instances, queryFn: listInstances })
  const rows = (instances.data?.instances ?? []).filter((item) => item.slug.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-4 md:py-8">
      <PageHeader title={t('files.title')} description={t('files.subtitle')} />
      <div className="relative max-w-sm"><SearchIcon className="absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('files.search')} className="pl-9" /></div>
      <div className="border-y">
        {instances.isPending && <p className="py-8 text-sm text-muted-foreground">{t('common.loading')}</p>}
        {rows.map((item) => (
          <div key={item.id} className="flex items-center gap-4 border-b py-4 last:border-b-0">
            <div className="grid size-9 shrink-0 place-items-center rounded-md bg-muted"><FileIcon className="size-4 text-muted-foreground" /></div>
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.slug}</p><p className="mt-1 text-xs text-muted-foreground">{t('files.updated', { time: new Date(item.createdAt).toLocaleDateString(i18n.language) })}</p></div>
            <StatusBadge status={item.status} />
            <Button variant="ghost" size="icon" disabled={!canOpen(item.status)} aria-label={t('files.open')} onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}><ArrowUpRightIcon /></Button>
          </div>
        ))}
        {instances.data !== undefined && rows.length === 0 && <div className="py-14 text-center"><p className="text-sm font-medium">{t('files.empty')}</p><p className="mt-2 text-sm text-muted-foreground">{t('files.emptyBody')}</p></div>}
      </div>
      <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">{t('files.boundary')}</p>
    </div>
  )
}