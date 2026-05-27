export interface Company {
  name: string;
  court: string;
  registerType: string;
  registerNumber: string;
  state: string;
  status: string;
  history: HistoryEntry[];
}

export interface HistoryEntry {
  name: string;
  location: string;
}

export interface SearchOptions {
  keywords: string;
  keywordMode?: "all" | "min" | "exact";
  location?: string;
  registerType?: "" | "HRA" | "HRB" | "GnR" | "PR" | "VR" | "GsR";
  registerNumber?: string;
  courtCode?: string;
  includeDeleted?: boolean;
  phonetic?: boolean;
  resultsPerPage?: 10 | 25 | 50 | 100;
}

export interface SearchResult {
  companies: Company[];
  totalHits: number;
  query: SearchOptions;
}

export interface Court {
  code: string;
  name: string;
}
