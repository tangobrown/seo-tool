// Provider interfaces. UI and route code never call provider SDKs directly.

export type SiteguruSite = { id: string; domain: string };

export interface SEODataProvider {
  listSites(): Promise<SiteguruSite[]>;
}

export type GbpLocation = { id: string; name: string; websiteUrl: string | null; address: string | null };

export interface BusinessProfileProvider {
  listLocations(): Promise<GbpLocation[]>;
}

export interface NotificationProvider {
  send(text: string): Promise<void>;
}

export type RepoInfo = { fullName: string; defaultBranch: string; private: boolean };

export interface CodeExecutionProvider {
  listRepos(): Promise<RepoInfo[]>;
  getRepo(fullName: string): Promise<RepoInfo | null>;
  readFile(fullName: string, path: string, ref?: string): Promise<string | null>;
  openSetupPr(input: {
    fullName: string;
    baseBranch: string;
    branch: string;
    files: { path: string; content: string }[];
    title: string;
    body: string;
  }): Promise<{ number: number; url: string; alreadyOpen: boolean }>;
}

export type LLMProvider = {
  json<T>(input: { system: string; prompt: string; schemaName: string; validate: (v: unknown) => T; promptVersion: string }): Promise<T>;
};
