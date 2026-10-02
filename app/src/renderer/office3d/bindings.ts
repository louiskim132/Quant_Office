export const CONTROL_ACTIONS = {
  panLeft: 'Move left',
  panRight: 'Move right',
  panUp: 'Move up',
  panDown: 'Move down',
  rotateLeft: 'Rotate left',
  rotateRight: 'Rotate right',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  reset: 'Reset view',
};
export type ControlAction = keyof typeof CONTROL_ACTIONS;
export type DragAction = 'pan' | 'rotate' | 'zoom';
export interface ViewBindings {
  mouse: [DragAction, DragAction, DragAction];
  keys: Record<ControlAction, string>;
}
export const DEFAULT_BINDINGS: ViewBindings = {
  mouse: ['pan', 'zoom', 'rotate'],
  keys: {
    panLeft: 'a',
    panRight: 'd',
    panUp: 'w',
    panDown: 's',
    rotateLeft: 'ArrowLeft',
    rotateRight: 'ArrowRight',
    zoomIn: '=',
    zoomOut: '-',
    reset: 'Home',
  },
};
export function parseBindings(raw: string): ViewBindings {
  try {
    const value = JSON.parse(raw) as ViewBindings;
    if (
      !Array.isArray(value.mouse) ||
      value.mouse.length !== 3 ||
      new Set(value.mouse).size !== 3 ||
      value.mouse.some(x => !['pan', 'rotate', 'zoom'].includes(x))
    )
      return structuredClone(DEFAULT_BINDINGS);
    const keys = Object.keys(CONTROL_ACTIONS) as ControlAction[];
    if (
      !value.keys ||
      keys.some(k => typeof value.keys[k] !== 'string' || !value.keys[k] || value.keys[k].length > 40) ||
      new Set(keys.map(k => value.keys[k])).size !== keys.length
    )
      return structuredClone(DEFAULT_BINDINGS);
    return {
      mouse: [...value.mouse],
      keys: Object.fromEntries(keys.map(k => [k, value.keys[k]])) as ViewBindings['keys'],
    };
  } catch {
    return structuredClone(DEFAULT_BINDINGS);
  }
}
export function shortcutKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>): string {
  if (['Control', 'Alt', 'Meta', 'Shift', 'Tab', 'Escape'].includes(e.key)) return '';
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.metaKey ? 'Meta+' : ''}${e.shiftKey && e.key.length !== 1 ? 'Shift+' : ''}${key}`;
}
export function bindKey(bindings: ViewBindings, action: ControlAction, key: string): ViewBindings {
  const keys = { ...bindings.keys };
  const previous = (Object.keys(keys) as ControlAction[]).find(k => keys[k] === key);
  if (previous) keys[previous] = keys[action];
  keys[action] = key;
  return { ...bindings, keys };
}
export function bindMouse(bindings: ViewBindings, button: number, action: DragAction): ViewBindings {
  const mouse = [...bindings.mouse] as ViewBindings['mouse'];
  const previous = mouse.indexOf(action);
  mouse[previous] = mouse[button];
  mouse[button] = action;
  return { ...bindings, mouse };
}
