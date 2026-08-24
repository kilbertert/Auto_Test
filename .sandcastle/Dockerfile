FROM node:22-bookworm

ARG AGENT_UID=1000
ARG AGENT_GID=1000

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

RUN groupmod -o -g ${AGENT_GID} node \
  && usermod -o -u ${AGENT_UID} -g ${AGENT_GID} -d /home/agent -m -l agent node

RUN npm install --global @anthropic-ai/claude-code \
  && mv /usr/local/bin/claude /usr/local/bin/claude-real \
  && printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'case "${AFK_PROFILE:-claude}" in' \
    '  claude) exec /usr/local/bin/claude-real "$@" ;;' \
    '  claude-ark) exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_MODEL -u ANTHROPIC_REASONING_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL /usr/local/bin/claude-real --settings /run/afk/profile-settings.json "$@" ;;' \
    '  *) echo "unsupported AFK_PROFILE" >&2; exit 2 ;;' \
    'esac' > /usr/local/bin/claude \
  && chmod 755 /usr/local/bin/claude \
  && npm cache clean --force

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
