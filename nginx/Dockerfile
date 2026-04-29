FROM nginx:alpine

RUN apk add --no-cache openssl && \
    mkdir -p /etc/nginx/certs && \
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout /etc/nginx/certs/key.pem \
      -out    /etc/nginx/certs/cert.pem \
      -subj "/C=ES/ST=Catalonia/L=Barcelona/O=42/CN=localhost"

COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
EXPOSE 443