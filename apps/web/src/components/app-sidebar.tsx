import { BoxesIcon, MonitorSmartphoneIcon, ShieldCheckIcon, TagIcon, UserIcon, UsersIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink, useLocation } from 'react-router-dom'
import { BrandMark } from '@/components/brand-mark.js'
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
  /** 只在路径完全相等时高亮——有子页面的入口（如 /admin）要置位，否则子页会把父项也点亮。 */
  end?: boolean
}

export function AppSidebar() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const { data: user } = useSession()

  const platformNav: NavItem[] = [
    { title: t('nav.instances'), url: '/instances', icon: BoxesIcon },
    // 平台管理只给管理员看。藏起来不是安全边界——服务端每条管理面路由都自己查 role。
    ...(user?.role === 'admin'
      ? [
          { title: t('nav.admin'), url: '/admin', icon: ShieldCheckIcon, end: true },
          { title: t('nav.adminVersions'), url: '/admin/versions', icon: TagIcon },
        ]
      : []),
  ]
  const settingsNav: NavItem[] = [
    { title: t('nav.profile'), url: '/settings/profile', icon: UserIcon },
    { title: t('nav.sessions'), url: '/settings/sessions', icon: MonitorSmartphoneIcon },
    { title: t('nav.members'), url: '/settings/members', icon: UsersIcon },
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
                isActive={
                  pathname === item.url || (item.end !== true && pathname.startsWith(`${item.url}/`))
                }
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
        {group(t('nav.settings'), settingsNav)}
      </SidebarContent>

      <SidebarFooter>
        <SidebarUser />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
