import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { paths } from './paths.js';

// ---- Desktop Automation ----
// macOS-native: AppleScript for clicks/keystrokes, screencapture for screenshots.
// Everything gated by the permission broker. No mouse-grabbers, no keyloggers.

function captureDir(): string {
  const dir = join(paths.home, 'captures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Take a screenshot. Returns the saved file path. */
export function desktopScreenshot(options?: { window?: string; clip?: boolean }): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = join(captureDir(), `capture-${stamp}.png`);
  if (options?.window) {
    // Capture specific window by app name
    execSync(`screencapture -l$(osascript -e 'tell app "System Events" to id of first process whose name contains "${options.window}"') "${file}"`);
  } else if (options?.clip) {
    execSync(`screencapture -i "${file}"`);
  } else {
    execSync(`screencapture "${file}"`);
  }
  return file;
}

/** Click at screen coordinates (x, y) or on a UI element by description. */
export function desktopClick(target: { x: number; y: number } | { element: string; app: string }): string {
  if ('x' in target) {
    execSync(`osascript -e 'tell application "System Events" to click at {${target.x}, ${target.y}}'`);
    return `clicked at (${target.x}, ${target.y})`;
  } else {
    const script = `tell application "System Events" to tell process "${target.app}"
  click UI element "${target.element}"
end tell`;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    return `clicked "${target.element}" in ${target.app}`;
  }
}

/** Type text into the active application. */
export function desktopType(text: string): string {
  const escaped = text.replace(/"/g, '\\"');
  execSync(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`);
  return `typed ${text.length} characters`;
}

/** Send a key combination (e.g. "command+tab", "control+c"). */
export function desktopKeystroke(keys: string): string {
  const parts = keys.toLowerCase().split('+').map(s => s.trim());
  const modifiers = parts.slice(0, -1);
  const key = parts[parts.length - 1];
  const modMap: Record<string, string> = {
    command: 'command down',
    cmd: 'command down',
    option: 'option down',
    opt: 'option down',
    alt: 'option down',
    control: 'control down',
    ctrl: 'control down',
    shift: 'shift down',
  };
  const modString = modifiers.map(m => modMap[m] ?? '').filter(Boolean).join(', ');
  const script = modString
    ? `tell application "System Events" to keystroke "${key}" using {${modString}}`
    : `tell application "System Events" to keystroke "${key}"`;
  execSync(`osascript -e '${script}'`);
  return `sent ${keys}`;
}

/** List visible windows/processes. */
export function desktopListWindows(): { name: string; pid: number }[] {
  const out = execSync(`osascript -e 'tell application "System Events" to get {name, unix id} of every process whose background only is false'`, { encoding: 'utf8' });
  // Output is like: { "Safari", 123, "Terminal", 456 }
  // Parse manually
  const lines = out.trim().split('\n');
  const result: { name: string; pid: number }[] = [];
  for (const line of lines) {
    const match = line.match(/"([^"]+)",\s*(\d+)/g);
    if (match) {
      for (const m of match) {
        const [, name, pid] = m.match(/"([^"]+)",\s*(\d+)/) ?? [];
        if (name && pid) result.push({ name, pid: Number(pid) });
      }
    }
  }
  return result;
}

/** Focus an application by name. */
export function desktopFocus(app: string): string {
  execSync(`osascript -e 'tell application "${app}" to activate'`);
  return `focused ${app}`;
}
