import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as not requiring authentication. JwtAuthGuard is registered
 * globally (APP_GUARD) so every route is protected by default — this is the
 * explicit opt-out, rather than remembering to add a guard to every new
 * sensitive route (the more common source of accidental auth bypass bugs).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
