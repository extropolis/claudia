# Multi-Instance Development Guide

This project is designed to support **multiple Claude Code instances working simultaneously** without interference. Here's how it works and best practices.

## 🚀 Quick Start

### For Claude Code Instances

**TL;DR:** Just write code and test. The backend auto-reloads. Don't restart anything.

### For Users

Run once:
```bash
./start.sh
```

That's it! Backend and frontend will auto-reload as Claude instances make changes.

## 🔄 Auto-Reload Configuration

### Backend (Port 3001)
- **Technology:** `tsx watch`
- **Watches:** All `.ts` files in `backend/src/`
- **Reload time:** 1-2 seconds after file save
- **Status:** ✅ Already configured

### Frontend (Port 5173)
- **Technology:** Vite HMR (Hot Module Replacement)
- **Watches:** All files in `frontend/src/`
- **Reload time:** Instant (milliseconds)
- **Status:** ✅ Already configured

## 🤝 How Multiple Instances Work Together

### Concurrent Development Workflow

```
Instance 1 (Task A)          Instance 2 (Task B)          Instance 3 (Task C)
     │                             │                             │
     ├─ Writes feature.ts          │                             │
     │  (auto-reload triggers)     │                             │
     │                             │                             │
     ├─ Tests with CLI ✅          ├─ Writes handler.ts          │
     │                             │  (auto-reload triggers)     │
     │                             │                             │
     │                             ├─ Tests with CLI ✅          ├─ Fixes bug.ts
     │                             │                             │  (auto-reload)
     ├─ Commits code               │                             │
     │                             ├─ Commits code               ├─ Tests ✅
     │                             │                             │
     └─ Done                       └─ Done                       └─ Done
```

**No coordination needed!** Each instance:
1. Writes code
2. Waits 2 seconds for auto-reload
3. Tests immediately
4. Commits and moves on

## 📋 Best Practices for Claude Instances

### ✅ DO

1. **Write and test immediately**
   ```bash
   # Edit file
   vim backend/src/feature.ts

   # Wait 2 seconds for reload (automatic)

   # Test immediately
   npx tsx test-cli.ts --test-feature
   ```

2. **Use the CLI for testing**
   - Faster than UI
   - Scriptable
   - Parallel-safe

3. **Focus on your task**
   - Don't worry about other instances
   - Backend handles concurrent changes
   - Git handles merge conflicts

4. **Add logging**
   ```typescript
   console.log('[Feature] Starting...');
   // Makes debugging easier for all instances
   ```

5. **Commit frequently**
   - Helps other instances stay synced
   - Smaller, safer changes

### ❌ DON'T

1. **Never restart the backend manually**
   ```bash
   # ❌ BAD
   pkill -f tsx
   npm run dev

   # ✅ GOOD
   # Just save your file, it auto-reloads
   ```

2. **Don't pause for "coordination"**
   ```bash
   # ❌ BAD
   "Let me wait for the other instance to finish..."

   # ✅ GOOD
   "I'll work on my task now"
   ```

3. **Don't worry about conflicts**
   - Git handles code conflicts
   - Backend handles concurrent requests
   - Just keep working!

4. **Don't check if backend is "ready"**
   ```bash
   # ❌ BAD
   while ! curl localhost:3001; do sleep 1; done

   # ✅ GOOD
   # It's always ready (auto-reload is fast)
   npx tsx test-cli.ts --my-test
   ```

## 🧪 Testing Multi-Instance Safety

### Test Auto-Reload

```bash
# Run this to verify auto-reload is working
./backend/test-auto-reload.sh
```

Expected output:
```
✅ Backend is running on port 3001
🎯 Verified Configuration:
   - Backend: tsx watch src/index.ts ✅
   - Auto-reload: ON ✅
   - Multi-instance safe: YES ✅
```

### Simulate Multiple Instances

```bash
# Terminal 1: Instance 1 working on feature A
npx tsx test-cli.ts --task -m "implement feature A" -n "Feature A" &

# Terminal 2: Instance 2 working on feature B
npx tsx test-cli.ts --task -m "implement feature B" -n "Feature B" &

# Terminal 3: Instance 3 testing
npx tsx test-cli.ts --list-tasks

# All work simultaneously without issues!
```

## 🔧 Technical Details

### How tsx watch Works

