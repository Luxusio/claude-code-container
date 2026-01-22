FROM ubuntu:24.04

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    sudo \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash ccc && \
    echo "ccc ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER ccc
WORKDIR /home/ccc

# Install mise
RUN curl https://mise.run | sh

# Configure mise settings
RUN mkdir -p ~/.config/mise && \
    echo '[settings]' > ~/.config/mise/config.toml && \
    echo 'experimental = true' >> ~/.config/mise/config.toml

# Configure bashrc for mise and env (for interactive shells)
RUN echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc && \
    echo '[ -f /env ] && set -a && source /env && set +a' >> ~/.bashrc

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

WORKDIR /project

CMD ["tail", "-f", "/dev/null"]
