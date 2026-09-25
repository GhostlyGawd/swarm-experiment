FROM node:26.7.0-bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
