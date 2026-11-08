// Supabase project the app talks to. The publishable key is meant to be
// public: it only lets the browser call the oh_* functions, which check
// every request themselves.
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? '';
export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_KEY ?? '';
export const HAS_CLOUD = Boolean(SUPABASE_URL && SUPABASE_KEY);

// The platform's name, shown next to the logo (also in index.html and the manifest).
export const APP_NAME = '叁式 ULTRACOMBOS One Hour a Week';
// Sessions are recorded; students and teachers are told wherever a session shows up.
export const RECORDING_NOTE = '討論時 Google Meet 會錄影，僅作為紀錄使用';
export const RECORDING_SHORT = '會錄影，僅作紀錄用';
// The weekly email (.github/workflows/mail.yml): a preview to the admins
// first, then each recipient's week of sessions.
export const MAIL_REMIND = '週日 12:00';
export const MAIL_PREVIEW = '週六 21:00';
export const MAIL_SEND = '週日 08:00';
/** The part that still fits a phone's top bar. */
export const APP_SHORT_NAME = '叁式 ULTRACOMBOS';
