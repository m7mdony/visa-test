export type ProcessingClientApplicant = {
  applicantId: string;
  passportNumber: string;
  firstName: string;
  lastName: string;
  /** Full name from API when present (dashboard often shows more than first+last). */
  displayName: string;
};

export type ProcessingClientRow = {
  clientId: string;
  status: string;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  fromCountry: string;
  toCountry: string;
  visaCategoryName: string;
  subVisaCategoryName: string;
  visaCenterName: string;
  notes: string;
  userName: string;
  applicantCount: number;
  applicants: ProcessingClientApplicant[];
  errorMessage: string;
  isPaused: boolean;
};
