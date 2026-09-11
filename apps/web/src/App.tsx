import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from './layouts/app-layout.js'
import { useSession } from './lib/use-session.js'
import AdminVersionsPage from './pages/AdminVersionsPage.js'
import AdminPage from './pages/AdminPage.js'
import LoginPage from './pages/LoginPage.js'
import InstanceDetailPage from './pages/InstanceDetailPage.js'
import InstancesPage from './pages/InstancesPage.js'
import MembersPage from './pages/settings/MembersPage.js'
import ProfilePage from './pages/settings/ProfilePage.js'
import SessionsPage from './pages/settings/SessionsPage.js'

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
        <Route path="/settings/profile" element={<ProfilePage />} />
        <Route path="/settings/sessions" element={<SessionsPage />} />
        <Route path="/settings/members" element={<MembersPage />} />
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <AdminPage />
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
