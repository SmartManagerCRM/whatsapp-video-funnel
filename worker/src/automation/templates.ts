import type { Env } from "../env";

/** Built-in defaults. Every key is editable per tenant (and per language) in the dashboard. */
export const DEFAULT_TEMPLATES: Record<string, { label: string; body: string }> = {
  welcome: { label: "Welcome message", body: "Welcome to {{business}}! 👋\n\nThank you for contacting us. We'd like to show you a short video presentation tailored to your business." },
  category_question: { label: "Category selection question", body: "Please select your type of business to continue:" },
  category_list_button: { label: "Category list button label", body: "Choose" },
  category_fallback: { label: "Invalid category fallback", body: "Sorry, I didn't recognise that choice. Please pick one of the options below, or reply with its number." },
  category_text_list: { label: "Text-only category list intro", body: "Reply with the number of your business type:" },
  video_intro: { label: "Video introduction (optional, sent before each video; leave empty to disable)", body: "" },
  continue_prompt: { label: "Continue message", body: "Tap Continue when you're ready for the next video ▶️" },
  continue_button: { label: "Continue button label", body: "Continue" },
  change_category_button: { label: "Change category button label", body: "Change category" },
  category_change_confirm: { label: "Category change confirmation", body: "Switch to {{category}}? Your presentation will be updated." },
  category_change_yes: { label: "Confirm change button", body: "Yes, switch" },
  category_change_no: { label: "Keep current button", body: "Keep current" },
  category_change_kept: { label: "Category kept message", body: "No problem, we'll continue with your current presentation." },
  website_invite: { label: "Website invitation", body: "Thank you for taking the time to explore our presentation.\n\nDiscover more about our services and solutions through our website." },
  goodbye: { label: "Goodbye message", body: "Thank you for your interest.\n\nWe hope you enjoyed discovering our solutions.\n\nWe look forward to hearing from you.\n\nHave a wonderful day!" },
  handover: { label: "Human handover message", body: "A member of our team will continue this conversation with you personally." },
  optout_confirm: { label: "Opt-out confirmation", body: "You have been unsubscribed and will receive no further automated messages. Send START to begin again." },
  optin_confirm: { label: "Opt-in confirmation", body: "Welcome back! Starting your presentation now." },
  resume_notice: { label: "Resume notice (after the 24h window reopens)", body: "Welcome back! Let's continue your presentation." },
  error_generic: { label: "Error / fallback message", body: "Sorry, something went wrong on our side. A member of our team will follow up with you." },
};

export interface TemplateRow { key: string; language: string; body: string }

export async function getTemplate(env: Env, tenantId: string, key: string, language: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT body FROM message_templates WHERE tenant_id = ? AND key = ? AND language = ?",
  ).bind(tenantId, key, language).first<{ body: string }>();
  if (row) return row.body;
  if (language !== "en") {
    const en = await env.DB.prepare("SELECT body FROM message_templates WHERE tenant_id = ? AND key = ? AND language = 'en'")
      .bind(tenantId, key).first<{ body: string }>();
    if (en) return en.body;
  }
  return DEFAULT_TEMPLATES[key]?.body ?? "";
}

export function render(body: string, vars: Record<string, string | number | null | undefined>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ""));
}
