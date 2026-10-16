import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import type { AuthUser } from './types';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Convenience flag so pages do not repeat the role comparison. */
  isAdmin: boolean;
  usingGeneratedPassword: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [usingGeneratedPassword, setUsingGeneratedPassword] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me.user);
      setUsingGeneratedPassword(me.usingGeneratedPassword);
      setStatus('authenticated');
    } catch {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.login(username, password);
    setUser(result.user);
    setUsingGeneratedPassword(result.usingGeneratedPassword);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      isAdmin: user?.role === 'admin',
      usingGeneratedPassword,
      login,
      logout,
      refresh,
    }),
    [status, user, usingGeneratedPassword, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return context;
}
