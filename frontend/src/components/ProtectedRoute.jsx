import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ProtectedRoute({ children, roles, permission, module }) {
  const { user, token, hasPermission, hasModule } = useAuth();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (module && !hasModule(module)) return <Navigate to="/dashboard" replace />;
  if (permission && !hasPermission(permission)) return <Navigate to="/dashboard" replace />;
  if (!permission && roles && !roles.includes(user.role)) return <Navigate to="/dashboard" replace />;
  return children;
}
