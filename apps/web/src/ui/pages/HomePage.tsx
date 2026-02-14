import { Link } from 'react-router-dom';
import { useAuth } from '../../state/auth';

export function HomePage() {
  const { token, user } = useAuth();

  return (
    <div className="card">
      <h2>Panel</h2>
      {token ? (
        <div>
          <p className="muted">Logueado como {user?.email}</p>
          <Link to="/admin">Ir a Admin</Link>
        </div>
      ) : (
        <p>Inicia sesión para comenzar.</p>
      )}
    </div>
  );
}
