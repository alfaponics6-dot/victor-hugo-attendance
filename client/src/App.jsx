import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/useAuth.js';
import Footer from './components/common/Footer';
import Loading from './components/common/Loading';
import OfflineIndicator from './components/common/OfflineIndicator';
import InstallIosHint from './components/common/InstallIosHint';
import './App.css';

const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const ProfesorDashboard = lazy(() => import('./pages/ProfesorDashboard'));

function PrivateRoute({ children }) {
  const { leader, loading, isAdmin, isProfesor } = useAuth();
  const { pathname } = useLocation();

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  if (!leader) {
    return <Navigate to="/" replace />;
  }

  if (isAdmin() && pathname === '/dashboard') {
    return <Navigate to="/admin" replace />;
  }
  if (isProfesor() && pathname === '/dashboard') {
    return <Navigate to="/profesor" replace />;
  }
  if (!isAdmin() && pathname === '/admin') {
    return <Navigate to="/dashboard" replace />;
  }
  if (!isProfesor() && !isAdmin() && pathname === '/profesor') {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}

// Login owns its own footer (it sits inside a custom hero layout). Every
// authenticated route gets the shared footer at the bottom so the language
// switcher is reachable anywhere.
function AuthedShell({ children }) {
  return (
    <div className="min-h-screen flex flex-col">
      <OfflineIndicator />
      <div className="flex-1">{children}</div>
      <Footer />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        {/* iOS install hint sits above all routes (login + dashboards)
            because the leaders most need it BEFORE first offline use,
            which is typically right after first login. */}
        <InstallIosHint />
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Login />} />
            <Route
              path="/dashboard"
              element={
                <PrivateRoute>
                  <AuthedShell><Dashboard /></AuthedShell>
                </PrivateRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <PrivateRoute>
                  <AuthedShell><AdminDashboard /></AuthedShell>
                </PrivateRoute>
              }
            />
            <Route
              path="/profesor"
              element={
                <PrivateRoute>
                  <AuthedShell><ProfesorDashboard /></AuthedShell>
                </PrivateRoute>
              }
            />
          </Routes>
        </Suspense>
      </Router>
    </AuthProvider>
  );
}

export default App;
