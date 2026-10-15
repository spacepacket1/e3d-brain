/**
 * Note text can come from an agent or a transcript: strip what a terminal would act on (escape sequences, carriage
 * returns, other C0/C1 controls, bidirectional overrides) so a note cannot redraw the screen the owner reviews.
 */
export function terminalSafe(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => (c === '\u001b' ? '\u241b' : ''));
}
