FROM ubuntu:24.04

# Install dependencies + Xvfb + VNC for virtual display
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    sudo \
    unzip \
    wget \
    gnupg \
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
    xvfb \
    x11vnc \
    dbus-x11 \
    x11-utils \
    openbox \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome (official - supports extensions)
RUN wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    apt-get update && \
    apt-get install -y /tmp/google-chrome.deb && \
    rm /tmp/google-chrome.deb && \
    rm -rf /var/lib/apt/lists/*

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

# Setup Chrome extension force-install policy
RUN mkdir -p /etc/opt/chrome/policies/managed && \
    echo '{ "ExtensionInstallForcelist": ["fcoeoabgfenejglbffodgkkbkcdhcgfn;https://clients2.google.com/service/update2/crx"] }' > /etc/opt/chrome/policies/managed/claude-code.json

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

# Copy helper scripts (Chrome wrapper, VNC starter, extension setup)
COPY --chown=ccc:ccc scripts/google-chrome scripts/start-vnc scripts/setup-chrome-extension.sh /home/ccc/bin/
# Fix Windows line endings (CRLF -> LF) and make executable
RUN sed -i 's/\r$//' ~/bin/* && chmod +x ~/bin/*

ENV PATH="/home/ccc/bin:${PATH}"

# Install global tools via mise (maven, gradle, yarn, pnpm)
RUN ~/.local/bin/mise use -g maven@latest && \
    ~/.local/bin/mise use -g gradle@latest && \
    ~/.local/bin/mise use -g yarn@latest && \
    ~/.local/bin/mise use -g pnpm@latest

# Install claude-code native binary
RUN curl -fsSL https://claude.ai/install.sh | bash

# Setup Chrome extension native messaging host
RUN ~/bin/setup-chrome-extension.sh

# Add mise shims to PATH so non-interactive shells can use tools
ENV PATH="/home/ccc/.local/share/mise/shims:/home/ccc/.local/bin:/home/ccc/.claude/local:$PATH"
ENV MISE_SHIMS_DIR="/home/ccc/.local/share/mise/shims"
ENV CHROME_BIN="/home/ccc/bin/google-chrome"
ENV CHROMIUM_FLAGS="--no-sandbox --disable-gpu"
ENV DISPLAY=":99"

WORKDIR /project

# Nothing starts by default - use start-chrome, start-vnc when needed
CMD ["tail", "-f", "/dev/null"]
