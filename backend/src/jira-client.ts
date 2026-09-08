/**
 * Jira Cloud REST client (v3).
 *
 * Auth: HTTP Basic with `email:apiToken` (Atlassian Cloud API token). All calls
 * hit `https://<site>.atlassian.net/rest/api/3`. The token is never logged.
 *
 * Notable Cloud specifics handled here:
 *   - Search uses POST /rest/api/3/search/jql (the old /search was removed → 410
 *     on 2025-05-01). It requires an explicit `fields` array and uses cursor
 *     pagination via `nextPageToken` (no startAt/total).
 *   - Rich-text fields (description, comment bodies) are Atlassian Document
 *     Format (ADF), a nested JSON structure. We convert ADF → plain text on read
 *     and wrap plain text → minimal ADF on write.
 *   - 429 responses are retried once, honoring the Retry-After header.
 *   - Attachment downloads are fetched by id and only from the configured host
 *     origin (SSRF guard).
 */
import { createLogger } from './logger.js';
import type { JiraConfig } from './config-store.js';

const logger = createLogger('[Jira]');

/** Max bytes we will buffer for a single attachment download (25 MB). */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Per-request network timeout. */
const REQUEST_TIMEOUT_MS = 30_000;

export class JiraError extends Error {
    constructor(message: string, readonly status?: number, readonly detail?: string) {
        super(message);
        this.name = 'JiraError';
    }
}

export interface JiraComment {
    id: string;
    author: string;
    created: string;
    body: string; // plain text (converted from ADF)
}

export interface JiraAttachmentMeta {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    created: string;
}

export interface JiraIssue {
    key: string;
    summary: string;
    status: string;
    issueType: string;
    assignee: string | null;
    reporter: string | null;
    priority: string | null;
    labels: string[];
    created: string;
    updated: string;
    description: string; // plain text (converted from ADF)
    comments: JiraComment[];
    attachments: JiraAttachmentMeta[];
    url: string; // browser-facing /browse/KEY URL
}

export interface JiraSearchResult {
    issues: Array<Pick<JiraIssue, 'key' | 'summary' | 'status' | 'issueType' | 'assignee' | 'updated' | 'url'>>;
    nextPageToken: string | null;
}

const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/** Validate & normalize an issue key, or throw. Accepts a raw key or a /browse/KEY URL. */
export function parseIssueKey(input: string): string {
    let key = (input || '').trim();
    // Accept a full ticket URL and extract the key from /browse/KEY.
    const browseMatch = key.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
    if (browseMatch) key = browseMatch[1];
    key = key.toUpperCase();
    if (!KEY_RE.test(key)) {
        throw new JiraError(`Invalid Jira issue key: "${input}"`);
    }
    return key;
}

/** Flatten an ADF (Atlassian Document Format) node tree to plain text. */
function adfToText(node: unknown): string {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(adfToText).join('');

    const n = node as { type?: string; text?: string; content?: unknown };
    if (n.type === 'text' && typeof n.text === 'string') return n.text;

    const inner = n.content ? adfToText(n.content) : '';
    // Block-level nodes get a trailing newline so paragraphs/list items separate.
    switch (n.type) {
        case 'paragraph':
        case 'heading':
        case 'listItem':
        case 'blockquote':
        case 'codeBlock':
            return inner + '\n';
        case 'hardBreak':
            return '\n';
        case 'rule':
            return '\n---\n';
        default:
            return inner;
    }
}

/** Wrap a plain-text string into a minimal ADF document (for comment writes). */
export function textToAdf(text: string): unknown {
    const paragraphs = (text || '').split('\n').map((line) => ({
        type: 'paragraph',
        content: line.length > 0 ? [{ type: 'text', text: line }] : [],
    }));
    return { type: 'doc', version: 1, content: paragraphs };
}

export class JiraClient {
    private readonly baseUrl: string;
    private readonly authHeader: string;
    /** Origin of the configured base URL, used for the attachment SSRF check. */
    readonly origin: string;

    constructor(config: JiraConfig) {
        if (!config.baseUrl || !config.email || !config.apiToken) {
            throw new JiraError('Jira is not fully configured (baseUrl, email, apiToken required).');
        }
        this.baseUrl = config.baseUrl.replace(/\/$/, '');
        this.origin = new URL(this.baseUrl).origin;
        const creds = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
        this.authHeader = `Basic ${creds}`;
    }

    private browseUrl(key: string): string {
        return `${this.baseUrl}/browse/${key}`;
    }

