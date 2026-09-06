import os
import socketio
import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from backend.routers.views import router as view_router
from backend.sockets.game_socket import register_socket_events
from backend.logging_setup import setup_logging, build_logging_config, get_logger

# 로깅 설정을 즉시 적용 (uvicorn.run() 호출 전에 실행되는 코드의 로그도 잡히도록)
# reload=True에서도 매번 새로 뜨는 워커 프로세스에 적용되도록 모듈 최상단(진입점 가드 밖)에서 호출
setup_logging()
logger = get_logger(__name__)


app = FastAPI()
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "frontend", "static")
DATA_DIR = os.path.join(BASE_DIR, "data")

# 1. 소켓 이벤트 등록
register_socket_events(sio)

# 2. 라우터 장착 (HTML 페이지 서빙용 - "/", "/room", "/game", "/api/scenarios" 전부 여기서 처리)
app.include_router(view_router)

# 3. [중요] 구체적인 정적 파일 마운트를 먼저 선언합니다!
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")

# 4. [중요] 모든 것을 받아먹는 catch-all 소켓 앱은 맨 마지막에 마운트합니다.
app.mount("/", socketio.ASGIApp(sio))

if __name__ == "__main__":
    PORT = 8000

    # 외부 접속용 터널(cloudflared)은 이제 Windows 서비스로 별도 등록해서 항상 백그라운드에서
    # 돌아가고 있으므로, 여기서는 그냥 로컬(127.0.0.1:8000) 서버만 켜면 됨.
    # (cloudflared 서비스가 mozzi.site로 들어오는 요청을 알아서 이 포트로 연결해줌)
    logger.info(f"🚀 서버 시작 (포트 {PORT}) - cloudflared 서비스가 외부 접속을 처리합니다.")

    uvicorn.run("main:app", host="127.0.0.1", port=PORT, reload=False, log_config=build_logging_config())