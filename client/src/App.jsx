import { Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import DashboardLayout from './components/DashboardLayout';
import Login from './pages/Login';
import AuthCallback from './pages/AuthCallback';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import Logs from './pages/Logs';
import Topics from './pages/Topics';
import Settings from './pages/Settings';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />

      <Route
        path="/onboarding"
        element={
          <ProtectedRoute requireBots={false}>
            <Onboarding />
          </ProtectedRoute>
        }
      />

      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="bots/:id" element={<Dashboard />} />
        <Route path="logs" element={<Logs />} />
        <Route path="topics" element={<Topics />} />
        <Route path="settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
