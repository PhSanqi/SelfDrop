FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
ENV DROP_CHAT_HOST=0.0.0.0 \
    DROP_CHAT_PORT=2585 \
    NTFY_BASE_URL=http://ntfy \
    NTFY_TOPIC=selfdrop \
    DROP_CHAT_DATA_DIR=/var/lib/selfdrop \
    NTFY_CACHE_FILE=/var/cache/ntfy/cache.db \
    NTFY_ATTACHMENT_DIR=/var/cache/ntfy/attachments
EXPOSE 2585
CMD ["node", "server.mjs"]
