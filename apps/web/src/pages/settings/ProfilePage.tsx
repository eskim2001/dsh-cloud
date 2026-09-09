import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/page-header.js'
import { Card, CardContent } from '@/components/ui/card.js'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import { useSession } from '@/lib/use-session.js'

export default function ProfilePage() {
  const { t } = useTranslation()
  const { data: user } = useSession()

  return (
    <>
      <PageHeader
        title={t('settings.profile.title')}
        description={t('settings.profile.description')}
      />
      <Card>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="profile-name">{t('login.name')}</FieldLabel>
              <Input id="profile-name" value={user?.name ?? ''} readOnly />
            </Field>
            <Field>
              <FieldLabel htmlFor="profile-email">{t('login.email')}</FieldLabel>
              <Input id="profile-email" value={user?.email ?? ''} readOnly />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
    </>
  )
}
