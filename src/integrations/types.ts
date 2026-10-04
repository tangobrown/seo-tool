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
  dispatchWorkflow(fullName: string, ref: string, inputs: Record<string, string>): Promise<void>;
  listWorkflowRuns(fullName: string, createdSince: Date): Promise<WorkflowRun[]>;
  getPullRequest(fullName: string, number: number): Promise<{ state: string; merged: boolean; mergeable: boolean | null; html_url: string }>;
}

export type WorkflowRun = {
  id: number;
  name?: string | null;
  display_title?: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  created_at: string;
};

export type LLMProvider = {
  json<T>(input: { system: string; prompt: string; schemaName: string; validate: (v: unknown) => T; promptVersion: string }): Promise<T>;
};
