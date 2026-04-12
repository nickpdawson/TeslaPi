"""Application settings loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """TeslaPi application configuration.

    All fields can be overridden via environment variables with the TESLAPI_ prefix.
    Example: TESLAPI_DEV_MODE=true, TESLAPI_PORT=9090
    """

    teslausb_config_path: str = "/boot/firmware/teslausb_setup_variables.conf"
    database_path: str = "/opt/teslapi/teslapi.db"
    host: str = "0.0.0.0"
    port: int = 8080
    dev_mode: bool = False
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:8080"]
    log_dir: str = "/var/log"
    static_dir: str = "frontend/dist"

    model_config = {
        "env_prefix": "TESLAPI_",
        "env_file": ".env",
        "env_file_encoding": "utf-8",
    }


settings = Settings()
