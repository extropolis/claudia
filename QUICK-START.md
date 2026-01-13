# Quick Start Guide

## For Users

### Start Everything
```bash
./start.sh
```

That's it! Both backend and frontend will run with auto-reload enabled.

- **Backend:** http://localhost:3001 (auto-reloads on changes)
- **Frontend:** http://localhost:5173 (auto-reloads on changes)

### Multiple Claude Instances?
✅ **Yes!** Multiple Claude Code instances can work simultaneously without interfering.

## For Claude Code Instances

### The Rules
```
1. Write code → Save → Wait 2 seconds → Test
2. Backend auto-reloads (tsx watch)
3. Frontend auto-reloads (Vite HMR)
4. DO NOT restart anything manually
5. Use CLI for testing: npx tsx test-cli.ts
```

### Read These Files
- **[CLAUDE.md](./CLAUDE.md)** - Project guidelines
- **[MULTI-INSTANCE-GUIDE.md](./MULTI-INSTANCE-GUIDE.md)** - Detailed multi-instance info
- **[backend/TEST-CLI-README.md](./backend/TEST-CLI-README.md)** - CLI testing guide

### Quick Testing
```bash
# Test anything
cd backend
npx tsx test-cli.ts --help

# Common tests
npx tsx test-cli.ts --list-tasks
npx tsx test-cli.ts --get-config
npx tsx test-cli.ts -m "your message here"
```

### Auto-Reload Verification
```bash
# Verify auto-reload is working
cd backend
./test-auto-reload.sh
```

## Project Structure

```
codeui/
├── start.sh              # Start script (run once)
├── CLAUDE.md             # Guidelines for Claude instances
├── MULTI-INSTANCE-GUIDE.md  # Multi-instance documentation
├── backend/
│   ├── src/              # Backend source (auto-reloads)
│   ├── test-cli.ts       # CLI testing tool
│   └── package.json      # "dev": "tsx watch src/index.ts"
└── frontend/
    ├── src/              # Frontend source (auto-reloads)
    └── package.json      # "dev": "vite" (HMR enabled)
```

## Key Technologies

- **Backend Auto-Reload:** tsx watch (1-2 second reload)
- **Frontend Auto-Reload:** Vite HMR (instant updates)
- **Testing:** CLI-based (test-cli.ts)
- **Multi-Instance:** Fully supported ✅

## Common Commands

```bash
# Start everything (run once)
./start.sh

# Test something
cd backend && npx tsx test-cli.ts --list-tasks

# View CLI help
cd backend && npx tsx test-cli.ts --help

# Check if backend is running
lsof -ti:3001

# Check if frontend is running
lsof -ti:5173
```

## Troubleshooting

### Backend not auto-reloading?
```bash
# Restart everything
./start.sh
```

### Port already in use?
```bash
# start.sh kills existing processes automatically
./start.sh
```

### Changes not taking effect?
```bash
# Wait 2 seconds after saving for auto-reload
sleep 2
```

## Links

- Backend: http://localhost:3001
- Frontend: http://localhost:5173
- WebSocket: ws://localhost:3001

## Support

Check these files for detailed documentation:
- Multi-instance development: [MULTI-INSTANCE-GUIDE.md](./MULTI-INSTANCE-GUIDE.md)
- CLI testing: [backend/TEST-CLI-README.md](./backend/TEST-CLI-README.md)
- Project guidelines: [CLAUDE.md](./CLAUDE.md)
