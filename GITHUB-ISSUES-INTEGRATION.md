# GitHub Issues Integration for Claudia

## Overview

I've successfully integrated GitHub Issues directly into Claudia as a new tab in the side panel! This allows you to view, filter, and access your repository's GitHub issues without leaving the Claudia interface.

## Features Implemented

### 1. Backend API Endpoint (`/api/workspaces/github-issues`)

**Location:** `src/server.ts` (lines ~1980-2093)

**Features:**
- Fetches issues from GitHub using the `gh` CLI
- Supports filtering by state: `open`, `closed`, or `all`
- Configurable limit (default: 30 issues)
- Returns rich issue data including:
  - Issue number, title, state
  - Author and assignees
  - Labels with colors
  - Comment count
  - Created/updated/closed timestamps
  - Direct URL to GitHub

**Error Handling:**
- Detects if workspace is a git repository
- Checks if remote is a GitHub repository
- Validates `gh` CLI installation
- Handles authentication errors with helpful messages
- Repository not found/access errors

### 2. Frontend Issues Tab

**Location:** `frontend/src/components/FileExplorer.tsx`

**UI Components:**
- New "Issues" tab alongside Files, Changes, and CI/CD tabs
- Filter buttons for Open/Closed/All states
- Refresh button with auto-refresh every 2 minutes
- Rich issue cards displaying:
  - State badge (green circle for open, purple checkmark for closed)
  - Issue number and title
  - Author, assignees, and comment count
  - Color-coded labels (up to 3 shown, with overflow indicator)
  - "Time ago" formatting for updates
  - External link icon on hover
  - Clickable to open in GitHub

**Styling:** `frontend/src/components/FileExplorer.css`
- Consistent with existing Claudia design language
- Dark theme with color-coded states
- Hover effects and smooth transitions
- Responsive layout

### 3. Type Definitions

Added comprehensive TypeScript interfaces:
```typescript
interface GitHubLabel {
    name: string;
    color: string;
}

interface GitHubUser {
    login: string;
}

interface GitHubIssue {
    number: number;
    title: string;
    state: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    author: GitHubUser;
    assignees: GitHubUser[];
    labels: GitHubLabel[];
    comments: number;
    body: string;
}

interface GitHubIssuesStatus {
    isGitRepo: boolean;
    owner?: string;
    repo?: string;
    issues: GitHubIssue[];
    error?: string;
}
```

### 4. Test Script

**Location:** `test-github-issues.ts`

A standalone test script to verify the GitHub Issues endpoint:

```bash
# Test with current directory (open issues)
npx tsx test-github-issues.ts . open

# Test with specific path (closed issues)
npx tsx test-github-issues.ts /path/to/repo closed

# Test all issues
npx tsx test-github-issues.ts . all
```

Features:
- Color-coded emoji output
- Detailed issue information display
- Error handling with helpful suggestions
- Pretty-printed JSON responses

## Usage

### Prerequisites

1. **GitHub CLI (`gh`)** must be installed:
   ```bash
   # macOS
   brew install gh

   # Windows
   winget install GitHub.cli

   # Linux
   # See https://cli.github.com for instructions
   ```

2. **Authenticate with GitHub:**
   ```bash
   gh auth login
   ```

### Using the Issues Tab

1. Open Claudia and select a workspace with a GitHub repository
2. Click the file explorer toggle button on the right side
3. Click the "Issues" tab (fourth tab with a pull request icon)
4. Use the filter buttons to switch between Open/Closed/All issues
5. Click on any issue to open it in your browser
6. The list auto-refreshes every 2 minutes

### Error Messages

The UI provides helpful error messages:

- **"Not a git repository"** - The workspace is not initialized with git
- **"No remote origin"** - No git remote configured
- **"Not a GitHub repository"** - Remote is not GitHub
- **"gh CLI not installed"** - Includes installation link
- **"GitHub authentication required. Run: gh auth login"** - Auth needed
- **"Repository not found or no access"** - Private repo or no permissions

## Technical Details

### API Endpoint

**GET** `/api/workspaces/github-issues`

**Query Parameters:**
- `workspace` (required): Absolute path to the workspace
- `state` (optional): `open` | `closed` | `all` (default: `open`)
- `limit` (optional): Number of issues to fetch (default: 30)

**Response:**
```json
{
  "isGitRepo": true,
  "owner": "username",
  "repo": "repository-name",
  "issues": [
    {
      "number": 123,
      "title": "Issue title",
      "state": "OPEN",
      "url": "https://github.com/...",
      "createdAt": "2024-03-07T...",
      "updatedAt": "2024-03-07T...",
      "closedAt": null,
      "author": { "login": "username" },
      "assignees": [...],
      "labels": [...],
      "comments": 5,
      "body": "Issue description"
    }
  ]
}
```

### Performance

- Lazy loading: Issues are only fetched when the tab is active
- Caching: Results are cached until manual refresh or 2-minute auto-refresh
- Efficient: Uses `gh` CLI which caches GitHub API responses

### Cross-Platform Support

- Works on macOS, Linux, and Windows
- Requires `gh` CLI to be in PATH
- Uses standard Git commands for repository detection

## Testing

### Manual Testing

1. Open Claudia and navigate to a GitHub repository workspace
2. Expand the file explorer panel (right side)
3. Click the "Issues" tab
4. Verify issues are displayed correctly
5. Test filtering (Open/Closed/All buttons)
6. Click an issue to verify it opens in browser
7. Test with non-Git workspace - should show appropriate error
8. Test with non-GitHub repository - should show appropriate error

### Automated Testing

Run the test script:

```bash
# Ensure the backend server is running first
./start.sh  # or start.ps1 on Windows

# In another terminal, run the test
npx tsx test-github-issues.ts . open
```

Expected output:
- Repository owner/name
- List of issues with details
- Color-coded states and metadata

## Files Changed

1. **Backend:**
   - `src/server.ts` - Added `/api/workspaces/github-issues` endpoint

2. **Frontend:**
   - `frontend/src/components/FileExplorer.tsx` - Added Issues tab and component
   - `frontend/src/components/FileExplorer.css` - Added styling for issues

3. **Testing:**
   - `test-github-issues.ts` - New test script (can be deleted after testing)

## Future Enhancements

Possible improvements:
1. **Create/Edit Issues** - Allow creating new issues from Claudia
2. **Issue Comments** - View and add comments inline
3. **Assignee Management** - Assign/unassign users to issues
4. **Label Management** - Add/remove labels
5. **Milestone Tracking** - Filter by milestones
6. **Search/Filter** - Advanced filtering by labels, assignees, etc.
7. **Issue Templates** - Quick issue creation with templates
8. **Pull Request Integration** - Show linked PRs
9. **Notifications** - Desktop notifications for issue updates
10. **Offline Mode** - Cache issues for offline viewing

## Notes

- The backend automatically reloads when `src/server.ts` changes (via `tsx watch`)
- No server restart is needed for this change to take effect
- The feature gracefully degrades if `gh` CLI is not installed
- All error messages guide users toward resolution
- The UI matches Claudia's existing design patterns

## Architecture Notes

This implementation follows Claudia's established patterns:
- Similar to the CI/CD tab (uses `gh` CLI)
- Consistent error handling
- Lazy loading with cache management
- Auto-refresh on active tabs
- Responsive state management with React hooks
- Type-safe with comprehensive TypeScript interfaces

The feature integrates seamlessly with the existing side panel architecture and requires no changes to other parts of the codebase.
