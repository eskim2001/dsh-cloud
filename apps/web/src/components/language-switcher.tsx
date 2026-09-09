import { LanguagesIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js'
import { isSupportedLocale, SUPPORTED_LOCALES, type Locale } from '@/i18n/index.js'

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation()
  const current: Locale = isSupportedLocale(i18n.language) ? i18n.language : 'en'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
        <LanguagesIcon />
        <span className="sr-only">{t('language.label')}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SUPPORTED_LOCALES.map((locale) => (
          <DropdownMenuCheckboxItem
            key={locale}
            checked={locale === current}
            onCheckedChange={() => void i18n.changeLanguage(locale)}
          >
            {t(`language.${locale}`)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
