import { ArrowLeftIcon, ArrowRightIcon, CheckIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { CreateInstanceForm } from '@/components/instances/create-instance-form.js'
import { Button } from '@/components/ui/button.js'

export default function CreateWorkspacePage() {
  const { t } = useTranslation()
  const [createdId, setCreatedId] = useState<string | null>(null)

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col px-6 pt-8 md:pt-10 relative z-10 pb-16">
      <div className="mb-6">
        <Link
          to="/workspaces"
          className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-primary outline-none"
        >
          <ArrowLeftIcon className="size-3.5" />
          {t('workspaceCreate.back')}
        </Link>
      </div>

      {createdId === null ? (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
          <header className="mb-10">
            <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">{t('workspaceCreate.title')}</h1>
            <p className="mt-2 text-[14px] text-muted-foreground">{t('workspaceCreate.subtitle')}</p>
          </header>
          <div className="mt-10"><CreateInstanceForm onCreated={setCreatedId} /></div>
        </div>
      ) : (
        <div className="flex flex-col items-center py-20 text-center animate-in fade-in duration-500">
          <div className="grid size-16 place-items-center rounded-full bg-primary/10 text-primary border border-primary/20 shadow-sm"><CheckIcon className="size-8" /></div>
          <h1 className="mt-8 font-heading text-2xl font-semibold tracking-tight">{t('workspaceCreate.ready')}</h1>
          <p className="mt-3 text-[14px] text-muted-foreground">{t('workspaceCreate.readyBody')}</p>
          <Button className="mt-8 h-10 px-6 text-[14px] shadow-sm" render={<Link to={`/workspaces/${createdId}`} />} nativeButton={false}>
            {t('workspaceCreate.open')}
            <ArrowRightIcon className="ml-1.5 size-4" />
          </Button>
        </div>
      )}
    </div>
  )
}