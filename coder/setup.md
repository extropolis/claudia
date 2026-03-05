# Claudia + Coder: Multi-User Cloud Setup

Deploy Claudia so multiple users can each get their own instance by visiting a URL.

## Architecture

```
Users → https://coder.yourdomain.com → Coder Dashboard → "Create Workspace"
                                              ↓
                                    Docker container per user:
                                      - Claudia backend (port 4001)
                                      - Claudia frontend (static, served by backend)
                                      - Claude CLI
                                      - Persistent workspace volume
```

## Prerequisites

- A Linux VPS (Hetzner CX22 or DigitalOcean $6/mo droplet — 2 vCPU, 4GB RAM minimum)
- A domain name (e.g., `claudia.yourdomain.com`)
- Docker + Docker Compose installed on the VPS

## Step 1: Provision a VPS

### Hetzner (cheapest)
1. Go to https://console.hetzner.cloud
2. Create a new project → Add server
3. Choose **CX22** (2 vCPU, 4GB RAM, 40GB disk) — **€5.39/mo**
4. Select Ubuntu 24.04
5. Add your SSH key
6. Create

### DigitalOcean
1. Create a droplet: **Basic, $6/mo** (1 vCPU, 1GB — okay for 1-2 users)
2. Or **$12/mo** (2 vCPU, 2GB — better for 3-5 users)

## Step 2: Install Docker

SSH into your VPS and run:

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Add your user to the docker group
sudo usermod -aG docker $USER

# Install Docker Compose plugin
sudo apt-get install docker-compose-plugin

# Log out and back in for group changes to take effect
exit
```

## Step 3: Clone Claudia & Build

```bash
git clone https://github.com/YOUR_ORG/claudia.git
cd claudia

# Build the Claudia Docker image
docker build -t claudia .
```

This takes ~3-5 minutes. The image includes Node.js, Claude CLI, and the built frontend.

## Step 4: Configure DNS

Point your domain to the VPS IP:

```
A record:  coder.yourdomain.com    →  YOUR_VPS_IP
A record:  *.coder.yourdomain.com  →  YOUR_VPS_IP   (wildcard, for workspace apps)
```

The wildcard record is needed so each user's Claudia app gets a unique subdomain
(e.g., `user1-claudia.coder.yourdomain.com`).

## Step 5: Start Coder

```bash
cd claudia/coder

# Set your public URL
export CODER_ACCESS_URL="https://coder.yourdomain.com"
export CODER_WILDCARD_ACCESS_URL="*.coder.yourdomain.com"

# Start Coder + PostgreSQL
docker compose up -d
```

Coder will be available at `http://YOUR_VPS_IP:7080`.

## Step 6: (Optional) Set Up HTTPS with Caddy

For production, put a reverse proxy in front of Coder:

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

Create `/etc/caddy/Caddyfile`:

```
coder.yourdomain.com, *.coder.yourdomain.com {
    reverse_proxy localhost:7080
}
```

```bash
sudo systemctl restart caddy
```

Now update your Coder URL:

```bash
export CODER_ACCESS_URL="https://coder.yourdomain.com"
export CODER_WILDCARD_ACCESS_URL="*.coder.yourdomain.com"
docker compose -f coder/docker-compose.yaml up -d
```

## Step 7: Create Admin Account

1. Open `https://coder.yourdomain.com` in your browser
2. Create the first (admin) account
3. This account manages templates and users

## Step 8: Upload the Claudia Template

From your local machine (or the VPS):

```bash
# Install Coder CLI
curl -L https://coder.com/install.sh | sh

# Login to your Coder instance
coder login https://coder.yourdomain.com

# Push the Claudia template
cd claudia
coder templates push claudia -d coder/template
```

## Step 9: Share with Users

Send users this link:

```
https://coder.yourdomain.com
```

They will:
1. Create an account (or you create accounts for them)
2. Click **"Create Workspace"** → select the **Claudia** template
3. Enter their **Anthropic API key**
4. (Optional) Enter a git repo URL to clone
5. Wait ~30-60 seconds
6. Click **"Open Claudia"** → full Claudia UI in their browser

## Managing Users

### Add users
```bash
coder users create --email user@example.com --username alice
```

### List workspaces
```bash
coder list
```

### Stop idle workspaces (save resources)
Coder auto-stops workspaces after the configured idle timeout. You can also manually stop:
```bash
coder stop alice/claudia
```

## Resource Planning

| Users | Recommended VPS | Monthly Cost |
|-------|----------------|-------------|
| 1-2   | Hetzner CX22 (2 vCPU, 4GB)  | ~€5/mo  |
| 3-5   | Hetzner CX32 (4 vCPU, 8GB)  | ~€10/mo |
| 5-10  | Hetzner CX42 (8 vCPU, 16GB) | ~€20/mo |
| 10+   | Hetzner CX52 (16 vCPU, 32GB)| ~€40/mo |

Each Claudia workspace uses ~500MB-1GB RAM when active.

## Troubleshooting

### Claudia UI doesn't load
- Check if the container is running: `docker ps`
- Check logs: `docker logs coder-USERNAME-WORKSPACE`
- Ensure the healthcheck endpoint works: `curl http://localhost:4001/api/health` (from inside the container)

### Workspace creation fails
- Ensure the `claudia:latest` image is built: `docker images | grep claudia`
- Check Coder logs: `docker compose -f coder/docker-compose.yaml logs coder`

### Wildcard subdomains not working
- Verify DNS: `dig *.coder.yourdomain.com`
- Ensure `CODER_WILDCARD_ACCESS_URL` is set
- If using Caddy, ensure the wildcard is in the Caddyfile
