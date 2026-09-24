---
sidebar_position: 2
---

# Startup Guide

Quick solutions for getting the CAIPE UI running when you encounter startup issues.

## Problem: "New Chat Doesn't Work"

**Root Cause**: UI dev server isn't running due to macOS networking error.

---

## ✅ Solution 1: Docker (RECOMMENDED)

```bash
# Start UI with Docker
docker compose -f docker-compose.dev.yaml --profile caipe-ui-dev up -d

# Check logs
docker logs -f caipe-ui-dev

# Access UI
open http://localhost:3000
```

**Advantages**:
- Avoids macOS system errors
- Consistent environment
- Already configured with MongoDB

---

## ✅ Solution 2: Fix Network Interface Error

The error `uv_interface_addresses returned Unknown system error 1` happens when Node.js can't read network interfaces.

### Fix 1: Update Node.js

```bash
# Check current version
node --version

# Update to latest LTS (if needed)
brew update && brew upgrade node
```

### Fix 2: Run with --inspect flag

```bash
cd ui
NODE_OPTIONS='--inspect' npm run dev
```

### Fix 3: Bypass network interface detection

Create `ui/.npmrc`:
```
NEXT_TELEMETRY_DISABLED=1
```

Then restart:
```bash
cd ui
rm -rf .next
npm run dev -- --hostname 127.0.0.1
```

---

## ✅ Solution 3: Use Different Port

```bash
cd ui
PORT=3001 npm run dev
```

Then access: http://localhost:3001

---

## 🧪 Verify UI is Running

```bash
# Check if port is listening
lsof -i:3000

# Test HTTP response
curl -I http://localhost:3000
```

Expected: `HTTP/1.1 200 OK` or `HTTP/1.1 307` (redirect)

---

## 📋 Complete Startup Checklist

1. ✅ **MongoDB Running**: `docker ps | grep mongodb`
   - If not: `docker compose -f docker-compose.dev.yaml up -d`

2. ✅ **UI Dev Server Running**: `lsof -i:3000`
   - If not: Use one of the solutions above

3. ✅ **API Accessible**: `curl http://localhost:3000/api/chat/conversations`
   - Should return JSON (might be 401 if not logged in - that's OK)

4. ✅ **Open Browser**: http://localhost:3000
   - Should show login page or chat interface

---

## 🐛 Still Not Working?

### Check Logs:

```bash
# UI logs (if using Docker)
docker logs caipe-ui-dev

# DocumentDB logs
docker logs caipe-documentdb-dev
```

### Reset Everything:

```bash
# Kill all UI processes
pkill -f "next dev"
lsof -ti:3000 | xargs kill -9

# Clean Next.js cache
cd ui && rm -rf .next && cd ..

# Restart with Docker (cleanest)
docker compose -f docker-compose.dev.yaml --profile caipe-ui-dev down
docker compose -f docker-compose.dev.yaml --profile caipe-ui-dev up -d
```

---

## 🎯 Quick Start (Fresh Environment)

```bash
# Terminal 1: Start MongoDB + UI with Docker
docker compose -f docker-compose.dev.yaml --profile caipe-ui-dev up

# Terminal 2: Watch logs
docker logs -f caipe-ui-dev

# Browser: Open UI
open http://localhost:3000
```

---

## 📝 Notes

- The `uv_interface_addresses` error doesn't prevent Docker from working
- Docker is the recommended approach for development
- Local npm dev server works on most systems but has occasional macOS issues

---

**Need help?** Check the error messages in:
- `docker logs caipe-ui-dev`
- Browser console (F12 → Console tab)
- Terminal where `npm run dev` is running