    /** Core fetch wrapper: injects auth, timeout, and a single 429 retry. */
    private async request(path: string, init: RequestInit = {}, isRetry = false): Promise<Response> {
        const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res: Response;
        try {
            res = await fetch(url, {
                ...init,
                signal: controller.signal,
                headers: {
                    Authorization: this.authHeader,
                    Accept: 'application/json',
                    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                    ...init.headers,
                },
            });
        } catch (err) {
            clearTimeout(timer);
            if ((err as Error).name === 'AbortError') {
                throw new JiraError('Jira request timed out. Are you connected to the VPN?');
            }
            // Network-level failure — most commonly off-VPN / IP-allowlist block.
            throw new JiraError(
                `Could not reach Jira at ${this.origin}. Are you connected to the corporate VPN?`,
            );
        }
        clearTimeout(timer);

        // Honor Retry-After on 429 with a single retry.
        if (res.status === 429 && !isRetry) {
            const retryAfter = parseInt(res.headers.get('retry-after') || '1', 10);
            const delayMs = Math.min(Math.max(retryAfter, 1), 30) * 1000;
            logger.warn('Rate limited by Jira, backing off', { delayMs, path: this.redactPath(path) });
            await new Promise((r) => setTimeout(r, delayMs));
            return this.request(path, init, true);
        }

        return res;
    }

    /** Strip query strings from a path before logging (defense in depth). */
    private redactPath(path: string): string {
        return path.split('?')[0];
    }

    private async parseError(res: Response): Promise<never> {
        let detail = '';
        try {
            const data = await res.json();
            detail = Array.isArray(data.errorMessages) && data.errorMessages.length
                ? data.errorMessages.join('; ')
                : JSON.stringify(data.errors || data);
        } catch {
            detail = res.statusText;
        }
        if (res.status === 401 || res.status === 403) {
            throw new JiraError(
                'Jira authentication failed. Check your email + API token (use a classic/unscoped token).',
                res.status,
                detail,
            );
        }
        if (res.status === 404) {
            throw new JiraError('Jira resource not found (or you lack permission to view it).', 404, detail);
        }
        throw new JiraError(`Jira request failed (HTTP ${res.status})`, res.status, detail);
    }

    /** GET /myself — used to validate credentials. Returns the account display name. */
    async testConnection(): Promise<{ displayName: string; accountId: string; email: string | null }> {
        const res = await this.request('/rest/api/3/myself');
        if (!res.ok) await this.parseError(res);
        const data = await res.json();
        return {
            displayName: data.displayName || data.name || 'Unknown',
            accountId: data.accountId || '',
            email: data.emailAddress || null,
        };
    }

    /** Fetch a single issue with description, comments, and attachment metadata. */
    async getIssue(rawKey: string): Promise<JiraIssue> {
        const key = parseIssueKey(rawKey);
        const fields = [
            'summary', 'status', 'issuetype', 'assignee', 'reporter',
            'priority', 'labels', 'created', 'updated', 'description',
            'comment', 'attachment',
        ].join(',');
        const res = await this.request(
            `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields)}`,
        );
        if (!res.ok) await this.parseError(res);
        const data = await res.json();
        const f = data.fields || {};

        const comments: JiraComment[] = (f.comment?.comments || []).map((c: any) => ({
            id: String(c.id),
            author: c.author?.displayName || 'Unknown',
            created: c.created,
            body: adfToText(c.body).trim(),
        }));

        const attachments: JiraAttachmentMeta[] = (f.attachment || []).map((a: any) => ({
            id: String(a.id),
            filename: a.filename,
            mimeType: a.mimeType || 'application/octet-stream',
            size: a.size || 0,
            created: a.created,
        }));

        return {
            key,
            summary: f.summary || '',
            status: f.status?.name || 'Unknown',
            issueType: f.issuetype?.name || 'Unknown',
            assignee: f.assignee?.displayName || null,
            reporter: f.reporter?.displayName || null,
            priority: f.priority?.name || null,
            labels: f.labels || [],
            created: f.created || '',
            updated: f.updated || '',
            description: adfToText(f.description).trim(),
            comments,
            attachments,
            url: this.browseUrl(key),
        };
    }

