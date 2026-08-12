import manifest from '../assets/file-icon-manifest.json';

// Material Icon Theme SVGs are served statically from /file-icons/<name>.svg
// (copied from the material-icon-theme npm package into frontend/public/file-icons).
const ICON_BASE = '/file-icons';

type Manifest = {
    fileExtensions: Record<string, string>;
    fileNames: Record<string, string>;
    folderNames: Record<string, string>;
    folderNamesExpanded: Record<string, string>;
    file: string;
    folder: string;
    folderExpanded: string;
};

const m = manifest as Manifest;

function iconUrl(name: string): string {
    return `${ICON_BASE}/${name}.svg`;
}

/** Resolve the icon URL for a file, matching material-icon-theme's own lookup order. */
export function getFileIconUrl(name: string): string {
    const lower = name.toLowerCase();

    if (m.fileNames[lower]) return iconUrl(m.fileNames[lower]);

    // Try compound extensions first (e.g. "d.ts", "test.tsx"), then the final extension.
    const parts = lower.split('.');
    if (parts.length > 1) {
        for (let i = 1; i < parts.length; i++) {
            const ext = parts.slice(i).join('.');
            if (m.fileExtensions[ext]) return iconUrl(m.fileExtensions[ext]);
        }
    }

    return iconUrl(m.file);
}

export function getFolderIconUrl(name: string, expanded: boolean): string {
    const lower = name.toLowerCase();
    const map = expanded ? m.folderNamesExpanded : m.folderNames;
    if (map[lower]) return iconUrl(map[lower]);
    return iconUrl(expanded ? m.folderExpanded : m.folder);
}
