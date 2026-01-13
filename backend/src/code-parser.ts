import { CodeFile, FileOperation } from '@claudia/shared';

/**
 * Parse terminal output to extract code files that Claude has created or modified
 */
export function parseCodeFromOutput(output: string[]): CodeFile[] {
    const files: CodeFile[] = [];
    const fullOutput = output.join('\n');

    // Pattern 1: Explicit file markers from Claude like "Creating file: filename.ext" or "Writing to: filename.ext"
    const fileMarkerRegex = /(Creating|Writing to|Modifying|Updating)\s+(file:\s*)?([^\n]+\.[a-zA-Z0-9]+)/gi;

    // Pattern 2: Code blocks with filename in the info string: ```language:filename or ```filename.ext
    const codeBlockRegex = /```(\w+)?(?::([^\n]+))?\n([\s\S]*?)```/g;

    // Pattern 3: File paths followed by code blocks
    const filePathBeforeCodeRegex = /(?:^|\n)([^\n]+\.[a-zA-Z0-9]+):\s*\n```(\w+)?\n([\s\S]*?)```/g;

    // Extract using pattern 3 - file paths before code blocks
    let match: RegExpExecArray | null;
    while ((match = filePathBeforeCodeRegex.exec(fullOutput)) !== null) {
        const filename = match[1].trim();
        const language = match[2] || detectLanguage(filename);
        const content = match[3].trim();

        if (content && filename) {
            files.push({
                filename: cleanFilename(filename),
                language,
                content,
                operation: 'created'
            });
        }
    }

    // Extract standalone code blocks if we haven't found any files yet
    if (files.length === 0) {
        while ((match = codeBlockRegex.exec(fullOutput)) !== null) {
            const langOrFilename = match[1] || '';
            const explicitFilename = match[2];
            const content = match[3].trim();

            if (!content) continue;

            let filename = explicitFilename || '';
            let language = langOrFilename;

            // If langOrFilename looks like a filename
            if (langOrFilename.includes('.')) {
                filename = langOrFilename;
                language = detectLanguage(filename);
            }

            // Generate filename if missing
            if (!filename) {
                filename = generateFilename(language, files.length);
            }

            files.push({
                filename: cleanFilename(filename),
                language: language || 'text',
                content,
                operation: 'created'
            });
        }
    }

    // Try to detect operation type from context
    for (const file of files) {
        file.operation = detectOperation(fullOutput, file.filename);
    }

    return files;
}

/**
 * Detect programming language from file extension
 */
function detectLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
        'js': 'javascript',
        'jsx': 'javascript',
        'ts': 'typescript',
        'tsx': 'typescript',
        'py': 'python',
        'rb': 'ruby',
        'go': 'go',
        'rs': 'rust',
        'java': 'java',
        'c': 'c',
        'cpp': 'cpp',
        'cc': 'cpp',
        'h': 'c',
        'hpp': 'cpp',
        'cs': 'csharp',
        'php': 'php',
        'swift': 'swift',
        'kt': 'kotlin',
        'scala': 'scala',
        'sh': 'bash',
        'bash': 'bash',
        'zsh': 'bash',
        'html': 'html',
        'htm': 'html',
        'css': 'css',
        'scss': 'scss',
        'sass': 'sass',
        'less': 'less',
        'json': 'json',
        'yaml': 'yaml',
        'yml': 'yaml',
        'xml': 'xml',
        'md': 'markdown',
        'sql': 'sql',
        'graphql': 'graphql',
        'gql': 'graphql',
        'dockerfile': 'dockerfile',
        'makefile': 'makefile',
        'toml': 'toml',
        'ini': 'ini',
        'cfg': 'ini',
        'env': 'bash',
    };
    return langMap[ext] || ext || 'text';
}

/**
 * Generate a filename when none is provided
 */
function generateFilename(language: string, index: number): string {
    const extMap: Record<string, string> = {
        'javascript': 'js',
        'typescript': 'ts',
        'python': 'py',
        'ruby': 'rb',
        'bash': 'sh',
        'markdown': 'md',
    };
    const ext = extMap[language] || language || 'txt';
    return index === 0 ? `code.${ext}` : `code_${index + 1}.${ext}`;
}

/**
 * Clean up filename by removing common prefixes and artifacts
 */
function cleanFilename(filename: string): string {
    return filename
        .replace(/^(file:\s*|path:\s*)/i, '')
        .replace(/^[`'"]+|[`'"]+$/g, '')
        .replace(/^\.\//g, '')
        .trim();
}

/**
 * Detect file operation from output context
 */
function detectOperation(output: string, filename: string): FileOperation {
    const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (new RegExp(`(delet|remov).*${escapedFilename}`, 'i').test(output)) {
        return 'deleted';
    }
    if (new RegExp(`(modif|updat|edit|chang).*${escapedFilename}`, 'i').test(output)) {
        return 'modified';
    }
    return 'created';
}
