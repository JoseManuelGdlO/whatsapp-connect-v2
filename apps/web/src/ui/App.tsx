import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';

import { login } from '../api/client';
import { useAuth } from '../state/auth';
import { AdminPage } from './admin/AdminPage';
import { LoginForm } from './auth/LoginForm';
import { HomePage } from './pages/HomePage';
import { PublicQrPage } from './pages/PublicQrPage';

export function App() {
  const { token, clear, setAuth } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="container">
      <header className="header">
        <div className="brand">WhatsApp Connect v2</div>
        <nav className="nav">
          <Link to="/">Home</Link>
          <Link to="/login">Login</Link>
          {token ? <Link to="/admin">Admin</Link> : null}
          {token ? (
            <button className="linkBtn" onClick={() => clear()}>
              Logout
            </button>
          ) : null}
        </nav>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route
            path="/login"
            element={
              <div className="card">
                <h2>Login</h2>
                <LoginForm
                  onLogin={async (email, password) => {
                    const r = await login(email, password);
                    setAuth(r.token, r.user);
                    navigate('/admin');
                  }}
                />
              </div>
            }
          />
          <Route path="/devices" element={token ? <Navigate to="/admin" replace /> : <Navigate to="/login" replace />} />
          <Route path="/webhooks" element={token ? <Navigate to="/admin" replace /> : <Navigate to="/login" replace />} />
          <Route path="/admin" element={token ? <AdminPage /> : <Navigate to="/login" replace />} />
          <Route path="/public/qr/:token" element={<PublicQrPage />} />
        </Routes>
      </main>
    </div>
  );
}
