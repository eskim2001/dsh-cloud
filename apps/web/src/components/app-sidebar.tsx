import { BoxesIcon, TagIcon, UserIcon, UsersIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink, useLocation } from 'react-router-dom'
import { BrandMark } from '@/components/brand-mark.js'
import { ServerHealth } from '@/components/server-health.js'
import { SidebarUser } from '@/components/sidebar-user.js'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar.js'
import { useSession } from '@/lib/use-session.js'

interface NavItem {
  title: string
  url: string
  icon: LucideIcon
}

export function AppSidebar() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const { data: user } = useSession()

  const platformNav: NavItem[] = [{ title: t('nav.instances'), url: '/instances', icon: BoxesIcon }]
  /** 管理面单独成组：这三项都是管理员专属的作业面，混进「平台」里会让人看不清边界。
   *  藏起来不是安全边界——服务端每条管理面路由都自己查 role。 */
  const adminNav: NavItem[] = [
    { title: t('nav.adminInstances'), url: '/admin/instances', icon: BoxesIcon },
    { title: t('nav.adminUsers'), url: '/admin/users', icon: UsersIcon },
    { title: t('nav.adminVersions'), url: '/admin/versions', icon: TagIcon },
  ]
  const settingsNav: NavItem[] = [
    { title: t('nav.account'), url: '/settings/account', icon: UserIcon },
  ]

  const group = (label: string, items: NavItem[]) => (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                tooltip={item.title}
                // 子页面（如 /instances/:id）也要把这一项点亮
                isActive={pathname === item.url || pathname.startsWith(`${item.url}/`)}
                render={<NavLink to={item.url} />}
              >
                <item.icon />
                <span>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<NavLink to="/instances" />}>
              <BrandMark className="size-8 shrink-0" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{t('app.title')}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {group(t('nav.platform'), platformNav)}
        {user?.role === 'admin' && group(t('nav.admin'), adminNav)}
        {group(t('nav.settings'), settingsNav)}
      </SidebarContent>

      <SidebarFooter>
        <ServerHealth />
        <SidebarUser />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
