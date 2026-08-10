/**
 * Apollo's `person_functions` filter isn't documented in their public API
 * reference, but it's real — confirmed by differential-testing dozens of
 * candidate slugs against the live API (comparing total_entries with and
 * without each value). An unrecognized value doesn't get ignored the way
 * most Apollo filters do; it zeroes the entire result set. So this list is
 * deliberately short: only slugs that measurably changed a real query's
 * result count. Every department/job-function checkbox in the UI maps to
 * one of these, or to none at all if its category has no confirmed value —
 * better to skip a filter than silently apply one to nothing.
 */
export const VERIFIED_PERSON_FUNCTIONS = [
  'product_management',
  'data_science',
  'accounting',
  'finance',
  'human_resources',
  'information_technology',
  'legal',
  'marketing',
  'operations',
  'business_development',
  'sales',
] as const;

export type VerifiedPersonFunction = (typeof VERIFIED_PERSON_FUNCTIONS)[number];

export function isVerifiedPersonFunction(
  value: string,
): value is VerifiedPersonFunction {
  return (VERIFIED_PERSON_FUNCTIONS as readonly string[]).includes(value);
}

/** Apollo-documented `person_seniorities` enum — real, from their public API reference. */
export const PERSON_SENIORITIES = [
  'owner',
  'founder',
  'c_suite',
  'partner',
  'vp',
  'head',
  'director',
  'manager',
  'senior',
  'entry',
  'intern',
] as const;

export type PersonSeniority = (typeof PERSON_SENIORITIES)[number];

export function isPersonSeniority(value: string): value is PersonSeniority {
  return (PERSON_SENIORITIES as readonly string[]).includes(value);
}

/**
 * `organization_num_employees_ranges` — real, differential-verified
 * ("1,10" measurably narrowed a baseline query). Format is Apollo's own:
 * "min,max" as a literal string, open-ended at the top with a large max.
 */
export const COMPANY_SIZE_RANGES = [
  { label: '1-10', value: '1,10' },
  { label: '11-20', value: '11,20' },
  { label: '21-50', value: '21,50' },
  { label: '51-100', value: '51,100' },
  { label: '101-200', value: '101,200' },
  { label: '201-500', value: '201,500' },
  { label: '501-1000', value: '501,1000' },
  { label: '1001-2000', value: '1001,2000' },
  { label: '2001-5000', value: '2001,5000' },
  { label: '5001-10000', value: '5001,10000' },
  { label: '10001-20000', value: '10001,20000' },
  { label: '20001-50000', value: '20001,50000' },
  { label: '50000+', value: '50001,100000000' },
] as const;

/** `revenue_range` — real, differential-verified (min:1/max:2 dropped a 522K-result baseline to 0). Buckets in raw dollars. */
export const REVENUE_BUCKETS = [
  { label: '$100K', value: 100_000 },
  { label: '$500K', value: 500_000 },
  { label: '$1M', value: 1_000_000 },
  { label: '$5M', value: 5_000_000 },
  { label: '$10M', value: 10_000_000 },
  { label: '$25M', value: 25_000_000 },
  { label: '$50M', value: 50_000_000 },
  { label: '$100M', value: 100_000_000 },
  { label: '$500M', value: 500_000_000 },
  { label: '$1B', value: 1_000_000_000 },
] as const;

/**
 * The full "Departments & Job Function" browsing taxonomy shown in the
 * review-parameters UI — every leaf item a user can pick from the
 * searchable dropdown. Sections without a confirmed real `person_functions`
 * value (Design, Education, Medical & Health, Consulting) still list their
 * items for browsing, but `mapsTo: null` means picking one adds no Apollo
 * filter — it's there for completeness, not fabricated to look wired up
 * when it isn't. Sections DO map to a real value when their own broad
 * category slug was confirmed (e.g. every Marketing sub-item maps to the
 * verified "marketing"), and a couple of individually-confirmed leaves
 * (Data Science, Business Development) map to their own more specific slug
 * instead of inheriting the section's.
 */
export interface DepartmentSection {
  section: string;
  mapsTo: VerifiedPersonFunction | null;
  items: { label: string; mapsTo?: VerifiedPersonFunction | null }[];
}

