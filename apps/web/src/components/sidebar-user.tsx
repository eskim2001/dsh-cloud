import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronsUpDownIcon, LogOutIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useTheme, type Theme } from '@/components/theme-provider.js'
import { Avatar, AvatarFallback } from '@/components/ui/avatar.js'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar.js'
import { SUPPORTED_LOCALES } from '@/i18n/index.js'
import { signOut } from '@/lib/api.js'
import { useSession } from '@/lib/use-session.js'

const THEMES: Theme[] = ['light', 'dark', 'system']

/** 侧栏底部的账号菜单：语言 / 主题 / 退出。登录页不用它，那里仍是两个独立切换器。 */
export function SidebarUser() {
  const { data: user } = useSession()
  const { isMobile } = useSidebar()
  const { i18n, t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const logout = useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      // 退出即全清：别把上一个用户的缓存留给下一个
      queryClient.clear()
      // clear() 只是把缓存删掉，不会让上面的 RequireAuth 重渲染——不显式跳转的话
      // 页面会停在原地（会话已经没了，看起来像「没退出去」，得点个链接或刷新才跳）
      void navigate('/login', { replace: true })
    },
  })

  const email = user?.email ?? ''
  const name = user?.name === undefined || user.name === '' ? email : user.name
  const initials = (name === '' ? '?' : name).slice(0, 2).toUpperCase()

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" className="data-open:bg-sidebar-accent" />}
          >
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">{email}</span>
            </div>
            <ChevronsUpDownIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-56"
            align="end"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('language.label')}</DropdownMenuLabel>
              {SUPPORTED_LOCALES.map((locale) => (
                <DropdownMenuCheckboxItem
                  key={locale}
                  checked={i18n.language === locale}
                  onCheckedChange={() => void i18n.changeLanguage(locale)}
                >
                  {t(`language.${locale}`)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('theme.label')}</DropdownMenuLabel>
              {THEMES.map((value) => (
                <DropdownMenuCheckboxItem
                  key={value}
                  checked={theme === value}
                  onCheckedChange={() => setTheme(value)}
                >
                  {t(`theme.${value}`)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => logout.mutate()} disabled={logout.isPending}>
              <LogOutIcon />
              {t('common.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
