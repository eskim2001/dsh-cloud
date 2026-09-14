import { useQuery } from '@tanstack/react-query'
import { PlusIcon, SearchIcon, SettingsIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button.js'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog.js'
import { Input } from '@/components/ui/input.js'
import { listInstances } from '@/lib/api.js'
import { keys } from '@/lib/query-keys.js'

export function CommandMenu() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const instances = useQuery({ queryKey: keys.instances, queryFn: listInstances, enabled: open })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const go = (to: string) => {
    setOpen(false)
    setQuery('')
    navigate(to)
  }
  const matching = (instances.data?.instances ?? []).filter((item) =>
    item.slug.toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <>
      <Button variant="outline" className="relative h-9 w-full justify-start rounded-lg bg-muted/50 text-sm font-normal text-muted-foreground shadow-none sm:pr-12 md:w-40 lg:w-64" onClick={() => setOpen(true)}>
        <SearchIcon className="mr-2 size-4 shrink-0" />
        <span className="inline-flex truncate mt-px">{t('command.search')}</span>
        <kbd className="pointer-events-none absolute right-1 top-1.5 hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogTitle className="sr-only">{t('command.title')}</DialogTitle>
          <div className="flex items-center border-b px-4">
            <SearchIcon className="size-4 text-muted-foreground" />
            <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('command.placeholder')} className="h-13 border-0 bg-transparent shadow-none focus-visible:ring-0" />
          </div>
          <div className="max-h-80 overflow-y-auto p-2">
            <CommandItem icon={PlusIcon} label={t('command.create')} onClick={() => go('/workspaces/new')} />
            <CommandItem icon={SettingsIcon} label={t('command.settings')} onClick={() => go('/settings/account')} />
            {matching.length > 0 && <p className="px-3 pt-4 pb-2 text-xs text-muted-foreground">{t('nav.workspaces')}</p>}
            {matching.map((item) => <CommandItem key={item.id} icon={SearchIcon} label={item.slug} onClick={() => go(`/workspaces/${item.id}`)} />)}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function CommandItem({ icon: Icon, label, onClick }: { icon: typeof SearchIcon; label: string; onClick: () => void }) {
  return <button className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent" onClick={onClick}><Icon className="size-4 text-muted-foreground" />{label}</button>
}