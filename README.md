# 머더미스터리 온라인

실시간 온라인 머더미스터리 게임. FastAPI + Socket.IO + 바닐라 JS.
GM 1인 + 참여자 최대 6인.

## 설치 & 실행

```bash
pip install fastapi uvicorn python-socketio
python main.py
```

`http://127.0.0.1:8000` 접속 → 닉네임/방 이름/시나리오 선택 → 방 만들기 또는 참여.

## 외부 접속 (Cloudflare Tunnel)

```bash
cloudflared tunnel --url http://localhost:8000
```

Public Hostname에서 도메인을 `http://localhost:8000`(HTTPS 아님)으로 연결.
반영 안 되면 대시보드에서 **Purge Cache** 확인.

## 폴더 구조

```
main.py
backend/
  routers/views.py            # HTML 라우트
  services/scenario_loader.py # data/*.json 로딩
  sockets/handlers/           # room, game, object, conversation(밀담), ending
frontend/static/js/           # game.js(단일 파일, 의도적으로 안 나눔), room.js, bgm.js
data/                         # gitignore 대상
  special_ability_config.default.json
  scenario_01/                # endings.json(본문+판정폼+규칙), playthroughs.json(자동 생성) 등
```

## 시나리오는 대부분 데이터(JSON)로 관리됨

`characters.json`, `objects.json`, `phases.json`, `special_items.json`, `map_config.json`,
`special_ability_config.json`(특수 능력, 파일 없으면 기능 자체 꺼짐), `endings.json` 등 —
**코드 거의 안 건드리고 시나리오 내용/규칙을 통째로 교체 가능.**

`endings.json`의 `form_fields`(GM 판정 입력폼 스펙) + `rules`(판정값→엔딩id 매핑, `__gte`/`__lte`/`__in` 지원)로
엔딩 분기 로직 자체가 데이터화되어 있어서, `ending_handler.py`엔 이 시나리오만의 로직이 하드코딩돼 있지 않음.

## 기타 참고

- 밀담: 신청/수락/거절/취소/종료 + 아이템 보여주기(임시)/건네기(양도). 소켓 기반 텍스트/데이터/음성 통신
  (WebRTC로 추가하면 실제 음성 데이터는 P2P라 Cloudflare Tunnel/서버를 안 거침)
- GM: 캐릭터 없이 진행만, 연결 끊기면 임시 방장 자동 승계
- 후기/MVP: 전원 제출 시 결과 공개, `playthroughs.json`에 팀별 영구 누적
- 개발 중 `reload=True`, 실제 플레이 땐 `reload=False`