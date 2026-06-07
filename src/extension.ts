import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Sentinel file written by the PreToolUse hook in ~/.claude/settings.json
// BEFORE the AskUserQuestion dialog appears.
const TRIGGER_FILE = path.join(os.homedir(), '.claude', 'notifier-trigger');

// ─── Sentinel File Watcher (primary) ─────────────────────────────────────────
// Claude Code's PreToolUse hook writes this file the instant AskUserQuestion
// is called — before the dialog is displayed to the user.

class SentinelWatcher {
  private watcher: vscode.FileSystemWatcher | undefined;
  private onTrigger: () => void;
  private out: vscode.OutputChannel;

  constructor(onTrigger: () => void, out: vscode.OutputChannel) {
    this.onTrigger = onTrigger;
    this.out = out;
  }

  start(): void {
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(path.dirname(TRIGGER_FILE)),
      path.basename(TRIGGER_FILE)
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, true);

    const handler = () => {
      this.out.appendLine('[Notifier] Sentinel file touched — triggering sound');
      this.onTrigger();
    };
    this.watcher.onDidCreate(handler);
    this.watcher.onDidChange(handler);

    this.out.appendLine(`[Notifier] Watching sentinel file: ${TRIGGER_FILE}`);
  }

  dispose(): void {
    this.watcher?.dispose();
  }
}

// ─── JSONL Watcher (fallback) ─────────────────────────────────────────────────
// Used when the hook is not configured. Fires after user responds (late),
// but still useful as a safety net.

function lineRequiresUserInput(line: string): boolean {
  if (!line.includes('"role":"assistant"') && !line.includes('"role": "assistant"')) {
    return false;
  }
  return line.includes('"name":"AskUserQuestion"') || line.includes('"name": "AskUserQuestion"');
}

interface FileState { size: number; }

class JsonlWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private fileStates: Map<string, FileState> = new Map();
  private onTrigger: () => void;
  private out: vscode.OutputChannel;
  private claudeDir: string;

  constructor(onTrigger: () => void, out: vscode.OutputChannel) {
    this.onTrigger = onTrigger;
    this.out = out;
    this.claudeDir = path.join(os.homedir(), '.claude', 'projects');
  }

  start(): void {
    if (!fs.existsSync(this.claudeDir)) { return; }
    this.scanAll(true); // init sizes, no trigger
    this.timer = setInterval(() => this.scanAll(false), 300);
    this.out.appendLine(`[Notifier] JSONL fallback polling started (${this.fileStates.size} files)`);
  }

  private scanAll(silent: boolean): void {
    try { this.scanDir(this.claudeDir, silent); } catch (_) { /* ignore */ }
  }

  private scanDir(dirPath: string, silent: boolean): void {
    try {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const fp = path.join(dirPath, entry.name);
        if (entry.isFile() && entry.name.endsWith('.jsonl')) { this.checkFile(fp, silent); }
        else if (entry.isDirectory()) { this.scanDir(fp, silent); }
      }
    } catch (_) { /* skip */ }
  }

  private checkFile(filePath: string, silent: boolean): void {
    try {
      const newSize = fs.statSync(filePath).size;
      const prev = this.fileStates.get(filePath);
      if (!prev) { this.fileStates.set(filePath, { size: newSize }); return; }
      if (newSize <= prev.size) { return; }

      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(newSize - prev.size);
      fs.readSync(fd, buf, 0, buf.length, prev.size);
      fs.closeSync(fd);
      this.fileStates.set(filePath, { size: newSize });

      if (silent) { return; }
      for (const line of buf.toString('utf8').split('\n')) {
        if (line.trim() && lineRequiresUserInput(line)) {
          this.out.appendLine(`[Notifier] JSONL fallback: AskUserQuestion in ${path.basename(filePath)}`);
          this.onTrigger();
          return;
        }
      }
    } catch (_) { /* skip */ }
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); }
  }
}

// ─── Audio ───────────────────────────────────────────────────────────────────

