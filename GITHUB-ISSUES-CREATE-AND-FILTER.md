# GitHub Issues - Create & Filter Features

## New Features Added

### 1. ✅ Create Issues Directly in Claudia

**Location:** Bottom of the Issues tab

**How to use:**
1. Open the Issues tab in the file explorer panel
2. Type your issue title in the input box at the bottom
3. Press **Enter** to create the issue
4. The issue will be created on GitHub and the list will automatically refresh

**Features:**
- Simple text input at the bottom of the issues list
- Press Enter to create
- Loading spinner while creating
- Auto-refresh after creation to show the new issue
- Error handling with user-friendly messages

**Backend Endpoint:**
```
POST /api/workspaces/github-issues
Body: { workspace: string, title: string, body?: string }
```

### 2. ✅ Filter "My Issues"

**Location:** New filter buttons in the toolbar

**How to use:**
1. Click "Mine" to see only issues assigned to you
2. Click "All" to see all issues in the repository

**Features:**
- Filters issues by assignee using `gh` CLI
- Uses `--assignee @me` to get your issues
- Works alongside the Open/Closed/All state filters
- Auto-refreshes when you toggle between All/Mine

**Backend Support:**
- New `assignee` query parameter
- Supports `@me` for current user
- Can be extended to support specific usernames

### 3. ✅ Combined Filtering

You can now combine filters:
- **All + Open** - All open issues in the repo
- **Mine + Open** - Only your open issues
- **Mine + Closed** - Your closed issues
- **All + Closed** - All closed issues
- etc.

## UI Layout

```
┌─────────────────────────────────────────────┐
│ extropolis/claudia  5 issues                │
│                                             │
│ [All] [Mine]  [Open] [Closed] [All]  🔄   │
├─────────────────────────────────────────────┤
│                                             │
│ 🟢 #15: Screenshot capture support          │
│    👤 kovtcharov  💬 3  📅 2h ago           │
│    🏷️ enhancement                           │
│                                             │
│ 🟢 #14: Electron app not working            │
│    👤 itomek  📅 1d ago                     │
│    🏷️ bug                                   │
│                                             │
├─────────────────────────────────────────────┤
│ Create new issue... (press Enter)  ⏳      │
└─────────────────────────────────────────────┘
```

## Technical Implementation

### Frontend Changes

**FileExplorer.tsx:**
- Added `filterAssignee` state ('all' | 'me')
- Added `newIssueTitle` state for the input
- Added `creating` state for loading indicator
- New `createIssue()` function to POST to backend
- New `handleKeyDown()` to handle Enter key
- Updated UI with assignee filter buttons
- Added create issue form at bottom

**FileExplorer.css:**
- `.issue-create-form` - Container for input
- `.issue-create-input` - Styled text input
- `.issue-create-spinner` - Loading indicator

### Backend Changes

**server.ts:**

**GET `/api/workspaces/github-issues`** - Enhanced with:
- New `assignee` query parameter
- Passes `--assignee @me` to `gh issue list`
- Supports filtering by current user or specific username

**POST `/api/workspaces/github-issues`** - New endpoint:
- Creates issues using `gh issue create`
- Required: `workspace`, `title`
- Optional: `body` (issue description)
- Returns: `{ success: true, issue: { number, url } }`
- Error handling for auth, permissions, etc.

## Testing

### Test Create Issue

1. Open Claudia
2. Go to Issues tab
3. Type "Test issue from Claudia" in the input
4. Press Enter
5. Verify issue appears in the list
6. Check GitHub to confirm it was created

### Test "My Issues" Filter

1. Click "Mine" button
2. Verify only issues assigned to you are shown
3. Click "All" button
4. Verify all issues are shown again

### Test Combined Filters

1. Click "Mine" + "Open"
2. Verify only YOUR open issues are shown
3. Click "Mine" + "Closed"
4. Verify only YOUR closed issues are shown

## Future Enhancements

### Assign Issues Feature

To add the ability to assign issues, we would need:

**Backend:**
```typescript
POST /api/workspaces/github-issues/assign
{
  workspace: string,
  issueNumber: number,
  assignees: string[] // usernames
}
```

Uses: `gh issue edit <number> --add-assignee @me`

**Frontend:**
- Add "Assign to me" button on each issue
- Or dropdown to select assignees
- Update issue in list after assignment

### Other Enhancements

- **Labels**: Add/remove labels from Claudia
- **Comments**: View and add comments inline
- **Templates**: Issue templates for quick creation
- **Bulk actions**: Select multiple issues
- **Search**: Search issues by text
- **Sort**: Sort by date, comments, etc.

## API Examples

### Create an Issue

```bash
curl -X POST http://localhost:4001/api/workspaces/github-issues \
  -H "Content-Type: application/json" \
  -d '{
    "workspace": "/path/to/repo",
    "title": "New feature request",
    "body": "Detailed description here"
  }'
```

### Get My Open Issues

```bash
curl "http://localhost:4001/api/workspaces/github-issues?workspace=/path/to/repo&state=open&assignee=@me"
```

### Get All Closed Issues

```bash
curl "http://localhost:4001/api/workspaces/github-issues?workspace=/path/to/repo&state=closed"
```

## Error Messages

- **"Failed to create issue: authentication required"** → Run `gh auth login`
- **"gh CLI not installed"** → Install from https://cli.github.com
- **"title is required"** → Issue title cannot be empty
- **"Not a git repository"** → Workspace must be a git repo
- **"Not a GitHub repository"** → Remote must be GitHub

## Summary

You can now:
✅ Create issues with a simple text input + Enter
✅ Filter to see only YOUR issues (Mine button)
✅ Combine filters (Mine + Open, Mine + Closed, etc.)
✅ Auto-refresh after creating issues

The Issues tab is now a fully functional issue management interface!
