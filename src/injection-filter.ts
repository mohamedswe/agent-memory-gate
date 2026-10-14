/**
 * System-injection shapes — shared filter for any lane that must see ONLY
 * the user's actual voice (repetition keys, satisfaction trajectories).
 * Codex injects environment context, plugin lists, AGENTS.md instructions,
 * and app wrappers as user-role content; they repeat across EVERY session
 * and must never become memory candidates. Shape-matched, never guessed.
 */
const INJECTED_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<turn_context',
  '# AGENTS.md instructions',
  '<INSTRUCTIONS>',
  '<external_codex_apps_open_page>',
  '<external_codex_apps',
  '<recommended_plugins>',
  'The following is the Codex agent history',
];

export function isSystemInjected(text: string): boolean {
  const t = text.trimStart();
  return INJECTED_PREFIXES.some(p => t.startsWith(p));
}