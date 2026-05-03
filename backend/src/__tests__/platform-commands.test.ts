import { describe, it, expect } from 'vitest';
import {
    buildFolderPickerCommand,
    buildOpenFolderCommand,
    buildOpenTerminalCommand,
    buildRevealFileCommand,
    buildReferenceFolderPickerCommand,
    buildPathWithExtras,
    buildAppMenuEntries,
} from '../platform-commands.js';

describe('platform-commands', () => {

    describe('buildFolderPickerCommand', () => {
        describe('macOS (darwin)', () => {
            it('should use osascript with AppleScript choose folder', () => {
                const result = buildFolderPickerCommand('darwin');
                expect(result.cmd).toBe('osascript');
                expect(result.args[0]).toBe('-e');
                expect(result.args[1]).toContain('choose folder');
                expect(result.args[1]).toContain('Select a workspace folder');
            });

            it('should include default location when lastBrowsed is provided', () => {
                const result = buildFolderPickerCommand('darwin', '/Users/test/projects');
                expect(result.args[1]).toContain('default location POSIX file');
                expect(result.args[1]).toContain('/Users/test/projects');
            });

            it('should not include default location when lastBrowsed is null', () => {
                const result = buildFolderPickerCommand('darwin', null);
                expect(result.args[1]).not.toContain('default location');
            });

            it('should escape backslashes in lastBrowsed path', () => {
                const result = buildFolderPickerCommand('darwin', '/path\\with\\backslashes');
                expect(result.args[1]).toContain('\\\\');
            });

            it('should escape double quotes in lastBrowsed path', () => {
                const result = buildFolderPickerCommand('darwin', '/path/with"quotes');
                expect(result.args[1]).toContain('\\"');
                expect(result.args[1]).not.toContain('with"quotes');
            });

            it('should use custom prompt when provided', () => {
                const result = buildFolderPickerCommand('darwin', null, 'Pick a directory');
                expect(result.args[1]).toContain('Pick a directory');
            });
        });

        describe('Windows (win32)', () => {
            it('should use powershell with FolderBrowserDialog', () => {
                const result = buildFolderPickerCommand('win32');
                expect(result.cmd).toBe('powershell');
                expect(result.args).toContain('-NoProfile');
                expect(result.args).toContain('-EncodedCommand');
            });

            it('should include encoded command as base64', () => {
                const result = buildFolderPickerCommand('win32');
                const encoded = result.args[result.args.indexOf('-EncodedCommand') + 1];
                const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
                expect(decoded).toContain('System.Windows.Forms');
                expect(decoded).toContain('FolderBrowserDialog');
                expect(decoded).toContain('Select a workspace folder');
            });

            it('should set initial directory when lastBrowsed provided', () => {
                const result = buildFolderPickerCommand('win32', 'C:\\Users\\test');
                const encoded = result.args[result.args.indexOf('-EncodedCommand') + 1];
                const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
                expect(decoded).toContain('SelectedPath');
                expect(decoded).toContain('C:\\Users\\test');
            });

            it('should strip quotes from lastBrowsed to prevent injection', () => {
                const result = buildFolderPickerCommand('win32', 'C:\\path"injected');
                const encoded = result.args[result.args.indexOf('-EncodedCommand') + 1];
                const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
                expect(decoded).not.toContain('"injected');
            });
        });

        describe('Linux', () => {
            it('should use zenity with directory selection', () => {
                const result = buildFolderPickerCommand('linux');
                expect(result.cmd).toBe('zenity');
                expect(result.args).toContain('--file-selection');
                expect(result.args).toContain('--directory');
            });

            it('should include title', () => {
                const result = buildFolderPickerCommand('linux');
                expect(result.args).toContain('--title=Select a workspace folder');
            });

            it('should include filename when lastBrowsed provided', () => {
                const result = buildFolderPickerCommand('linux', '/home/user/projects');
                expect(result.args).toContain('--filename=/home/user/projects/');
            });

            it('should not include filename when lastBrowsed is null', () => {
                const result = buildFolderPickerCommand('linux', null);
                const hasFilename = result.args.some(a => a.startsWith('--filename='));
                expect(hasFilename).toBe(false);
            });
        });
    });

    describe('buildOpenFolderCommand', () => {
        it('should use "open" on macOS', () => {
            const result = buildOpenFolderCommand('darwin', '/Users/test/project');
            expect(result.cmd).toBe('open');
            expect(result.args).toEqual(['/Users/test/project']);
        });

        it('should use "explorer.exe" on Windows', () => {
            const result = buildOpenFolderCommand('win32', 'C:\\Users\\test');
            expect(result.cmd).toBe('explorer.exe');
            expect(result.args).toEqual(['C:\\Users\\test']);
        });

        it('should use "xdg-open" on Linux', () => {
            const result = buildOpenFolderCommand('linux', '/home/user/project');
            expect(result.cmd).toBe('xdg-open');
            expect(result.args).toEqual(['/home/user/project']);
        });

        it('should pass path with spaces correctly on macOS', () => {
            const result = buildOpenFolderCommand('darwin', '/Users/test/my project');
            expect(result.args[0]).toBe('/Users/test/my project');
        });

        it('should pass path with special characters on macOS', () => {
            const result = buildOpenFolderCommand('darwin', "/Users/test/project's folder");
            expect(result.args[0]).toBe("/Users/test/project's folder");
        });
    });

    describe('buildOpenTerminalCommand', () => {
        describe('macOS (darwin)', () => {
            it('should use osascript to control Terminal.app', () => {
                const result = buildOpenTerminalCommand('darwin', '/Users/test/project');
                expect(result.cmd).toBe('osascript');
                expect(result.args.length).toBe(4);
                expect(result.args[0]).toBe('-e');
                expect(result.args[2]).toBe('-e');
            });

            it('should include cd command in AppleScript', () => {
                const result = buildOpenTerminalCommand('darwin', '/Users/test/project');
                expect(result.args[1]).toContain('do script "cd');
                expect(result.args[1]).toContain('/Users/test/project');
            });

            it('should activate Terminal.app', () => {
                const result = buildOpenTerminalCommand('darwin', '/Users/test');
                expect(result.args[3]).toContain('tell application "Terminal" to activate');
            });

            it('should escape backslashes in path', () => {
                const result = buildOpenTerminalCommand('darwin', '/path\\with\\backslash');
                expect(result.args[1]).toContain('\\\\');
            });

            it('should escape double quotes in path', () => {
                const result = buildOpenTerminalCommand('darwin', '/path/with"quote');
                expect(result.args[1]).toContain('\\"');
            });

            it('should handle paths with spaces', () => {
                const result = buildOpenTerminalCommand('darwin', '/Users/test/my project');
                expect(result.args[1]).toContain('/Users/test/my project');
            });
        });

        describe('Windows (win32)', () => {
            it('should use cmd.exe with start', () => {
                const result = buildOpenTerminalCommand('win32', 'C:\\Users\\test');
                expect(result.cmd).toBe('cmd.exe');
                expect(result.args).toEqual(['/C', 'start', 'cmd.exe']);
            });

            it('should set cwd option to workspace path', () => {
                const result = buildOpenTerminalCommand('win32', 'C:\\Users\\test');
                expect(result.options?.cwd).toBe('C:\\Users\\test');
            });
        });

        describe('Linux', () => {
            it('should use x-terminal-emulator', () => {
                const result = buildOpenTerminalCommand('linux', '/home/user/project');
                expect(result.cmd).toBe('x-terminal-emulator');
                expect(result.args).toEqual(['--working-directory=/home/user/project']);
            });
        });
    });

    describe('buildRevealFileCommand', () => {
        describe('macOS (darwin)', () => {
            it('should use "open -R" to reveal in Finder', () => {
                const result = buildRevealFileCommand('darwin', '/Users/test/file.txt');
                expect(result.cmd).toBe('open');
                expect(result.args).toEqual(['-R', '/Users/test/file.txt']);
            });

            it('should handle paths with spaces', () => {
                const result = buildRevealFileCommand('darwin', '/Users/test/my file.txt');
                expect(result.args[1]).toBe('/Users/test/my file.txt');
            });
        });

        describe('Windows (win32)', () => {
            it('should use explorer.exe with /select flag', () => {
                const result = buildRevealFileCommand('win32', 'C:/Users/test/file.txt');
                expect(result.cmd).toBe('explorer.exe');
                expect(result.args[0]).toContain('/select,');
            });

            it('should convert forward slashes to backslashes', () => {
                const result = buildRevealFileCommand('win32', 'C:/Users/test/file.txt');
                expect(result.args[0]).toBe('/select,C:\\Users\\test\\file.txt');
            });

            it('should preserve existing backslashes', () => {
                const result = buildRevealFileCommand('win32', 'C:\\Users\\test\\file.txt');
                expect(result.args[0]).toBe('/select,C:\\Users\\test\\file.txt');
            });
        });

        describe('Linux', () => {
            it('should open parent directory with xdg-open', () => {
                const result = buildRevealFileCommand('linux', '/home/user/project/file.txt');
                expect(result.cmd).toBe('xdg-open');
                expect(result.args).toEqual(['/home/user/project']);
            });

            it('should handle files in root directory', () => {
                const result = buildRevealFileCommand('linux', '/file.txt');
                expect(result.args[0]).toBe('/');
            });
        });
    });

    describe('buildReferenceFolderPickerCommand', () => {
        it('should use osascript on macOS', () => {
            const result = buildReferenceFolderPickerCommand('darwin');
            expect(result.cmd).toBe('osascript');
            expect(result.args[1]).toContain('Select reference folder');
        });

        it('should use powershell on Windows', () => {
            const result = buildReferenceFolderPickerCommand('win32');
            expect(result.cmd).toBe('powershell');
            expect(result.args[1]).toContain('Select reference folder');
        });

        it('should use zenity on Linux', () => {
            const result = buildReferenceFolderPickerCommand('linux');
            expect(result.cmd).toBe('zenity');
            expect(result.args).toContain('--title=Select reference folder');
        });
    });

    describe('buildPathWithExtras', () => {
        describe('macOS/Linux', () => {
            it('should use colon separator', () => {
                const result = buildPathWithExtras('darwin', '/Users/test', '/usr/bin');
                expect(result).toContain(':');
                expect(result).not.toContain(';');
            });

            it('should include .local/bin', () => {
                const result = buildPathWithExtras('darwin', '/Users/test', '/usr/bin');
                expect(result).toContain('/Users/test/.local/bin');
            });

            it('should include .npm-global/bin', () => {
                const result = buildPathWithExtras('darwin', '/Users/test', '/usr/bin');
                expect(result).toContain('/Users/test/.npm-global/bin');
            });

            it('should include /usr/local/bin for Homebrew', () => {
                const result = buildPathWithExtras('darwin', '/Users/test', '/usr/bin');
                expect(result).toContain('/usr/local/bin');
            });

            it('should append original path at the end', () => {
                const result = buildPathWithExtras('darwin', '/Users/test', '/original/path');
                expect(result.endsWith('/original/path')).toBe(true);
            });
        });

        describe('Windows', () => {
            it('should use semicolon separator', () => {
                const result = buildPathWithExtras('win32', 'C:\\Users\\test', 'C:\\Windows');
                expect(result).toContain(';');
            });

            it('should include AppData/Roaming/npm', () => {
                const result = buildPathWithExtras('win32', 'C:\\Users\\test', 'C:\\Windows');
                expect(result).toContain('C:\\Users\\test/AppData/Roaming/npm');
            });

            it('should include .local/bin', () => {
                const result = buildPathWithExtras('win32', 'C:\\Users\\test', 'C:\\Windows');
                expect(result).toContain('C:\\Users\\test/.local/bin');
            });

            it('should not include /usr/local/bin', () => {
                const result = buildPathWithExtras('win32', 'C:\\Users\\test', 'C:\\Windows');
                expect(result).not.toContain('/usr/local/bin');
            });

            it('should append original path at the end', () => {
                const result = buildPathWithExtras('win32', 'C:\\Users\\test', 'C:\\Windows\\system32');
                expect(result.endsWith('C:\\Windows\\system32')).toBe(true);
            });
        });

        it('should handle empty original path', () => {
            const result = buildPathWithExtras('darwin', '/Users/test', '');
            expect(result.endsWith(':')).toBe(true);
        });
    });

    describe('buildAppMenuEntries', () => {
        it('should return app menu on macOS', () => {
            const result = buildAppMenuEntries('darwin', 'Claudia');
            expect(result.length).toBe(1);
            expect(result[0].label).toBe('Claudia');
            expect(result[0].submenu).toHaveLength(3);
        });

        it('should include about and quit roles on macOS', () => {
            const result = buildAppMenuEntries('darwin', 'MyApp');
            const roles = result[0].submenu.map(item => item.role).filter(Boolean);
            expect(roles).toContain('about');
            expect(roles).toContain('quit');
        });

        it('should include separator between about and quit', () => {
            const result = buildAppMenuEntries('darwin', 'MyApp');
            const types = result[0].submenu.map(item => item.type).filter(Boolean);
            expect(types).toContain('separator');
        });

        it('should return empty array on Windows', () => {
            const result = buildAppMenuEntries('win32', 'Claudia');
            expect(result).toEqual([]);
        });

        it('should return empty array on Linux', () => {
            const result = buildAppMenuEntries('linux', 'Claudia');
            expect(result).toEqual([]);
        });
    });

    describe('security: path injection prevention', () => {
        it('should escape quotes so AppleScript treats them as literals, not delimiters', () => {
            const malicious = '/Users/test"; do shell script "rm -rf /"';
            const result = buildOpenTerminalCommand('darwin', malicious);
            // All double quotes in the path must be escaped with backslash
            // so AppleScript interprets them as literal chars inside the string
            expect(result.args[1]).toContain('\\"');
            // The raw unescaped quote should not appear adjacent to the cd wrapper quotes
            expect(result.args[1]).not.toContain('cd \\"/Users/test"');
        });

        it('should not allow path traversal in folder picker on Windows', () => {
            const malicious = 'C:\\Users\\test"; Remove-Item -Recurse -Force C:\\';
            const result = buildFolderPickerCommand('win32', malicious);
            const encoded = result.args[result.args.indexOf('-EncodedCommand') + 1];
            const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
            // Double quotes are stripped from lastBrowsed on Windows
            expect(decoded).not.toContain('"; Remove-Item');
        });

        it('should handle null bytes in paths', () => {
            const withNull = '/Users/test/\x00malicious';
            const result = buildOpenFolderCommand('darwin', withNull);
            expect(result.args[0]).toBe(withNull);
            // execFile with args array prevents null byte injection at OS level
        });
    });
});
