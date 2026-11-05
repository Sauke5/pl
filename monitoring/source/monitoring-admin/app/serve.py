from __future__ import annotations

from alembic import command
from alembic.config import Config
import uvicorn

from app.config import get_settings


def main() -> None:
    settings = get_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    alembic = Config("alembic.ini")
    alembic.set_main_option("sqlalchemy.url", settings.database_url)
    command.upgrade(alembic, "head")
    uvicorn.run("app.main:app", host="0.0.0.0", port=8080, proxy_headers=True, forwarded_allow_ips="*")


if __name__ == "__main__":
    main()
