ARG LLAMA_CPP_IMAGE=ghcr.io/ggml-org/llama.cpp:server-cuda
FROM ${LLAMA_CPP_IMAGE}

USER root

ARG LLAMA_SWAP_VERSION=202

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tini \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/llama-swap.tar.gz \
    "https://github.com/mostlygeek/llama-swap/releases/download/v${LLAMA_SWAP_VERSION}/llama-swap_${LLAMA_SWAP_VERSION}_linux_amd64.tar.gz" \
    && tar -xzf /tmp/llama-swap.tar.gz -C /usr/local/bin \
    && chmod +x /usr/local/bin/llama-swap \
    && rm -f /tmp/llama-swap.tar.gz

COPY docker/llama-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /runtime
ENV LD_LIBRARY_PATH=/app${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}

EXPOSE 8090

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
