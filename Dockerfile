FROM ubuntu:24.04

# ============================================================
# LAYER 0: Use faster mirror for ARM64 (ports.ubuntu.com is slow)
# ============================================================
RUN sed -i 's|http://ports.ubuntu.com|http://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/ubuntu.sources

# ============================================================
# LAYER 1: Minimal base for Chromium PPA (절대 안 바뀜)
# ============================================================
RUN apt-get update && apt-get install -y \
    software-properties-common \
    ca-certificates \
    curl \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ============================================================
# LAYER 2: Chromium (무겁고 절대 안 바뀜)
# ============================================================
RUN add-apt-repository -y ppa:xtradeb/apps && \
    apt-get update && \
    apt-get install -y chromium && \
    rm -rf /var/lib/apt/lists/*

# ============================================================
# LAYER 3: Docker CLI (무겁고 절대 안 바뀜)
# ============================================================
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

# ============================================================
# LAYER 4: Chromium dependencies + dev tools (거의 안 바뀜)
# ============================================================
RUN apt-get update && apt-get install -y \
    git \
    sudo \
    unzip \
    wget \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2t64 \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# ============================================================
# LAYER 5: User setup (절대 안 바뀜)
# ============================================================
RUN useradd -m -s /bin/bash ccc && \
    echo "ccc ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    (getent group docker || groupadd docker) && usermod -aG docker ccc

USER ccc
WORKDIR /home/ccc

# ============================================================
# LAYER 6: mise 설치 + 설정 (거의 안 바뀜)
# ============================================================
RUN curl https://mise.run | sh && \
    mkdir -p ~/.config/mise && \
    echo '[settings]' > ~/.config/mise/config.toml && \
    echo 'experimental = true' >> ~/.config/mise/config.toml && \
    echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc

# ============================================================
# LAYER 7: mise global tools (가끔 바뀜 - 버전 고정)
# ============================================================
RUN ~/.local/bin/mise use -g node@22 && \
    ~/.local/bin/mise use -g maven@3 && \
    ~/.local/bin/mise use -g gradle@8 && \
    ~/.local/bin/mise use -g yarn@4 && \
    ~/.local/bin/mise use -g pnpm@9

# ============================================================
# LAYER 8: Fonts (가끔 바뀜)
# ============================================================
RUN sudo apt-get update && sudo apt-get install -y \
    fonts-liberation \
    fonts-noto-cjk \
    && sudo rm -rf /var/lib/apt/lists/*

# ============================================================
# claude-code is installed at runtime and cached in mise volume.
# See ensureClaudeInContainer() in src/index.ts
# ============================================================

# ============================================================
# Environment variables
# ============================================================
ENV PATH="/home/ccc/.local/bin:/home/ccc/.local/share/mise/shims:/home/ccc/.claude/local:$PATH"
ENV MISE_SHIMS_DIR="/home/ccc/.local/share/mise/shims"
ENV DISPLAY=":99"
ENV CHROME_PATH="/usr/bin/chromium"
ENV CHROMIUM_PATH="/usr/bin/chromium"

WORKDIR /project
CMD ["tail", "-f", "/dev/null"]
