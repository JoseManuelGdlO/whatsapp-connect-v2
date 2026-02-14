import { useState } from 'react';

export function LoginForm({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
          await onLogin(email, password);
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : 'Login failed');
        } finally {
          setLoading(false);
        }
      }}
    >
      <label>
        Email
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
      </label>
      <button disabled={loading}>{loading ? '...' : 'Login'}</button>
      {error ? <div className="error">{error}</div> : null}
    </form>
  );
}
