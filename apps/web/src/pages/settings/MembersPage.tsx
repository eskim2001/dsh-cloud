import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/page-header.js'
import { Card, CardContent } from '@/components/ui/card.js'

export default function MembersPage() {
  const { t } = useTranslation()

  return (
    <>
      <PageHeader
        title={t('settings.members.title')}
        description={t('settings.members.description')}
      />
      <Card>
        <CardContent className="text-sm text-muted-foreground">
          {t('common.comingSoon')}
        </CardContent>
      </Card>
    </>
  )
}
