export interface SlashSkillQuery {
  start: number;
  query: string;
}

export function findSlashSkillQuery(text: string, caret: number): SlashSkillQuery | null {
  const prefix = text.slice(0, caret);
  const match = /(?:^|\s)\/([a-z0-9-]*)$/u.exec(prefix);
  if (match === null) return null;
  return { start: prefix.length - (match[1]?.length ?? 0) - 1, query: match[1] ?? "" };
}

export function insertSlashSkill(
  text: string,
  query: SlashSkillQuery,
  name: string,
): { text: string; caret: number } {
  const end = query.start + query.query.length + 1;
  const suffix = text.slice(end);
  const token = `/${name}${suffix === "" ? " " : ""}`;
  return {
    text: `${text.slice(0, query.start)}${token}${suffix}`,
    caret: query.start + token.length,
  };
}
