import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import Home from './pages/Home'
import Announcement from './pages/Announcement'
import Onboarding from './pages/Onboarding'
import Draw from './pages/Draw'
import Entertainment from './pages/Entertainment'
import Slot from './pages/Slot'
import Checkin from './pages/Checkin'
import ConsoleOverview from './pages/console/Overview'
import BadgeHall from './pages/console/BadgeHall'
import ConsoleKeys from './pages/console/Keys'
import ConsoleBilling from './pages/console/Billing'
import ConsoleFinance from './pages/console/Finance'
import ConsoleUsage from './pages/console/Usage'
import Rankings from './pages/Rankings'
import Models from './pages/Models'
import ArenaLobby from './pages/arena/Lobby'
import ArenaRoom from './pages/arena/Room'
import ArenaLeaderboard from './pages/arena/Leaderboard'
import AdminLayout from './components/AdminLayout'
import AdminOverview from './pages/admin/Overview'
import AdminChannels from './pages/admin/Channels'
import AdminModels from './pages/admin/ModelsAdmin'
import AdminUsers from './pages/admin/Users'
import AdminLevels from './pages/admin/Levels'
import AdminGroups from './pages/admin/Groups'
import AdminInvites from './pages/admin/Invites'
import AdminArena from './pages/admin/Arena'
import AdminUsage from './pages/admin/Usage'
import AdminLoans from './pages/admin/Loans'
import AdminLogs from './pages/admin/Logs'
import AdminControl from './pages/admin/Control'
import AdminAuthSettings from './pages/admin/AuthSettings'
import AdminFinanceSettings from './pages/admin/FinanceSettings'
import AdminMonitoring from './pages/admin/Monitoring'
import AdminEntOverview from './pages/admin/ent/Overview'
import AdminEntDraw from './pages/admin/ent/Draw'
import AdminEntSlot from './pages/admin/ent/Slot'
import AdminEntSignin from './pages/admin/ent/Signin'
import AdminEntVideoReward from './pages/admin/ent/VideoReward'
import AdminAnnouncements from './pages/admin/Announcements'
import { PageErrorBoundary } from './components/PageErrorBoundary'

function AppToaster() {
  const { pathname } = useLocation()
  const [adminTheme, setAdminTheme] = useState<'dark' | 'light'>(() =>
    document.documentElement.classList.contains('admin-light') ? 'light' : 'dark',
  )

  useEffect(() => {
    const root = document.documentElement
    const syncTheme = () => setAdminTheme(root.classList.contains('admin-light') ? 'light' : 'dark')
    syncTheme()
    const observer = new MutationObserver(syncTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return (
    <Toaster
      theme={pathname.startsWith('/admin') ? adminTheme : 'dark'}
      position="top-center"
      offset={100}
      mobileOffset={88}
      toastOptions={{ className: 'sonner-toast-custom' }}
    />
  )
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/announcements/:id" element={<Announcement />} />
        <Route path="/draw" element={<Draw />} />
        <Route path="/entertainment" element={<Entertainment />} />
        <Route path="/slot" element={<Slot />} />
        <Route path="/checkin" element={<Checkin />} />
        <Route path="/dashboard" element={<Navigate to="/console" replace />} />
        <Route path="/console" element={<ConsoleOverview />} />
        <Route path="/console/badges" element={<BadgeHall />} />
        <Route path="/console/keys" element={<ConsoleKeys />} />
        <Route path="/console/billing" element={<ConsoleBilling />} />
        <Route path="/console/finance" element={<ConsoleFinance />} />
        <Route path="/console/usage" element={<ConsoleUsage />} />
        <Route path="/leaderboard" element={<PageErrorBoundary title="榜单页面加载失败"><Rankings /></PageErrorBoundary>} />
        <Route path="/leaderboard/balance" element={<Navigate to="/leaderboard?category=overall&board=balance&period=all&page=1" replace />} />
        <Route path="/leaderboard/borrowing" element={<Navigate to="/leaderboard?category=finance&board=borrowed&period=all&page=1" replace />} />
        <Route path="/leaderboard/lending" element={<Navigate to="/leaderboard?category=finance&board=lent&period=all&page=1" replace />} />
        <Route path="/models" element={<Models />} />
        <Route path="/arena" element={<ArenaLobby />} />
        <Route path="/arena/leaderboard" element={<ArenaLeaderboard />} />
        <Route path="/arena/:roomId" element={<ArenaRoom />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminOverview />} />
          <Route path="channels" element={<AdminChannels />} />
          <Route path="models" element={<AdminModels />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="levels" element={<AdminLevels />} />
          <Route path="control" element={<AdminControl />} />
          <Route path="auth-settings" element={<AdminAuthSettings />} />
          <Route path="finance-settings" element={<AdminFinanceSettings />} />
          <Route path="monitoring" element={<AdminMonitoring />} />
          <Route path="groups" element={<AdminGroups />} />
          <Route path="invites" element={<AdminInvites />} />
          <Route path="draws" element={<Navigate to="/admin/entertainment/draw" replace />} />
          <Route path="entertainment" element={<AdminEntOverview />} />
          <Route path="entertainment/draw" element={<AdminEntDraw />} />
          <Route path="entertainment/slot" element={<AdminEntSlot />} />
          <Route path="entertainment/signin" element={<AdminEntSignin />} />
          <Route path="entertainment/video-reward" element={<AdminEntVideoReward />} />
          <Route path="announcements" element={<AdminAnnouncements />} />
          <Route path="arena" element={<AdminArena />} />
          <Route path="usage" element={<AdminUsage />} />
          <Route path="loans" element={<AdminLoans />} />
          <Route path="logs" element={<AdminLogs />} />
          <Route path="settings" element={<Navigate to="/admin/control" replace />} />
        </Route>
        <Route path="*" element={<Home />} />
      </Routes>
      <AppToaster />
    </>
  )
}
