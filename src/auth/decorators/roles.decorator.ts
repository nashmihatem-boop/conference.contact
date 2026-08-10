import { SetMetadata } from '@nestjs/common';
import { Role } from '../../../generated/prisma/enums';

export const ROLES_KEY = 'roles';

/** Restricts a route to the listed roles. Must be paired with RolesGuard — this decorator only attaches metadata. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
