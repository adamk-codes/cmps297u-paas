# Image for the backup and restore Kubernetes Jobs (and the local docker-compose tools).
# PG_MAJOR must be >= the RDS PostgreSQL major version (pg_dump refuses to dump a newer server).
ARG PG_MAJOR=16
FROM postgres:${PG_MAJOR}-alpine

RUN apk add --no-cache aws-cli jq bash coreutils

COPY lib.sh backup.sh restore.sh provision.sh deprovision.sh isolation-check.sh entrypoint.sh /usr/local/bin/rebound/
RUN chmod +x /usr/local/bin/rebound/*.sh

# Run as the unprivileged postgres user; dumps go to /tmp.
USER postgres
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/rebound/entrypoint.sh"]
CMD ["help"]
