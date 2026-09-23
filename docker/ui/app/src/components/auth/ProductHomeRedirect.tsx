import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { productHome } from '../../utils/productHome';

/**
 * Redirects to the signed-in user's product home. Used in place of a retired
 * product's route (e.g. /api-dids while API_CALLING_ENABLED is false) so old
 * bookmarks land somewhere useful instead of the public landing page.
 */
export function ProductHomeRedirect() {
  const { user, isAdmin } = useAuth();
  return <Navigate to={productHome(user, isAdmin)} replace />;
}
