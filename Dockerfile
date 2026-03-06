# ==========================================================
# Stage 1: Download Chromium via Playwright CDN (amd64/arm64)
# ==========================================================
FROM node:22-slim AS chromium-dl
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
WORKDIR /tmp/pw
RUN npm install playwright && npx playwright install chromium

# ==========================================================
# Stage 2: Main image
# ==========================================================
FROM ubuntu:24.04

# ============================================================
# LAYER 0: Optional faster mirror for ARM64 (ports.ubuntu.com is slow)
# ============================================================
ARG USE_CN_MIRROR=false
RUN if [ "$USE_CN_MIRROR" = "true" ]; then \
        sed -i 's|http://ports.ubuntu.com|https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/ubuntu.sources; \
    fi

# ============================================================
# LAYER 1: Base packages (절대 안 바뀜)
# ============================================================
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ============================================================
# LAYER 2: Chromium binary (multi-stage에서 복사, 캐시 독립)
# ============================================================
COPY --from=chromium-dl /opt/browsers /opt/browsers
RUN ln -s "$(find /opt/browsers -name chrome -type f | head -1)" /usr/bin/chromium

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
RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y \
    git \
    sudo \
    unzip \
    wget \
    locales \
    tzdata \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2t64 \
    libcups2t64 \
    libxfixes3 \
    libcairo2 \
    libpango-1.0-0 \
    xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && locale-gen en_US.UTF-8 \
    && locale-gen ko_KR.UTF-8 \
    && locale-gen ja_JP.UTF-8 \
    && locale-gen zh_CN.UTF-8 \
    && locale-gen de_DE.UTF-8 \
    && locale-gen fr_FR.UTF-8 \
    && locale-gen es_ES.UTF-8 \
    && locale-gen pt_BR.UTF-8 \
    && update-locale LANG=en_US.UTF-8

# ============================================================
# LAYER 5: User setup (절대 안 바뀜)
# ============================================================
RUN useradd -m -s /bin/bash ccc && \
    echo "ccc ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    (getent group docker || groupadd docker) && usermod -aG docker ccc

USER ccc
WORKDIR /home/ccc

# Trust all directories (container is isolated, ownership mismatches from bind mounts)
RUN git config --global --add safe.directory '*'

# ============================================================
# LAYER 6: mise 설치 + 설정 (거의 안 바뀜)
# ============================================================
RUN curl https://mise.run | sh && \
    mkdir -p ~/.config/mise && \
    echo '[settings]' > ~/.config/mise/config.toml && \
    echo 'experimental = true' >> ~/.config/mise/config.toml && \
    echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc && \
    printf '# Reset MISE_NODE_VERSION so Claude Bash tool uses project node version.\n# MISE_NODE_VERSION=22 is set for OMC hooks (which run via sh -c, ignoring BASH_ENV).\nunset MISE_NODE_VERSION\neval "$(~/.local/bin/mise activate bash)"\n' > ~/.bashrc_hooks

# ============================================================
# LAYER 7: mise global tools (가끔 바뀜 - 버전 고정)
# ============================================================
RUN --mount=type=secret,id=github_token,uid=1000,mode=0444 \
    if [ -f /run/secrets/github_token ]; then export GITHUB_TOKEN=$(cat /run/secrets/github_token); fi && \
    ~/.local/bin/mise use -g node@22 && \
    ~/.local/bin/mise use -g maven@3 && \
    ~/.local/bin/mise use -g gradle@8 && \
    ~/.local/bin/mise use -g yarn@4 && \
    ~/.local/bin/mise use -g pnpm@9

# ============================================================
# LAYER 8: Fonts
# ============================================================
RUN sudo apt-get update && sudo apt-get install -y \
    fonts-liberation \
    fonts-noto-cjk \
    && sudo rm -rf /var/lib/apt/lists/*

# ============================================================
# LAYER 9: Clipboard shims (host clipboard bridge for image paste)
# ============================================================
COPY --chmod=755 scripts/clipboard-shims/xclip /usr/local/bin/xclip
COPY --chmod=755 scripts/clipboard-shims/xsel /usr/local/bin/xsel
COPY --chmod=755 scripts/clipboard-shims/wl-paste /usr/local/bin/wl-paste
COPY --chmod=755 scripts/clipboard-shims/wl-copy /usr/local/bin/wl-copy
COPY --chmod=755 scripts/clipboard-shims/pbpaste /usr/local/bin/pbpaste
# Strip Windows CRLF line endings (git on Windows may convert LF→CRLF)
RUN sudo sed -i 's/\r$//' /usr/local/bin/xclip /usr/local/bin/xsel /usr/local/bin/wl-paste /usr/local/bin/wl-copy /usr/local/bin/pbpaste

# ============================================================
# claude-code is installed at runtime and cached in mise volume.
# See ensureClaudeInContainer() in src/index.ts
# ============================================================

# ============================================================
# Environment variables
# ============================================================
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
ENV PATH="/home/ccc/.local/bin:/home/ccc/.local/share/mise/shims:/home/ccc/.claude/local:$PATH"
ENV MISE_SHIMS_DIR="/home/ccc/.local/share/mise/shims"
ENV DISPLAY=":99"
ENV CHROME_PATH="/usr/bin/chromium"
ENV CHROMIUM_PATH="/usr/bin/chromium"
ENV LANG=en_US.UTF-8
ENV TZ=UTC

WORKDIR /project
CMD ["tail", "-f", "/dev/null"]