function playSound(soundPath: string, volume: number, out: vscode.OutputChannel): void {
  const v = Math.max(0, Math.min(1, volume));
  out.appendLine(`[Notifier] Playing sound: ${soundPath || '(built-in beep)'}`);

  if (soundPath && fs.existsSync(soundPath)) {
    const p = os.platform();
    let cmd: string;
    if (p === 'win32') {
      const esc = soundPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
      cmd = `powershell -NonInteractive -WindowStyle Hidden -Command "` +
        `Add-Type -AssemblyName PresentationCore; ` +
        `$m = New-Object System.Windows.Media.MediaPlayer; ` +
        `$m.Open([Uri]'${esc}'); $m.Volume = ${v}; $m.Play(); ` +
        `Start-Sleep -Milliseconds 5000; $m.Stop()"`;
    } else if (p === 'darwin') {
      cmd = `afplay -v ${Math.round(v * 255)} "${soundPath}"`;
    } else {
      cmd = `paplay "${soundPath}" 2>/dev/null || aplay "${soundPath}" 2>/dev/null`;
    }
    cp.exec(cmd, err => {
      if (err) { out.appendLine(`[Notifier] Playback error: ${err.message}`); }
    });
    return;
  }

  if (os.platform() === 'win32') {
    cp.exec(
      `powershell -NonInteractive -WindowStyle Hidden -Command ` +
      `"[console]::beep(880,180); [System.Threading.Thread]::Sleep(220); [console]::beep(660,280)"`,
      err => { if (err) { out.appendLine(`[Notifier] Beep error: ${err.message}`); } }
    );
  } else if (os.platform() === 'darwin') {
    cp.exec('afplay /System/Library/Sounds/Ping.aiff');
  } else {
    cp.exec('paplay /usr/share/sounds/freedesktop/stereo/bell.oga 2>/dev/null');
  }
}

// ─── Status Bar ──────────────────────────────────────────────────────────────

let statusBar: vscode.StatusBarItem;

function refreshStatusBar(): void {
  const on = vscode.workspace.getConfiguration('claudeNotifier').get<boolean>('enabled', true);
  statusBar.text    = on ? '$(bell) Claude' : '$(bell-slash) Claude';
  statusBar.tooltip = on ? 'Claude Notifier: ON — click to disable' : 'Claude Notifier: OFF — click to enable';
  statusBar.color   = on ? undefined : new vscode.ThemeColor('statusBarItem.warningForeground');
}

// ─── Activate ────────────────────────────────────────────────────────────────

let lastTriggerMs = 0;
let sentinel: SentinelWatcher | undefined;
let jsonlWatcher: JsonlWatcher | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Claude Notifier');
  context.subscriptions.push(out);
  out.appendLine('[Notifier] Extension activated');

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBar.command = 'claudeNotifier.toggle';
  refreshStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeNotifier')) { refreshStatusBar(); }
    })
  );

  function trigger(): void {
    const cfg = vscode.workspace.getConfiguration('claudeNotifier');
    if (!cfg.get<boolean>('enabled', true)) { return; }
    const now = Date.now();
    if (now - lastTriggerMs < cfg.get<number>('cooldownMs', 3000)) { return; }
    lastTriggerMs = now;

    playSound(cfg.get<string>('soundPath', '').trim(), cfg.get<number>('volume', 0.8), out);

    if (cfg.get<boolean>('alsoNotify', true)) {
      vscode.window.showInformationMessage('Claude Code is waiting for your input.', 'Dismiss');
    }
  }

  // Primary: sentinel file written by PreToolUse hook
  sentinel = new SentinelWatcher(trigger, out);
  sentinel.start();


  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeNotifier.selectSound', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        title:   'Select notification sound',
        filters: { 'Audio': ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] },
      });
      if (!uris?.length) { return; }
      const chosen = uris[0].fsPath;
      await vscode.workspace.getConfiguration('claudeNotifier')
        .update('soundPath', chosen, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Sound set to "${path.basename(chosen)}". Playing preview…`);
      playSound(chosen, vscode.workspace.getConfiguration('claudeNotifier').get<number>('volume', 0.8), out);
    }),

    vscode.commands.registerCommand('claudeNotifier.testSound', () => {
      const cfg = vscode.workspace.getConfiguration('claudeNotifier');
      playSound(cfg.get<string>('soundPath', '').trim(), cfg.get<number>('volume', 0.8), out);
      vscode.window.showInformationMessage('Claude Notifier: test sound played.');
    }),

    vscode.commands.registerCommand('claudeNotifier.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('claudeNotifier');
      await cfg.update('enabled', !cfg.get<boolean>('enabled', true), vscode.ConfigurationTarget.Global);
      refreshStatusBar();
    }),

    vscode.commands.registerCommand('claudeNotifier.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'claudeNotifier');
    })
  );
}

export function deactivate(): void {
  sentinel?.dispose();
  jsonlWatcher?.dispose();
}
