/**
 * Platform-specific command builders for OS interactions.
 *
 * These functions generate the command/args arrays for platform-specific
 * operations (folder dialogs, open in finder, open terminal, reveal file).
 * They are pure functions (no side-effects) to enable thorough unit testing.
 */

export type Platform = 'darwin' | 'win32' | 'linux';

export interface CommandSpec {
    cmd: string;
    args: string[];
    options?: { cwd?: string };
}

/**
 * Build the command to open a native folder picker dialog.
 */
export function buildFolderPickerCommand(platform: Platform, lastBrowsed?: string | null, prompt = 'Select a workspace folder'): CommandSpec {
    if (platform === 'darwin') {
        const scriptParts = [`POSIX path of (choose folder with prompt "${prompt}"`];
        if (lastBrowsed) {
            const safe = lastBrowsed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            scriptParts.push(` default location POSIX file "${safe}"`);
        }
        scriptParts.push(')');
        return { cmd: 'osascript', args: ['-e', scriptParts.join('')] };
    } else if (platform === 'win32') {
        const initialDirLine = lastBrowsed
            ? `$dialog.SelectedPath = [System.IO.Path]::GetFullPath("${lastBrowsed.replace(/"/g, '')}")`
            : '';
        const psScript = [
            'Add-Type -AssemblyName System.Windows.Forms',
            '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
            `$dialog.Description = "${prompt}"`,
            '$dialog.ShowNewFolderButton = $true',
            ...(initialDirLine ? [initialDirLine] : []),
            'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
        ].join('\n');
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        return { cmd: 'powershell', args: ['-NoProfile', '-EncodedCommand', encoded] };
    } else {
        // Linux - zenity
        const args = ['--file-selection', '--directory', `--title=${prompt}`];
        if (lastBrowsed) args.push(`--filename=${lastBrowsed}/`);
        return { cmd: 'zenity', args };
    }
}

/**
 * Build the command to open a folder in the native file manager.
 */
export function buildOpenFolderCommand(platform: Platform, folderPath: string): CommandSpec {
    if (platform === 'darwin') {
        return { cmd: 'open', args: [folderPath] };
    } else if (platform === 'win32') {
        return { cmd: 'explorer.exe', args: [folderPath] };
    } else {
        return { cmd: 'xdg-open', args: [folderPath] };
    }
}

/**
 * Build the command to open a terminal at a given path.
 */
export function buildOpenTerminalCommand(platform: Platform, workspacePath: string): CommandSpec {
    if (platform === 'darwin') {
        const safeId = workspacePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return {
            cmd: 'osascript',
            args: [
                '-e', `tell application "Terminal" to do script "cd \\"${safeId}\\""`,
                '-e', 'tell application "Terminal" to activate',
            ]
        };
    } else if (platform === 'win32') {
        return {
            cmd: 'cmd.exe',
            args: ['/C', 'start', 'cmd.exe'],
            options: { cwd: workspacePath }
        };
    } else {
        // Linux - try x-terminal-emulator first
        return {
            cmd: 'x-terminal-emulator',
            args: [`--working-directory=${workspacePath}`]
        };
    }
}

/**
 * Build the command to reveal a file in the native file manager.
 */
export function buildRevealFileCommand(platform: Platform, filePath: string): CommandSpec {
    if (platform === 'darwin') {
        return { cmd: 'open', args: ['-R', filePath] };
    } else if (platform === 'win32') {
        return { cmd: 'explorer.exe', args: [`/select,${filePath.replace(/\//g, '\\')}`] };
    } else {
        // Linux - open parent directory
        const parentDir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
        return { cmd: 'xdg-open', args: [parentDir] };
    }
}

/**
 * Build the command for the reference folder picker (simpler variant).
 */
export function buildReferenceFolderPickerCommand(platform: Platform): CommandSpec {
    if (platform === 'darwin') {
        return { cmd: 'osascript', args: ['-e', 'POSIX path of (choose folder with prompt "Select reference folder")'] };
    } else if (platform === 'win32') {
        return {
            cmd: 'powershell',
            args: ['-Command', `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select reference folder'; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath } else { '' }`]
        };
    } else {
        return { cmd: 'zenity', args: ['--file-selection', '--directory', '--title=Select reference folder'] };
    }
}

/**
 * Build PATH environment string with extra directories for the current platform.
 */
export function buildPathWithExtras(platform: Platform, homeDir: string, originalPath: string): string {
    const extraPaths = platform === 'win32'
        ? [`${homeDir}/.local/bin`, `${homeDir}/AppData/Roaming/npm`]
        : [`${homeDir}/.local/bin`, `${homeDir}/.npm-global/bin`, '/usr/local/bin'];
    const sep = platform === 'win32' ? ';' : ':';
    return [...extraPaths, originalPath].join(sep);
}

/**
 * Build the macOS-specific application menu entries.
 * Returns an array of menu items for the app name submenu (About, Quit).
 * Returns empty array on non-darwin platforms.
 */
export function buildAppMenuEntries(platform: Platform, appName: string): Array<{ label: string; submenu: Array<{ role?: string; type?: string }> }> {
    if (platform === 'darwin') {
        return [{
            label: appName,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }];
    }
    return [];
}
