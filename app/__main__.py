"""
App Entry Point
"""

import resource

import uvicorn

from app.core.config import settings
from app.core.log import uvicorn_log_config

if __name__ == "__main__":
    # LanceDB scans open every table fragment concurrently; the default Docker soft
    # limit of 1024 descriptors is easily exceeded ("Too many open files").
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft < hard:
        resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))

    uvicorn.run(
        "app.main:app",
        host=settings.APP_HOST,
        port=settings.APP_PORT,
        workers=settings.APP_WORKERS,
        log_config=uvicorn_log_config,
        reload=False,
        forwarded_allow_ips="*",
    )
