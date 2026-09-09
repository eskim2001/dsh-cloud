import { Outlet } from 'react-router-dom'
import { AppSidebar } from '@/components/app-sidebar.js'
import { Separator } from '@/components/ui/separator.js'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar.js'

/**
 * 管理台骨架。移动端（<768px）下 `Sidebar` 自己会变成抽屉，
 * `SidebarTrigger` 是唯一的开合入口，所以它必须留在顶栏里。
 *
 * `min-w-0`：`SidebarInset` 是 flex 子项，默认 `min-width:auto` = 内容最小宽度，
 * 宽表格（不换行）会把整个页面撑出横向滚动条，而不是让表格自己滚。
 */
export function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
        </header>
        <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