    /** Search issues via POST /rest/api/3/search/jql (explicit fields + cursor pagination). */
    async search(jql: string, opts: { maxResults?: number; nextPageToken?: string } = {}): Promise<JiraSearchResult> {
        if (!jql || jql.length > 5000) {
            throw new JiraError('JQL query is required and must be under 5000 chars.');
        }
        const body: Record<string, unknown> = {
            jql,
            maxResults: Math.min(Math.max(opts.maxResults ?? 25, 1), 100),
            fields: ['summary', 'status', 'issuetype', 'assignee', 'updated'],
        };
        if (opts.nextPageToken) body.nextPageToken = opts.nextPageToken;

        const res = await this.request('/rest/api/3/search/jql', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        if (!res.ok) await this.parseError(res);
        const data = await res.json();

        const issues = (data.issues || []).map((i: any) => ({
            key: i.key,
            summary: i.fields?.summary || '',
            status: i.fields?.status?.name || 'Unknown',
            issueType: i.fields?.issuetype?.name || 'Unknown',
            assignee: i.fields?.assignee?.displayName || null,
            updated: i.fields?.updated || '',
            url: this.browseUrl(i.key),
        }));

        return { issues, nextPageToken: data.nextPageToken || null };
    }

    /** List attachment metadata for an issue. */
    async listAttachments(rawKey: string): Promise<JiraAttachmentMeta[]> {
        const issue = await this.getIssue(rawKey);
        return issue.attachments;
    }

    /**
     * Download an attachment by id. Resolves the content URL from attachment
     * metadata server-side, then only fetches it if the origin matches the
     * configured Jira host (SSRF guard). Buffers up to MAX_ATTACHMENT_BYTES.
     */
    async downloadAttachment(attachmentId: string): Promise<{ filename: string; mimeType: string; data: Buffer }> {
        if (!/^\d+$/.test(attachmentId)) {
            throw new JiraError(`Invalid attachment id: "${attachmentId}"`);
        }
        const metaRes = await this.request(`/rest/api/3/attachment/${attachmentId}`);
        if (!metaRes.ok) await this.parseError(metaRes);
        const meta = await metaRes.json();
        const contentUrl: string = meta.content;
        if (!contentUrl) throw new JiraError('Attachment has no content URL.');

        // SSRF guard: the content URL must live on the configured Jira origin.
        const contentOrigin = new URL(contentUrl).origin;
        if (contentOrigin !== this.origin) {
            throw new JiraError(
                `Refusing to download attachment from unexpected origin (${contentOrigin}).`,
            );
        }

        const res = await this.request(contentUrl, { headers: { Accept: '*/*' } });
        if (!res.ok) await this.parseError(res);

        // Enforce size cap from Content-Length if present.
        const declared = parseInt(res.headers.get('content-length') || '0', 10);
        if (declared && declared > MAX_ATTACHMENT_BYTES) {
            throw new JiraError(`Attachment too large (${declared} bytes, max ${MAX_ATTACHMENT_BYTES}).`);
        }
        const arrayBuf = await res.arrayBuffer();
        if (arrayBuf.byteLength > MAX_ATTACHMENT_BYTES) {
            throw new JiraError(`Attachment too large (${arrayBuf.byteLength} bytes, max ${MAX_ATTACHMENT_BYTES}).`);
        }

        return {
            filename: meta.filename || `attachment-${attachmentId}`,
            mimeType: meta.mimeType || res.headers.get('content-type') || 'application/octet-stream',
            data: Buffer.from(arrayBuf),
        };
    }

    /** Add a comment (plain text → minimal ADF) to an issue. */
    async addComment(rawKey: string, text: string): Promise<{ id: string }> {
        const key = parseIssueKey(rawKey);
        if (!text || !text.trim()) throw new JiraError('Comment text is required.');
        const res = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
            method: 'POST',
            body: JSON.stringify({ body: textToAdf(text) }),
        });
        if (!res.ok) await this.parseError(res);
        const data = await res.json();
        return { id: String(data.id) };
    }

    /** List the transitions available for an issue in its current state. */
    async getTransitions(rawKey: string): Promise<Array<{ id: string; name: string; to: string }>> {
        const key = parseIssueKey(rawKey);
        const res = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
        if (!res.ok) await this.parseError(res);
        const data = await res.json();
        return (data.transitions || []).map((t: any) => ({
            id: String(t.id),
            name: t.name,
            to: t.to?.name || '',
        }));
    }

    /** Apply a transition to an issue. */
    async transition(rawKey: string, transitionId: string): Promise<void> {
        const key = parseIssueKey(rawKey);
        if (!/^\d+$/.test(transitionId)) throw new JiraError(`Invalid transition id: "${transitionId}"`);
        const res = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
            method: 'POST',
            body: JSON.stringify({ transition: { id: transitionId } }),
        });
        if (!res.ok) await this.parseError(res);
    }
}
