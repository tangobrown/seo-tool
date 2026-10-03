import type { TagColor } from "./Tag";

export const CATEGORY_TAG: Record<string, { label: string; color: TagColor }> = {
  technical: { label: "Technical", color: "blue" },
  on_page: { label: "On-page", color: "purple" },
  content: { label: "Content", color: "orange" },
  links: { label: "Links", color: "green" },
  local: { label: "Local", color: "yellow" },
};

export const IMPACT_TAG: Record<string, { label: string; color: TagColor }> = {
  high: { label: "High impact", color: "red" },
  medium: { label: "Medium impact", color: "yellow" },
  low: { label: "Low impact", color: "gray" },
};

export const DECISION_TAG: Record<string, { label: string; color: TagColor }> = {
  pending: { label: "Pending", color: "gray" },
  approved: { label: "Approved", color: "green" },
  deferred: { label: "Deferred", color: "yellow" },
  declined: { label: "Declined", color: "red" },
};

export const EXECUTION_TAG: Record<string, { label: string; color: TagColor }> = {
  queued: { label: "Queued", color: "gray" },
  running: { label: "Running", color: "blue" },
  pr_ready: { label: "PR ready", color: "purple" },
  merged: { label: "Merged", color: "purple" },
  live: { label: "Live", color: "green" },
  failed: { label: "Failed", color: "red" },
  action_needed: { label: "Action needed", color: "yellow" },
  cancelled: { label: "Cancelled", color: "gray" },
};

export const TIER_TAG: Record<string, TagColor> = { Starter: "gray", Growth: "blue", Pro: "purple" };

export const ATTENTION_TAG: Record<string, { label: string; color: TagColor }> = {
  pr_review: { label: "PR to review", color: "purple" },
  failed: { label: "Failed", color: "red" },
  manual_action: { label: "Manual action", color: "yellow" },
  integration: { label: "Integration", color: "orange" },
  confirm_client: { label: "Confirm client", color: "blue" },
  blog_commitment: { label: "Blog commitment", color: "orange" },
  report_ready: { label: "Report ready", color: "green" },
};
