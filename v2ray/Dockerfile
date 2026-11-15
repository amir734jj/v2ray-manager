FROM v2fly/v2fly-core
RUN apk add --no-cache nodejs
COPY v2ray/templates/server.template.json /etc/v2ray/server.json
COPY v2ray/custom-dns.cjs /etc/v2ray/custom-dns.cjs
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["if [ -n \"${V2RAY_DNS_SERVER:-}\" ]; then node /etc/v2ray/custom-dns.cjs && exec v2ray run -config /tmp/v2ray-server.json; else exec v2ray run -config /etc/v2ray/server.json; fi"]