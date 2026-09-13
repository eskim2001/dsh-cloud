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
    <div className="mx-auto flex w-full max-w-xl flex-col py-4 md:py-10">
      <Link to="/workspaces" className="mb-10 inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-4" />{t('workspaceCreate.back')}</Link>
      {createdId === null ? (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
          <h1 className="text-2xl font-medium">{t('workspaceCreate.title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('workspaceCreate.subtitle')}</p>
          <div className="mt-10"><CreateInstanceForm onCreated={setCreatedId} /></div>
        </div>
      ) : (
        <div className="flex flex-col items-center py-20 text-center animate-in fade-in duration-500">
          <div className="grid size-10 place-items-center rounded-full border"><CheckIcon className="size-5" /></div>
          <h1 className="mt-6 text-xl font-medium">{t('workspaceCreate.ready')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('workspaceCreate.readyBody')}</p>
          <Button className="mt-8" render={<Link to={`/workspaces/${createdId}`} />} nativeButton={false}><span>{t('workspaceCreate.open')}</span><ArrowRightIcon /></Button>
        </div>
      )}
    </div>
  )
}