export const DEPARTMENT_TAXONOMY: DepartmentSection[] = [
  {
    section: 'Executive',
    mapsTo: null,
    items: [
      { label: 'C-Suite' },
      { label: 'Executive' },
      { label: 'Finance Executive', mapsTo: 'finance' },
      { label: 'Founder' },
      { label: 'Human Resources Executive', mapsTo: 'human_resources' },
      {
        label: 'Information Technology Executive',
        mapsTo: 'information_technology',
      },
      { label: 'Legal Executive', mapsTo: 'legal' },
      { label: 'Marketing Executive', mapsTo: 'marketing' },
      { label: 'Medical & Health Executive' },
      { label: 'Operations Executive', mapsTo: 'operations' },
      { label: 'Sales Leader', mapsTo: 'sales' },
    ],
  },
  {
    section: 'Product',
    mapsTo: 'product_management',
    items: [
      { label: 'Product' },
      { label: 'Product Development' },
      { label: 'Product Management' },
    ],
  },
  {
    section: 'Engineering & Technical',
    mapsTo: 'information_technology',
    items: [
      { label: 'Artificial Intelligence / Machine Learning' },
      { label: 'Bioengineering' },
      { label: 'Biometrics' },
      { label: 'Business Intelligence' },
      { label: 'Chemical Engineering' },
      { label: 'Cloud / Mobility' },
      { label: 'Data Science', mapsTo: 'data_science' },
      { label: 'DevOps' },
      { label: 'Digital Transformation' },
      { label: 'Emerging Technology / Innovation' },
      { label: 'Industrial Engineering' },
      { label: 'Mechanic' },
      { label: 'Mobile Development' },
      { label: 'Project Management' },
      { label: 'Research & Development' },
      { label: 'Scrum Master / Agile Coach' },
      { label: 'Software Development' },
      { label: 'Support / Technical Services' },
      { label: 'Technician' },
      { label: 'Technology Operations' },
      { label: 'Test / Quality Assurance' },
      { label: 'UI / UX' },
      { label: 'Web Development' },
    ],
  },
  {
    section: 'Design',
    mapsTo: null,
    items: [
      { label: 'All Design' },
      { label: 'Product or UI/UX Design' },
      { label: 'Graphic / Visual / Brand Design' },
    ],
  },
  {
    section: 'Education',
    mapsTo: null,
    items: [
      { label: 'Teacher' },
      { label: 'Principal' },
      { label: 'Superintendent' },
      { label: 'Professor' },
    ],
  },
  {
    section: 'Finance',
    mapsTo: 'finance',
    items: [
      { label: 'Accounting', mapsTo: 'accounting' },
      { label: 'Finance' },
      { label: 'Financial Planning & Analysis' },
      { label: 'Financial Reporting' },
      { label: 'Financial Strategy' },
      { label: 'Financial Systems' },
      { label: 'Internal Audit & Control' },
      { label: 'Investor Relations' },
      { label: 'Mergers & Acquisitions' },
      { label: 'Real Estate Finance' },
      { label: 'Financial Risk' },
      { label: 'Shared Services' },
      { label: 'Sourcing / Procurement' },
      { label: 'Tax' },
      { label: 'Treasury' },
    ],
  },
  {
    section: 'Human Resources',
    mapsTo: 'human_resources',
    items: [
      { label: 'Compensation & Benefits' },
      { label: 'Culture, Diversity & Inclusion' },
      { label: 'Employee & Labor Relations' },
      { label: 'Health & Safety' },
      { label: 'Human Resource Information System' },
      { label: 'Human Resources' },
      { label: 'HR Business Partner' },
      { label: 'Learning & Development' },
      { label: 'Organizational Development' },
      { label: 'Recruiting & Talent Acquisition' },
      { label: 'Talent Management' },
      { label: 'Workforce Management' },
      { label: 'People Operations' },
    ],
  },
  {
    section: 'Information Technology',
    mapsTo: 'information_technology',
    items: [
      { label: 'Application Development' },
      { label: 'Business Service Management / ITSM' },
      { label: 'Collaboration & Web App' },
      { label: 'Data Center' },
      { label: 'Data Warehouse' },
      { label: 'Database Administration' },
      { label: 'eCommerce Development' },
      { label: 'Enterprise Architecture' },
      { label: 'Help Desk / Desktop Services' },
      { label: 'HR / Financial / ERP Systems' },
      { label: 'Information Security' },
      { label: 'Information Technology' },
      { label: 'Infrastructure' },
      { label: 'IT Asset Management' },
      { label: 'IT Audit / IT Compliance' },
      { label: 'IT Operations' },
      { label: 'IT Procurement' },
      { label: 'IT Strategy' },
      { label: 'IT Training' },
      { label: 'Networking' },
      { label: 'Project & Program Management' },
      { label: 'Quality Assurance' },
      { label: 'Retail / Store Systems' },
      { label: 'Servers' },
      { label: 'Storage & Disaster Recovery' },
      { label: 'Telecommunications' },
      { label: 'Virtualization' },
    ],
  },
  {
    section: 'Legal',
    mapsTo: 'legal',
    items: [
      { label: 'Acquisitions' },
      { label: 'Compliance' },
      { label: 'Contracts' },
      { label: 'Corporate Secretary' },
      { label: 'eDiscovery' },
      { label: 'Ethics' },
      { label: 'Governance' },
      { label: 'Governmental Affairs & Regulatory Law' },
      { label: 'Intellectual Property & Patent' },
      { label: 'Labor & Employment' },
      { label: 'Lawyer / Attorney' },
      { label: 'Legal' },
      { label: 'Legal Counsel' },
      { label: 'Legal Operations' },
      { label: 'Litigation' },
      { label: 'Privacy' },
    ],
  },
  {
    section: 'Marketing',
    mapsTo: 'marketing',
    items: [
      { label: 'Advertising' },
      { label: 'Brand Management' },
      { label: 'Content Marketing' },
      { label: 'Customer Experience' },
      { label: 'Customer Marketing' },
      { label: 'Demand Generation' },
      { label: 'Digital Marketing' },
      { label: 'eCommerce Marketing' },
      { label: 'Event Marketing' },
      { label: 'Field Marketing' },
      { label: 'Lead Generation' },
      { label: 'Marketing' },
      { label: 'Marketing Analytics / Insights' },
      { label: 'Marketing Communications' },
      { label: 'Marketing Operations' },
      { label: 'Product Marketing' },
      { label: 'Public Relations' },
      { label: 'Search Engine Optimization / Pay Per Click' },
      { label: 'Social Media Marketing' },
      { label: 'Strategic Communications' },
      { label: 'Technical Marketing' },
    ],
  },
  {
    section: 'Medical & Health',
    mapsTo: null,
    items: [
      { label: 'Anesthesiology' },
      { label: 'Chiropractics' },
      { label: 'Clinical Systems' },
      { label: 'Dentistry' },
      { label: 'Dermatology' },
      { label: 'Doctors / Physicians' },
      { label: 'Epidemiology' },
      { label: 'First Responder' },
      { label: 'Infectious Disease' },
      { label: 'Medical Administration' },
      { label: 'Medical Education & Training' },
      { label: 'Medical Research' },
      { label: 'Medicine' },
      { label: 'Neurology' },
      { label: 'Nursing' },
      { label: 'Nutrition & Dietetics' },
      { label: 'Obstetrics / Gynecology' },
      { label: 'Oncology' },
      { label: 'Opthalmology' },
      { label: 'Optometry' },
      { label: 'Orthopedics' },
      { label: 'Pathology' },
      { label: 'Pediatrics' },
      { label: 'Pharmacy' },
      { label: 'Physical Therapy' },
      { label: 'Psychiatry' },
      { label: 'Psychology' },
      { label: 'Public Health' },
      { label: 'Radiology' },
      { label: 'Social Work' },
    ],
  },
  {
    section: 'Operations',
    mapsTo: 'operations',
    items: [
      { label: 'Call Center' },
      { label: 'Construction' },
      { label: 'Corporate Strategy' },
      { label: 'Customer Service / Support' },
      { label: 'Enterprise Resource Planning' },
      { label: 'Facilities Management' },
      { label: 'Leasing' },
      { label: 'Logistics' },
      { label: 'Office Operations' },
      { label: 'Operations' },
      { label: 'Physical Security' },
      { label: 'Project Development' },
      { label: 'Quality Management' },
      { label: 'Real Estate' },
      { label: 'Safety' },
      { label: 'Store Operations' },
      { label: 'Supply Chain' },
    ],
  },
  {
    section: 'Sales',
    mapsTo: 'sales',
    items: [
      { label: 'Account Management' },
      { label: 'Business Development', mapsTo: 'business_development' },
      { label: 'Channel Sales' },
      { label: 'Customer Retention & Development' },
      { label: 'Customer Success' },
      { label: 'Field / Outside Sales' },
      { label: 'Inside Sales' },
      { label: 'Partnerships' },
      { label: 'Revenue Operations' },
      { label: 'Sales' },
      { label: 'Sales Enablement' },
      { label: 'Sales Engineering' },
      { label: 'Sales Operations' },
      { label: 'Sales Training' },
    ],
  },
  {
    section: 'Consulting',
    mapsTo: null,
    items: [{ label: 'Consultant' }],
  },
];
