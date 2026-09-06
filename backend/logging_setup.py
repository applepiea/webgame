import os
import re
import logging
import logging.config

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(BASE_DIR, "..", "logs")
os.makedirs(LOG_DIR, exist_ok=True)

SERVER_LOG_PATH = os.path.join(LOG_DIR, "server.log")
ERROR_LOG_PATH = os.path.join(LOG_DIR, "error.log")


class StatusCodeSplitFilter(logging.Filter):
    """uvicorn 접속 로그(access log)를 HTTP 상태코드 기준으로 분리하는 필터.
    keep_below=True면 400 미만(정상)만, False면 400 이상(에러)만 통과시킴."""

    def __init__(self, threshold=400, keep_below=True):
        super().__init__()
        self.threshold = threshold
        self.keep_below = keep_below

    def filter(self, record):
        status = self._extract_status(record)
        if status is None:
            return self.keep_below
        if self.keep_below:
            return status < self.threshold
        return status >= self.threshold

    def _extract_status(self, record):
        args = record.args
        if isinstance(args, tuple) and args:
            last = args[-1]
            if isinstance(last, int):
                return last
        match = re.search(r"(\d{3})\s*$", record.getMessage())
        return int(match.group(1)) if match else None


def build_logging_config():
    """서버 전체 로깅 설정.
    - server.log : INFO 이상 전부 (정상 흐름 포함, 게임 이벤트 로그 전부)
    - error.log  : WARNING 이상만 (진짜 문제로 판단되는 것만 - logger.warning()/error()로 명시적으로 남긴 것)
    - uvicorn 접속 로그(HTTP 상태코드)는 400 기준으로 따로 분리
    - 우리 게임 로직은 "game" 로거(logger.info/warning/error)로 명시적으로 레벨을 구분해서 기록
    """
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "default": {
                "format": "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
                "datefmt": "%Y-%m-%d %H:%M:%S",
            },
        },
        "filters": {
            "status_ok": {"()": "backend.logging_setup.StatusCodeSplitFilter", "keep_below": True},
            "status_error": {"()": "backend.logging_setup.StatusCodeSplitFilter", "keep_below": False},
        },
        "handlers": {
            "console": {
                "class": "logging.StreamHandler",
                "formatter": "default",
            },
            "server_file": {
                "class": "logging.handlers.RotatingFileHandler",
                "filename": SERVER_LOG_PATH,
                "maxBytes": 5_000_000,
                "backupCount": 3,
                "formatter": "default",
                "encoding": "utf-8",
                "level": "INFO",
            },
            "error_file": {
                "class": "logging.handlers.RotatingFileHandler",
                "filename": ERROR_LOG_PATH,
                "maxBytes": 5_000_000,
                "backupCount": 3,
                "formatter": "default",
                "encoding": "utf-8",
                "level": "WARNING",
            },
            "access_server_file": {
                "class": "logging.handlers.RotatingFileHandler",
                "filename": SERVER_LOG_PATH,
                "maxBytes": 5_000_000,
                "backupCount": 3,
                "formatter": "default",
                "encoding": "utf-8",
                "filters": ["status_ok"],
            },
            "access_error_file": {
                "class": "logging.handlers.RotatingFileHandler",
                "filename": ERROR_LOG_PATH,
                "maxBytes": 5_000_000,
                "backupCount": 3,
                "formatter": "default",
                "encoding": "utf-8",
                "filters": ["status_error"],
            },
        },
        "loggers": {
            "uvicorn": {"handlers": ["console", "server_file"], "level": "INFO", "propagate": False},
            "uvicorn.error": {"handlers": ["console", "error_file"], "level": "INFO", "propagate": False},
            "uvicorn.access": {
                "handlers": ["console", "access_server_file", "access_error_file"],
                "level": "INFO",
                "propagate": False,
            },
            # 우리 게임 로직 전용 로거 - 하위 모듈에서는 get_logger(__name__)으로 자식 로거를 받아 쓰면
            # 여기 핸들러로 자동 전파(propagate)됨
            "game": {
                "handlers": ["console", "server_file", "error_file"],
                "level": "INFO",
                "propagate": False,
            },
        },
    }


def setup_logging():
    """main.py 최상단(진입점 가드 밖)에서 한 번 호출.
    uvicorn.run() 호출 전에 실행되는 코드(ngrok 설정 등)의 로그도 잡을 수 있도록 여기서 즉시 적용."""
    logging.config.dictConfig(build_logging_config())


def get_logger(name):
    """각 모듈에서 이 함수로 로거를 받아서 logger.info()/warning()/error()로 기록.
    예: logger = get_logger(__name__)"""
    return logging.getLogger(f"game.{name}")