import { Prisma } from '../../generated/prisma/client';

/** Sentinel query-param value for "companyType IS NULL" — not a real CompanyType enum member, since Prisma has no enum value for "no category on file". */
export const UNCLASSIFIED = 'UNCLASSIFIED' as const;

/** "UNCLASSIFIED" means "companyType IS NULL"; anything else passes through as a real enum value; absent means no filter at all. Shared by LeadsService and AdminService, which build the same where-clause shape independently. */
export function resolveCompanyTypeFilter(
  companyType: string | undefined,
): Prisma.LeadWhereInput['companyType'] {
  if (companyType === undefined) return undefined;
  if (companyType === UNCLASSIFIED) return null;
  return companyType as Prisma.LeadWhereInput['companyType'];
}
