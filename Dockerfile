FROM ubuntu:24.04

# Install dependencies + Chromium for headless testing
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    sudo \
    unzip \
    chromium-browser \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2t64 \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for running docker commands inside container)
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash ccc && \
    echo "ccc ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Add ccc user to docker group
RUN groupadd -g 999 docker || true && usermod -aG docker ccc

USER ccc
WORKDIR /home/ccc

# Install mise
RUN curl https://mise.run | sh

# Configure mise settings
RUN mkdir -p ~/.config/mise && \
    echo '[settings]' > ~/.config/mise/config.toml && \
    echo 'experimental = true' >> ~/.config/mise/config.toml

# Configure bashrc for mise (for interactive shells)
RUN echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc

# Install global tools via mise (maven, gradle, yarn, pnpm)
RUN ~/.local/bin/mise use -g maven@latest && \
    ~/.local/bin/mise use -g gradle@latest && \
    ~/.local/bin/mise use -g yarn@latest && \
    ~/.local/bin/mise use -g pnpm@latest

# Install claude-code native binary
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add mise shims to PATH so non-interactive shells can use tools
ENV PATH="/home/ccc/.local/share/mise/shims:/home/ccc/.local/bin:/home/ccc/.claude/local:$PATH"
ENV MISE_SHIMS_DIR="/home/ccc/.local/share/mise/shims"
ENV CHROME_BIN="/usr/bin/chromium-browser"
ENV CHROMIUM_FLAGS="--no-sandbox --disable-gpu --headless"

WORKDIR /project

CMD ["tail", "-f", "/dev/null"]
