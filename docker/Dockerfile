FROM oven/bun:latest AS builder

WORKDIR /build
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build --compile cli.ts --outfile /build/jiny-m

# ---

FROM oven/bun:latest

# Dev tools
RUN apt-get update && apt-get install -y \
    git curl ripgrep jq procps xz-utils inotify-tools \
    && rm -rf /var/lib/apt/lists/*

# s6-overlay for process supervision
ARG S6_OVERLAY_VERSION=3.1.6.2
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && rm /tmp/s6-overlay-noarch.tar.xz
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz && rm /tmp/s6-overlay-x86_64.tar.xz

# Install OpenCode
RUN curl -fsSL https://opencode.ai/install | bash \
    && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Copy compiled jiny-M binary
COPY --from=builder /build/jiny-m /usr/local/bin/jiny-m

# Copy jiny-M source (for rebuilding inside container during bootstrapping)
COPY --from=builder /build /opt/jiny-m-src/

# s6 service definitions
COPY docker/s6-rc.d/ /etc/s6-overlay/s6-rc.d/
RUN touch /etc/s6-overlay/s6-rc.d/user/contents.d/jiny-m

# Working directory for jiny-M config
WORKDIR /opt/jiny-m

# Volumes: config and workspace mounted from host
VOLUME ["/opt/jiny-m/.jiny", "/workspace"]

ENTRYPOINT ["/init"]
