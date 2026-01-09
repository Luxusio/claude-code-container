FROM node:22-alpine

RUN apk add --no-cache git curl ca-certificates bash \
    && npm install -g @anthropic-ai/claude-code \
    && adduser -D -s /bin/bash -u 1000 claude \
    && mkdir -p /workspace /claude \
    && chown -R claude:claude /workspace /claude

USER claude

# Install mise
RUN curl https://mise.run | sh
ENV PATH="/home/claude/.local/bin:$PATH"

WORKDIR /workspace
