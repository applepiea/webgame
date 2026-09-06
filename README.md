# 머더미스터리 온라인

실시간 온라인 머더미스터리 게임. FastAPI + Socket.IO + 바닐라 JS.
GM 1인 + 참여자 최대 6인.

## 설치

```bash
pip install fastapi uvicorn python-socketio
```

## 실행

```bash
python main.py
```

`http://127.0.0.1:8000` 접속 → 닉네임/방 이름/시나리오 선택 → 방 만들기 또는 참여.

## 외부 접속 (선택)

친구들이랑 같이 하려면 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 설치 후:
```
cloudflared tunnel --url http://localhost:8000
```

## 폴더 구조

```
main.py                       # 진입점
backend/
  routers/views.py            # HTML 페이지 라우트
  services/scenario_loader.py # data/*.json 로딩
  sockets/handlers/           # 방/게임/오브젝트/밀담/엔딩 소켓 이벤트
frontend/static/js/           # game.js, room.js, bgm.js
data/scenario_01/             # 시나리오 데이터 (json 파일들 + images/audio)
```

## 참고 (나중에 다시 볼 때)

- 시나리오 콘텐츠는 대부분 `data/scenario_01/` 안 JSON 파일로 관리됨 (코드 안 건드려도 캐릭터/단서/엔딩 수정 가능)
- 엔딩 분기 알고리즘은 `backend/sockets/handlers/ending_handler.py` 참고 (시나리오별 파일로 분리 예정/진행 중)
- 개발 중엔 `main.py`의 `uvicorn.run(..., reload=True)`로, 실제 플레이할 땐 `reload=False`로