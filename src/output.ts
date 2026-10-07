/** Every engine truncates what the agent sees the same way (fairness rule, PLAN §8.2). */
export const MAX_OUTPUT_CHARS = 4000;

export function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated, ${text.length - MAX_OUTPUT_CHARS} more characters]`;
}
