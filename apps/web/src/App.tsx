import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from './layouts/app-layout.js'
import { useSession } from './lib/use-session.js'
import AdminInstancesPage from './pages/admin/AdminInstancesPage.js'
import AdminOverviewPage from './pages/admin/AdminOverviewPage.js'
import AdminUsersPage from './pages/admin/AdminUsersPage.js'
import AdminVersionsPage from './pages/AdminVersionsPage.js'
import ActivityPage from './pages/ActivityPage.js'
import CreateWorkspacePage from './pages/CreateWorkspacePage.js'
import FilesPage from './pages/FilesPage.js'
import HomePage from './pages/HomePage.js'
import OpenWorkspacePage from './pages/OpenWorkspacePage.js'
import WorkspaceSettingsPage from './pages/WorkspaceSettingsPage.js'
import LoginPage from './pages/LoginPage.js'
import AcceptInvitePage from './pages/AcceptInvitePage.js'
import InstanceDetailPage from './pages/InstanceDetailPage.js'
import InstancesPage from './pages/InstancesPage.js'
import AccountPage from './pages/settings/AccountPage.js'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* 兑换邀请：**未登录可达**——公开注册关掉之后，这是新账号唯一的入口 */}
      <Route path="/invite/:token" element={<AcceptInvitePage />} />

      {/* 管理台：所有需要登录的页面都套在 AppLayout 里 */}
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="/home" element={<HomePage />} />
        <Route path="/workspaces" element={<InstancesPage />} />
        <Route path="/workspaces/new" element={<CreateWorkspacePage />} />
        <Route path="/workspaces/:id" element={<InstanceDetailPage />} />
        <Route path="/workspaces/:id/open" element={<OpenWorkspacePage />} />
        <Route path="/workspaces/:id/settings" element={<WorkspaceSettingsPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/instances" element={<Navigate to="/workspaces" replace />} />
        <Route path="/instances/:id" element={<InstanceDetailPage />} />
        <Route path="/settings/account" element={<AccountPage />} />
        {/* 旧的设置页已经并进「账号」，收藏夹里的老链接接过去 */}
        <Route path="/settings/profile" element={<Navigate to="/settings/account" replace />} />
        <Route path="/settings/sessions" element={<Navigate to="/settings/account?view=sessions" replace />} />
        <Route path="/settings/members" element={<Navigate to="/settings/account" replace />} />

        {/* `/admin` 本身不再是一个页面：舰队视图才是默认落点，旧链接自动接上 */}
        <Route path="/admin" element={<RequireAdmin><AdminOverviewPage /></RequireAdmin>} />
        <Route
          path="/admin/instances"
          element={
            <RequireAdmin>
              <AdminInstancesPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/users"
          element={
            <RequireAdmin>
              <AdminUsersPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/versions"
          element={
            <RequireAdmin>
              <AdminVersionsPage />
            </RequireAdmin>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  )
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isPending } = useSession()
  const location = useLocation()
  const { t } = useTranslation()

  if (isPending) {
    return (
      <div className="grid h-svh place-items-center text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    )
  }
  if (data === null || data === undefined) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`)
    return <Navigate to={`/login?next=${next}`} replace />
  }
  return children
}

/**
 * 非管理员送回实例页。这里只是别让人误入——
 * 真正的门在服务端：管理面每条路由都过同一个 admin 钩子。
 */
function RequireAdmin({ children }: { children: ReactNode }) {
  const { data, isPending } = useSession()
  const { t } = useTranslation()

  if (isPending) {
    return (
      <div className="grid h-svh place-items-center text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    )
  }
  if (data?.role !== 'admin') return <Navigate to="/home" replace />
  return children
}
