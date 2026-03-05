terraform {
  required_providers {
    coder = {
      source = "coder/coder"
    }
    docker = {
      source = "kreuzwerker/docker"
    }
  }
}

provider "docker" {}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

# ---------- Build Parameters ----------
# Users fill these in when creating a workspace

data "coder_parameter" "anthropic_api_key" {
  name         = "anthropic_api_key"
  display_name = "Anthropic API Key"
  description  = "Your Anthropic API key (sk-ant-...)"
  type         = "string"
  mutable      = true
  ephemeral    = true
}

data "coder_parameter" "workspace_repo" {
  name         = "workspace_repo"
  display_name = "Git Repository (optional)"
  description  = "A git repo URL to clone into the workspace (leave empty to start fresh)"
  type         = "string"
  default      = ""
  mutable      = true
}

# ---------- Docker Image ----------

resource "docker_image" "claudia" {
  name = "claudia:latest"
  keep_locally = true
}

# ---------- Persistent Volume ----------
# Survives workspace stop/start — stores user projects, task history, config

resource "docker_volume" "workspaces" {
  name = "coder-${data.coder_workspace_owner.me.name}-${data.coder_workspace.me.name}-workspaces"
}

resource "docker_volume" "claudia_config" {
  name = "coder-${data.coder_workspace_owner.me.name}-${data.coder_workspace.me.name}-config"
}

# ---------- Container ----------

resource "docker_container" "claudia" {
  count = data.coder_workspace.me.start_count
  name  = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  image = docker_image.claudia.image_id

  env = [
    "CODER_AGENT_TOKEN=${coder_agent.main.token}",
    "ANTHROPIC_API_KEY=${data.coder_parameter.anthropic_api_key.value}",
  ]

  # Resource limits per workspace
  memory = 4096  # 4GB RAM
  cpu_shares = 1024

  volumes {
    volume_name    = docker_volume.workspaces.name
    container_path = "/home/coder/workspaces"
  }

  # Persist workspace config and task histories across restarts
  volumes {
    volume_name    = docker_volume.claudia_config.name
    container_path = "/app/backend/task-histories"
  }

  # Override entrypoint to start coder agent alongside claudia
  entrypoint = ["sh", "-c", <<-EOF
    # Start the Coder agent in the background
    ${coder_agent.main.init_script} &

    # Start Claudia
    /docker-entrypoint.sh
  EOF
  ]
}

# ---------- Coder Agent ----------

resource "coder_agent" "main" {
  arch = data.coder_provisioner.me.arch
  os   = "linux"
  dir  = "/home/coder/workspaces"

  metadata {
    display_name = "CPU Usage"
    key          = "cpu"
    script       = "top -bn1 | grep 'Cpu(s)' | awk '{print $2}'"
    interval     = 10
    timeout      = 5
  }

  metadata {
    display_name = "Memory Usage"
    key          = "mem"
    script       = "free -m | awk '/Mem:/ {printf \"%dMB / %dMB\", $3, $2}'"
    interval     = 10
    timeout      = 5
  }
}

# ---------- Startup Script ----------

resource "coder_script" "clone_repo" {
  agent_id     = coder_agent.main.id
  display_name = "Clone Repository"
  icon         = "/icon/git.svg"
  script       = <<-EOF
    #!/bin/bash
    REPO="${data.coder_parameter.workspace_repo.value}"
    if [ -n "$REPO" ]; then
      REPO_NAME=$(basename "$REPO" .git)
      TARGET="/home/coder/workspaces/$REPO_NAME"
      if [ ! -d "$TARGET" ]; then
        echo "Cloning $REPO into $TARGET..."
        git clone "$REPO" "$TARGET"
      else
        echo "Repository already cloned at $TARGET"
      fi
    fi
  EOF
  run_on_start = true
}

# ---------- Claudia Web App ----------
# This is what users click to open the Claudia UI

resource "coder_app" "claudia" {
  agent_id     = coder_agent.main.id
  slug         = "claudia"
  display_name = "Claudia"
  url          = "http://localhost:4001"
  icon         = "/icon/code.svg"
  subdomain    = true
  share        = "owner"

  healthcheck {
    url       = "http://localhost:4001/api/health"
    interval  = 5
    threshold = 10
  }
}

# ---------- Terminal Access ----------

resource "coder_app" "terminal" {
  agent_id     = coder_agent.main.id
  slug         = "terminal"
  display_name = "Terminal"
  url          = ""  # Empty = Coder's built-in web terminal
  icon         = "/icon/terminal.svg"
  subdomain    = false
  share        = "owner"
}
