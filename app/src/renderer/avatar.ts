/**
 * Appearance is a pure function of the agent id, so a person keeps the same look on every page, in
 * every list position, and across restarts. It never depends on where the agent sits in a list.
 */
const SHIRTS = [
  '#3c74c4',
  '#9265b2',
  '#299d9c',
  '#df9850',
  '#c25a6a',
  '#5b8c3e',
  '#7a6fd0',
  '#c9a227',
  '#3f8fb5',
  '#b5654a',
];
const HAIRS = ['#393b4c', '#4a2f22', '#1f1f28', '#7a4a26', '#c9a86a', '#8c8c94', '#6a2f2f'];
const SKINS = ['#e8b68c', '#f2c9a5', '#c98f68', '#a56b45', '#7c4d32', '#f5d6bd'];

export interface AvatarLook {
  shirt: string;
  hair: string;
  skin: string;
  initials: string;
}
/** 32-bit FNV-1a — small, stable, no dependency. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  // "Test PM A" reads better as "PA" than "TP": prefer the last two words when the first is generic.
  const picked = words.length > 2 ? words.slice(-2) : words;
  return (picked[0][0] + picked[picked.length - 1][0]).toUpperCase();
}
export function avatarLook(id: string, name = ''): AvatarLook {
  const h = hashId(id);
  return {
    shirt: SHIRTS[h % SHIRTS.length],
    hair: HAIRS[(h >>> 5) % HAIRS.length],
    skin: SKINS[(h >>> 11) % SKINS.length],
    initials: initialsOf(name || id),
  };
}
