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

/** Built-in translations. Tenants can override any message per language; missing keys fall back to English. */
export const TRANSLATIONS: Record<string, Record<string, string>> = {
  fr: {
    welcome: "Bienvenue chez {{business}} ! 👋\n\nMerci de nous avoir contactés. Nous aimerions vous présenter une courte vidéo adaptée à votre activité.",
    category_question: "Veuillez sélectionner votre type d'activité pour continuer :",
    category_list_button: "Choisir",
    category_fallback: "Désolé, je n'ai pas reconnu ce choix. Veuillez choisir l'une des options ci-dessous ou répondre avec son numéro.",
    category_text_list: "Répondez avec le numéro de votre type d'activité :",
    video_intro: "",
    continue_prompt: "Appuyez sur Continuer quand vous êtes prêt pour la vidéo suivante ▶️",
    continue_button: "Continuer",
    change_category_button: "Changer d'activité",
    category_change_confirm: "Passer à {{category}} ? Votre présentation sera mise à jour.",
    category_change_yes: "Oui, changer",
    category_change_no: "Garder l'actuelle",
    category_change_kept: "Pas de problème, nous continuons avec votre présentation actuelle.",
    website_invite: "Merci d'avoir pris le temps de découvrir notre présentation.\n\nDécouvrez-en davantage sur nos services et solutions sur notre site web.",
    goodbye: "Merci de votre intérêt.\n\nNous espérons que vous avez apprécié la découverte de nos solutions.\n\nNous serons ravis d'avoir de vos nouvelles.\n\nExcellente journée !",
    handover: "Un membre de notre équipe va poursuivre cette conversation avec vous personnellement.",
    optout_confirm: "Vous avez été désinscrit et ne recevrez plus de messages automatiques. Envoyez DEMARRER pour recommencer.",
    optin_confirm: "Bon retour ! Nous démarrons votre présentation.",
    resume_notice: "Bon retour ! Reprenons votre présentation.",
    error_generic: "Désolé, une erreur est survenue de notre côté. Un membre de notre équipe vous recontactera.",
  },
  ar: {
    welcome: "أهلاً بكم في {{business}}! 👋\n\nشكراً لتواصلكم معنا. يسعدنا أن نعرض عليكم فيديو قصيراً يناسب نشاطكم التجاري.",
    category_question: "يرجى اختيار نوع نشاطكم التجاري للمتابعة:",
    category_list_button: "اختيار",
    category_fallback: "عذراً، لم أتعرّف على هذا الاختيار. يرجى اختيار أحد الخيارات أدناه أو الرد برقمه.",
    category_text_list: "رُدّوا برقم نوع نشاطكم التجاري:",
    video_intro: "",
    continue_prompt: "اضغطوا على متابعة عندما تكونون جاهزين للفيديو التالي ▶️",
    continue_button: "متابعة",
    change_category_button: "تغيير النشاط",
    category_change_confirm: "هل تريدون التحويل إلى {{category}}؟ سيتم تحديث العرض.",
    category_change_yes: "نعم، تحويل",
    category_change_no: "إبقاء الحالي",
    category_change_kept: "لا مشكلة، سنتابع مع عرضكم الحالي.",
    website_invite: "شكراً لأنكم خصصتم وقتاً لمشاهدة عرضنا.\n\nاكتشفوا المزيد عن خدماتنا وحلولنا عبر موقعنا الإلكتروني.",
    goodbye: "شكراً لاهتمامكم.\n\nنأمل أن تكونوا قد استمتعتم باكتشاف حلولنا.\n\nنتطلع إلى التواصل معكم.\n\nنتمنى لكم يوماً سعيداً!",
    handover: "سيتابع أحد أعضاء فريقنا هذه المحادثة معكم شخصياً.",
    optout_confirm: "تم إلغاء اشتراككم ولن تصلكم رسائل آلية بعد الآن. أرسلوا ابدأ للبدء من جديد.",
    optin_confirm: "أهلاً بعودتكم! سنبدأ عرضكم الآن.",
    resume_notice: "أهلاً بعودتكم! لنتابع عرضكم.",
    error_generic: "عذراً، حدث خطأ من جانبنا. سيتواصل معكم أحد أعضاء فريقنا.",
  },
};

/** Built-in text for a language, falling back to English. */
export function builtinTemplate(key: string, language: string): string {
  const base = language.toLowerCase().split("-")[0];
  return TRANSLATIONS[base]?.[key] ?? DEFAULT_TEMPLATES[key]?.body ?? "";
}

export interface TemplateRow { key: string; language: string; body: string }

export async function getTemplate(env: Env, tenantId: string, key: string, language: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT body FROM message_templates WHERE tenant_id = ? AND key = ? AND language = ?",
  ).bind(tenantId, key, language).first<{ body: string }>();
  if (row) return row.body;                                   // 1. tenant's own text in this language
  const base = language.toLowerCase().split("-")[0];
  if (TRANSLATIONS[base]?.[key] !== undefined) return TRANSLATIONS[base][key]; // 2. built-in translation
  if (language !== "en") {                                    // 3. tenant's English text, then built-in English
    const en = await env.DB.prepare("SELECT body FROM message_templates WHERE tenant_id = ? AND key = ? AND language = 'en'")
      .bind(tenantId, key).first<{ body: string }>();
    if (en) return en.body;
  }
  return DEFAULT_TEMPLATES[key]?.body ?? "";
}

export function render(body: string, vars: Record<string, string | number | null | undefined>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ""));
}
