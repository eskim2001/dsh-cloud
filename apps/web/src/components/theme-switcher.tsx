import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js'
import { useTheme, type Theme } from './theme-provider.js'

const THEMES: readonly Theme[] = ['light', 'dark', 'system']

const THEME_ICONS = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
} as const

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme()
  const { t } = useTranslation()
  const Icon = THEME_ICONS[theme]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
        <Icon />
        <span className="sr-only">{t('theme.label')}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEMES.map((value) => (
          <DropdownMenuCheckboxItem
            key={value}
            checked={theme === value}
            onCheckedChange={() => setTheme(value)}
          >
            {t(`theme.${value}`)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