```bash
# Command (from package.json)
tsx watch src/index.ts

# What it does:
1. Watches all imported files
2. Detects changes via filesystem events
3. Kills current process
4. Restarts with new code
5. Takes ~1-2 seconds total
```

### Why It's Safe

1. **WebSocket reconnection**: Frontend automatically reconnects if backend restarts
2. **In-flight requests**: Fail gracefully, retry logic built-in
3. **State persistence**: Tasks/workspaces stored in memory, cleared on restart (intentional)
4. **File system**: OS handles concurrent writes (atomic operations)

### Reload Triggers

Backend reloads when ANY of these change:
- `backend/src/**/*.ts` - All TypeScript source files
- `backend/src/**/*.js` - Any JS files (if mixed)
- Imported modules from `node_modules` (if changed)

Backend does NOT reload for:
- `backend/test-cli.ts` - CLI tests
- `backend/dist/` - Compiled output
- `frontend/` - Frontend files
- `.md` files - Documentation
- `node_modules/` - Dependencies (unless imported file changes)

## 🐛 Troubleshooting

### Backend not auto-reloading?

```bash
# 1. Check if tsx watch is running
ps aux | grep "tsx watch"

# 2. Check if backend is running
lsof -ti:3001

# 3. Restart everything
./start.sh
```

### Changes not taking effect?

```bash
# Wait 2 seconds after saving
sleep 2

# Then test
npx tsx test-cli.ts --my-test
```

### Multiple instances seeing stale data?

This is normal and expected:
- Each instance has its own state
- Backend state is cleared on reload
- Use CLI `--list-tasks` to see current state

### Port conflicts?

```bash
# Clean restart (kills all processes)
./start.sh
```

## 📊 Performance

### Auto-Reload Speed

| Operation | Time | Impact |
|-----------|------|--------|
| File save | 0ms | Instant |
| tsx detects change | 50-100ms | Negligible |
| Kill + restart | 500-1000ms | Brief |
| Service ready | 200-500ms | Quick |
| **Total** | **~1-2s** | **Fast enough** |

### Concurrent Load

The backend can handle:
- Multiple WebSocket connections (one per instance)
- Concurrent CLI tests
- Parallel task execution
- Simultaneous file changes

Tested with **3 instances**, no issues.

## 🎯 Example Workflows

### Scenario 1: Three Instances, Three Tasks

**Instance 1:** Implementing authentication
```bash
# Writes: backend/src/auth-service.ts
# Tests: npx tsx test-cli.ts -m "test login"
# Time: 5 minutes
```

**Instance 2:** Adding new API endpoint
```bash
# Writes: backend/src/api/users.ts
# Tests: npx tsx test-cli.ts --get-config
# Time: 3 minutes
```

**Instance 3:** Fixing bug in task manager
```bash
# Writes: backend/src/task-manager.ts
# Tests: npx tsx test-cli.ts --list-tasks
# Time: 2 minutes
```

**Result:** All three work simultaneously, no conflicts, all changes tested.

### Scenario 2: One Instance, Multiple Features

**Single Instance:** Working through task list
```bash
# 1. Implement feature A
vim backend/src/feature-a.ts
sleep 2
npx tsx test-cli.ts --test-a

# 2. Implement feature B
vim backend/src/feature-b.ts
sleep 2
npx tsx test-cli.ts --test-b

# 3. Implement feature C
vim backend/src/feature-c.ts
sleep 2
npx tsx test-cli.ts --test-c
```

**Result:** Smooth workflow, no manual restarts needed.

## 🎉 Summary

### Key Takeaways

✅ **Backend auto-reloads** - tsx watch handles it
✅ **Frontend auto-reloads** - Vite HMR handles it
✅ **No manual restarts** - Ever!
✅ **Multiple instances safe** - Designed for it
✅ **Test immediately** - 2-second reload
✅ **CLI is your friend** - Fast, scriptable, safe

### For Claude Instances

```
RULES:
1. Write code
2. Wait 2 seconds
3. Test with CLI
4. Commit
5. Repeat

NEVER:
- Restart backend manually
- Ask user to restart
- Wait for "coordination"
- Worry about other instances
```

### For Users

```bash
# Start once
./start.sh

# Let Claude instances work
# (They'll test and commit automatically)

# Check progress occasionally
npx tsx test-cli.ts --list-tasks
```

**That's it!** The system handles everything else.

---

**Last Updated:** 2026-01-13
**Status:** Production Ready ✅
**Tested With:** 3 concurrent instances ✅
