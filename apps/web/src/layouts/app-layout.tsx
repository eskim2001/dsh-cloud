import { useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import { AppSidebar } from '@/components/app-sidebar.js'
import { CommandMenu } from '@/components/command-menu.js'
import { LanguageSwitcher } from '@/components/language-switcher.js'
import { ThemeSwitcher } from '@/components/theme-switcher.js'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar.js'

export function AppLayout() {
  const mainRef = useRef<HTMLElement>(null)

  useEffect(() => {
    // 只给支持 hover 的精确指针开聚光灯；系统开了「减少动态效果」就整个不做
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let rafId: number
    const handleMouseMove = (e: MouseEvent) => {
      if (!mainRef.current) return
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        if (!mainRef.current) return
        const rect = mainRef.current.getBoundingClientRect()
        mainRef.current.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`)
        mainRef.current.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`)
      })
    }
    window.addEventListener('mousemove', handleMouseMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0 bg-background relative flex flex-col">
        {/* 全局极简顶栏 */}
        <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between border-b border-border/40 bg-background px-4 md:px-6">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="-ml-1" />
            <CommandMenu />
          </div>
          
          <div className="flex items-center gap-1.5">
            {/* 顶栏控制组：语言与主题切换 */}
            <LanguageSwitcher />
            <ThemeSwitcher />
          </div>
        </header>
        <main ref={mainRef} className="flex flex-1 flex-col p-0 relative min-h-[calc(100vh-3.5rem)] group/main">
          {/* 全局环境拓扑网格，带有极轻量的鼠标聚光灯效应 (仅在桌面端生效) */}
          <div className="app-ambient-glow" aria-hidden="true" />
          <div className="app-ambient-grid" aria-hidden="true" />
          <div className="app-mouse-spotlight hidden md:block" aria-hidden="true" />
          
          <div className="relative z-10 flex-1 p-4 md:p-8">
            <Outlet />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
