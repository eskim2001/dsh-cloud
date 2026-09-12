import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from './layouts/app-layout.js'
import { useSession } from './lib/use-session.js'
import AdminInstancesPage from './pages/admin/AdminInstancesPage.js'
import AdminUsersPage from './pages/admin/AdminUsersPage.js'
import AdminVersionsPage from './pages/AdminVersionsPage.js'
import LoginPage from './pages/LoginPage.js'
import InstanceDetailPage from './pages/InstanceDetailPage.js'
import InstancesPage from './pages/InstancesPage.js'
import AccountPage from './pages/settings/AccountPage.js'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* 管理台：所有需要登录的页面都套在 AppLayout 里 */}
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/instances" replace />} />
        <Route path="/instances" element={<InstancesPage />} />
        <Route path="/instances/:id" element={<InstanceDetailPage />} />
        <Route path="/settings/account" element={<AccountPage />} />
        {/* 旧的设置页已经并进「账号」，收藏夹里的老链接接过去 */}
        <Route path="/settings/profile" element={<Navigate to="/settings/account" replace />} />
        <Route path="/settings/sessions" element={<Navigate to="/settings/account" replace />} />
        <Route path="/settings/members" element={<Navigate to="/settings/account" replace />} />

        {/* `/admin` 本身不再是一个页面：舰队视图才是默认落点，旧链接自动接上 */}
        <Route path="/admin" element={<Navigate to="/admin/instances" replace />} />
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

      <Route path="*" element={<Navigate to="/instances" replace />} />
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
  if (data?.role !== 'admin') return <Navigate to="/instances" replace />
  return children
}
