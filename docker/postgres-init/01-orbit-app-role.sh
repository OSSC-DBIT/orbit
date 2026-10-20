#!/bin/bash
# Runs on first boot of an EMPTY postgres data volume (docker-entrypoint init).
#
# Purpose: the app must never connect as the postgres superuser, because
# superusers bypass row level security no matter what the policies say. This
# script creates a dedicated NOSUPERUSER "orbit" role that owns the database:
# migrations run as this role, all tables it creates are FORCE RLS bound.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbit') THEN
      CREATE ROLE orbit LOGIN NOSUPERUSER PASSWORD '${ORBIT_APP_PASSWORD}';
    END IF;
  END
  \$\$;

  ALTER DATABASE orbit OWNER TO orbit;

  GRANT ALL ON SCHEMA public TO orbit;

  ALTER DEFAULT PRIVILEGES FOR ROLE orbit IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO orbit;

  ALTER DEFAULT PRIVILEGES FOR ROLE orbit IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO orbit;

  ALTER DEFAULT PRIVILEGES FOR ROLE orbit IN SCHEMA public
    GRANT ALL ON FUNCTIONS TO orbit;
EOSQL

echo "orbit application role ready (NOSUPERUSER, owns the orbit database)"
