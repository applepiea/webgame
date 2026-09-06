from backend.services.scenario_loader import load_scenario_characters, load_scenario_objects, load_scenario_phase_config, load_scenario_special_items, load_scenario_endings, load_scenario_special_ability_config, load_scenario_ending_visual_theme, load_scenario_ending_rules_config
from backend.logging_setup import get_logger
import re

logger = get_logger(__name__)

# 한글과 숫자만 허용하는 패턴
PATTERN = re.compile(r"^[가-힣0-9]+$")

rooms = {}
sid_to_room = {}


def register_room_handlers(sio, emit_room_state_func):

  @sio.event
  async def leave_room_explicit(sid, data):
      logger.info(f"📥 [서버 수신] leave_room_explicit 호출됨! 데이터: {data}")
      room_id = data.get("room_id")
      nickname = data.get("nickname")

      if room_id in rooms:
          room_data = rooms[room_id]

          if nickname == room_data.get("gm"):
              # 방장이 명시적으로 나가면 방 자체를 종료 (다른 사람에게 승계하지 않음)
              logger.info(f"🛑 [leave_room_explicit] 방장({nickname})이 나가서 방 '{room_id}' 전체 종료")

              # 방장 본인을 제외한, 이 방에 현재 연결돼 있는 모든 사람을 찾아서 강제 퇴장
              other_sids = [
                  s for s, info in sid_to_room.items()
                  if info.get("room_id") == room_id and info.get("nickname") != nickname
              ]
              for other_sid in other_sids:
                  await sio.emit("room_destroyed", {"msg": "방장이 나가서 방이 종료되었습니다."}, to=other_sid)
                  await sio.leave_room(other_sid, room_id)
                  if other_sid in sid_to_room:
                      del sid_to_room[other_sid]

              del rooms[room_id]
          else:
              if nickname in room_data["users"]:
                  room_data["users"].remove(nickname)
              if nickname in room_data["selections"]:
                  del room_data["selections"][nickname]

              # 나간 사람이 임시 방장이었다면 그 자격도 같이 소멸
              if room_data.get("temp_gm") == nickname:
                  room_data["temp_gm"] = None

              if len(room_data["users"]) == 0:
                  del rooms[room_id]
              else:
                  await emit_room_state_func(sio, room_id, room_data.get("gm"))

      if sid in sid_to_room:
          del sid_to_room[sid]

      # 🚨 [필수] 소켓 룸 채널에서 탈퇴시키기
      await sio.leave_room(sid, room_id)
      # 🚨 [핵심 추가] 나간 본인(sid)에게 성공 신호를 보내주어야 화면이 이동합니다!
      await sio.emit("left_success", to=sid)

  @sio.event
  async def create_room(sid, data):
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    scenario_id = data.get("scenario_id", "scenario_01")

    # 닉네임 및 방 이름 검사
    if not PATTERN.match(nickname):
        await sio.emit("error", {"msg": "닉네임은 공백 및 특수문자 없이 한글과 숫자만 입력해야 합니다."}, to=sid)
        return
        
    if not PATTERN.match(room_id):
        await sio.emit("error", {"msg": "방 이름은 공백 및 특수문자 없이 한글과 숫자만 입력해야 합니다."}, to=sid)
        return
    if room_id in rooms:
      await sio.emit("error", {"msg": "이미 존재하는 방 이름입니다."}, to=sid)
      return

    characters = load_scenario_characters(scenario_id)
    # load_scenario_objects가 id → object 형태로 이미 완성된 상태를 반환하므로 그대로 사용
    objects_state = load_scenario_objects(scenario_id)
    # 이 시나리오 전용 페이즈 구성(개수/시간/단서 개수 등)과 그룹별 획득 제한 규칙
    scenario_phases, scenario_group_limits = load_scenario_phase_config(scenario_id)

    # 이 시나리오에만 있는 특정 오브젝트 예외 규칙(완전 양도 가능, 특정 페이즈 전용 캐릭터 등)을 병합
    special_items = load_scenario_special_items(scenario_id)
    for obj_id, overrides in special_items.items():
        if obj_id in objects_state:
            objects_state[obj_id].update(overrides)

    # 이 시나리오에만 있는 심문류 특수 기능 설정 (없으면 None = 그 기능 자체가 없는 시나리오)
    special_ability_config = load_scenario_special_ability_config(scenario_id)

    rooms[room_id] = {
        "scenario_id": scenario_id,
        "characters": characters,
        "users": [nickname],
        "selections": {},   # GM(진행자)은 캐릭터를 선택하지 않으므로 여기 등록 안 함
        "gm": nickname,      # 진짜 방장 (게임 미참여, 진행자 역할)
        "temp_gm": None,     # 방장 연결이 끊겼을 때만 채워지는 임시 방장 (페이즈 넘기기 권한만)
        "player_notes": {},  # 닉네임 → 개인 메모 텍스트 (game_state 밖에 둬서 절대 방 전체로 브로드캐스트 안 됨 - 본인에게만 개별 전송)
        "scenario_endings": load_scenario_endings(scenario_id),  # 전체 엔딩 목록(내용 포함) - game_state 밖에 둬서 발표 전까지 절대 브로드캐스트 안 됨
        "scenario_ending_rules_config": load_scenario_ending_rules_config(scenario_id),  # 엔딩 판정 폼/규칙 (이 시나리오만의 분기 로직 전체) - GM 전용, game_state 밖
        "feedback": {},       # 닉네임 → {review, difficulty, rating} - 전원 제출 완료 전까지 비공개
        "mvp_votes": {},      # 닉네임 → 투표 대상 닉네임 - 전원 제출 완료 전까지 비공개
        "pending_interrogation": None,  # {"requester": 닉네임, "target": 닉네임} - GM 응답 대기 중 요청 (GM에게만 개별 전송, game_state 밖에 둬서 비공개)
        "special_ability_config": special_ability_config,  # 이 시나리오 전용 특수 능력 설정 (문구 등) - game_state 밖에 둠, 파일 없으면 None(기능 없음)
        "game_state": {
            "phase": 1,              # 1부터 시작하는 페이즈 번호 (game_state.phases 리스트의 1-based 인덱스)
            "phase_started_at": None,  # 현재 페이즈 시작 시각 (Unix timestamp, 타이머 계산용)
            "started": False,        # 게임(캐릭터 선택 완료 후) 시작 여부
            "objects": objects_state,  # id → 오브젝트 (owner 필드로 소유자 관리)
            "conversations": {},      # conv_id → {participants: [닉네임, 닉네임], phase}
            "pending_invites": {},    # 닉네임 → 신청한 상대 닉네임
            "phases": scenario_phases,          # 이 시나리오의 페이즈 정의 (data/{scenario}/phases.json)
            "group_limits": scenario_group_limits,  # 이 시나리오 전용 그룹별 획득 제한 규칙
            "selected_ending": None,   # 발표된 엔딩 id (발표 전엔 None - 발표 후엔 공개돼도 되므로 game_state 안에 둠)
            "results_revealed": False,  # 후기/난이도/별점/MVP 전원 제출 완료 후 True
            # 심문 기능이 있는 시나리오면 그 캐릭터 이름(예: "이윤"), 없으면 None - 프론트가 버튼 노출 여부 판단용
            "special_ability_character": (special_ability_config or {}).get("ability_character"),
            "interrogation_used_this_phase": False,  # 이번 조사 시간에 심문을 이미 신청했는지 (페이즈 전환 시 초기화)
            "interrogated_targets": [],  # 실제로 심문에 성공(GM 수락)한 대상 닉네임 목록 - 게임 끝까지 유지, 재지목 방지용
            "ending_visual_theme": load_scenario_ending_visual_theme(scenario_id),  # 엔딩 모달 겉모습 테마 (예: "joseon_scroll") - 스포일러 아니라 처음부터 공개 가능
        },
    }
    sid_to_room[sid] = {"room_id": room_id, "nickname": nickname}
    await sio.enter_room(sid, room_id)

    await sio.emit(
        "room_joined",
        {
            "room_id": room_id,
            "users": rooms[room_id]["users"],
            "gm": nickname,
            "temp_gm": None,
            "selections": rooms[room_id]["selections"],
            "characters": characters,
            "game_state": rooms[room_id]["game_state"],
            "scenario_id": scenario_id,
            "my_note": ""
        },
        to=sid,
    )

  @sio.event
  async def join_room(sid, data):
      room_id = data.get("room_id")
      nickname = data.get("nickname")

      # [디버깅 로그] 서버가 이 정보를 확실히 받았는지 확인
      logger.info(f"DEBUG: 입장 시도 - 방:{room_id}, 닉네임:{nickname}")

      if room_id not in rooms:
          await sio.emit("error", {"msg": "존재하지 않는 방입니다."}, to=sid)
          return

      room_data = rooms[room_id]

      # 처음 보는 닉네임인데 이미 게임이 시작된 방이면 입장 자체를 차단
      # (기존 참여자 재접속은 아래 분기에서 언제나 허용됨)
      if nickname not in room_data["users"] and room_data.get("game_state", {}).get("started"):
          logger.warning(f"🚫 [join_room] 이미 시작된 게임에 신규 닉네임({nickname}) 입장 시도 차단")
          await sio.emit("error", {"msg": "이미 시작된 게임입니다. 기존 참여자만 재접속할 수 있습니다."}, to=sid)
          return

      # 이미 방에 같은 닉네임이 있는 경우 → 새 유저가 아니라 "재접속"으로 간주
      if nickname in room_data["users"]:
          logger.info(f"🔁 [join_room] 기존 닉네임({nickname})으로 재접속 처리")

          # 같은 닉네임으로 이미 붙어있는 다른 활성 연결이 있으면 정리 (reconnect_room과 동일 정책)
          old_sids = [
              s for s, info in sid_to_room.items()
              if info.get("room_id") == room_id and info.get("nickname") == nickname and s != sid
          ]
          for old_sid in old_sids:
              logger.info(f"🔁 [join_room] {nickname}의 기존 세션(sid={old_sid}) 종료 - 재접속으로 대체됨")
              await sio.emit("duplicate_session", {"msg": "다른 곳에서 새로 접속되어 이전 연결이 종료되었습니다."}, to=old_sid)
              await sio.leave_room(old_sid, room_id)
              if old_sid in sid_to_room:
                  del sid_to_room[old_sid]

          sid_to_room[sid] = {"room_id": room_id, "nickname": nickname}
          await sio.enter_room(sid, room_id)

          gm = room_data.get("gm")

          # 진짜 방장이 재접속하면 임시 방장 권한 자동 회수
          if nickname == gm and room_data.get("temp_gm"):
              logger.info(f"👑 [join_room] 방장({nickname}) 재접속 → 임시 방장({room_data['temp_gm']}) 권한 회수")
              room_data["temp_gm"] = None

          # 재접속한 본인에게 최신 방 상태를 room_joined로 전달 (room.html에서 후속 처리)
          await sio.emit(
              "room_joined",
              {
                  "room_id": room_id,
                  "users": room_data["users"],
                  "gm": gm,
                  "temp_gm": room_data.get("temp_gm"),
                  "selections": room_data["selections"],
                  "characters": room_data["characters"],
                  "game_state": room_data["game_state"],
                  "scenario_id": room_data["scenario_id"],
                  "my_note": room_data.get("player_notes", {}).get(nickname, "")
              },
              to=sid
          )
          await emit_room_state_func(sio, room_id, gm)
          return

      # 1. 소켓 룸에 입장시키기
      await sio.enter_room(sid, room_id)

      # 2. 유저 정보 등록
      room_data["users"].append(nickname)
      room_data["selections"][nickname] = None
      sid_to_room[sid] = {"room_id": room_id, "nickname": nickname}

      gm = room_data["gm"]

      # 3. [개인 응답] 새로 들어온 사람 본인에게만 'room_joined' 보내서 화면 넘기기
      await sio.emit(
          "room_joined",
          {
              "room_id": room_id,
              "users": room_data["users"],
              "gm": gm,
              "temp_gm": room_data.get("temp_gm"),
              "selections": room_data["selections"],
              "characters": room_data["characters"],
              "game_state": room_data["game_state"],
              "scenario_id": room_data["scenario_id"],
              "my_note": room_data.get("player_notes", {}).get(nickname, "")
          },
          to=sid  # 본인에게만!
      )
      
      # 4. [전체 공지] 방에 있는 *모든 사람(방장 포함)*에게 'update_room_state' 쏴서 목록 갱신시키기
      await sio.emit(
          "update_room_state",
          {
              "users": room_data["users"],
              "gm": gm,
              "temp_gm": room_data.get("temp_gm"),
              "selections": room_data["selections"],
              "game_state": room_data["game_state"],
              "scenario_id": room_data["scenario_id"]
          },
          room=room_id  # 방 전체 브로드캐스트!
      )


  @sio.event
  async def reconnect_room(sid, data):
    room_id = data.get("room_id")
    nickname = data.get("nickname")

    if room_id in rooms:
      room_data = rooms[room_id]

      # 등록된 적 없는 닉네임이면 차단 (세션스토리지 조작이나 URL 직접 접근으로 우회 방지)
      if nickname not in room_data["users"]:
          logger.warning(f"🚫 [reconnect_room] 등록되지 않은 닉네임({nickname})의 접근 차단")
          await sio.emit("room_destroyed", to=sid)
          return

      # 같은 방+같은 닉네임으로 이미 연결돼 있는 다른 세션(sid)이 있다면 강제 종료
      # (같은 닉네임으로 탭을 여러 개 열어서 생기는 sid 꼬임 방지)
      old_sids = [
          s for s, info in sid_to_room.items()
          if info.get("room_id") == room_id and info.get("nickname") == nickname and s != sid
      ]
      for old_sid in old_sids:
          logger.info(f"🔁 [reconnect_room] {nickname}의 기존 세션(sid={old_sid}) 종료 - 새 연결로 대체됨")
          await sio.emit("duplicate_session", {"msg": "다른 곳에서 새로 접속되어 이전 연결이 종료되었습니다."}, to=old_sid)
          await sio.leave_room(old_sid, room_id)
          if old_sid in sid_to_room:
              del sid_to_room[old_sid]

      # 만약 이미 참여했던 유저이거나, 혹은 새로 들어온 사람이 방 스냅샷을 요청할 때
      sid_to_room[sid] = {"room_id": room_id, "nickname": nickname}
      await sio.enter_room(sid, room_id)
      logger.info(f"🔌 [reconnect_room] {nickname} → 방 '{room_id}' 소켓 룸 입장 완료")
      
      gm = room_data.get("gm") or (room_data["users"][0] if room_data["users"] else None)

      # 진짜 방장이 재접속하면 임시 방장 권한 자동 회수
      if nickname == gm and room_data.get("temp_gm"):
          logger.info(f"👑 [reconnect_room] 방장({nickname}) 재접속 → 임시 방장({room_data['temp_gm']}) 권한 회수")
          room_data["temp_gm"] = None

      # [핵심] 방 전체의 최신 스냅샷을 통째로 전송!
      await sio.emit(
          "room_snapshot_sync", # 프론트가 받을 이벤트 이름
          {
              "room_id": room_id,
              "users": room_data["users"],
              "gm": gm,
              "temp_gm": room_data.get("temp_gm"),
              "selections": room_data["selections"],
              "characters": room_data["characters"],
              "game_state": room_data.get("game_state"),
              "scenario_id": room_data.get("scenario_id"),
              "my_note": room_data.get("player_notes", {}).get(nickname, ""),
              # 본인이 이미 제출한 후기/MVP 값이 있으면 같이 보내줌 (재접속해도 폼이 비어보이지 않게)
              # to=sid로 본인에게만 가는 이벤트라 다른 사람 응답은 여전히 노출 안 됨
              "my_feedback": room_data.get("feedback", {}).get(nickname),
              "my_mvp_vote": room_data.get("mvp_votes", {}).get(nickname),
          },
          to=sid
      )
      
      # 방 전체에도 "누가 재접속했다" 또는 최신 상태 갱신 알림
      await emit_room_state_func(sio, room_id, gm)
    else:
      await sio.emit("room_destroyed", to=sid)

  @sio.event
  async def transfer_gm(sid, data):
    room_id = data.get("room_id")
    nickname = data.get("nickname")          # 요청자 (현재 방장이어야 함)
    target_nickname = data.get("target_nickname")  # 위임받을 사람

    if room_id not in rooms:
      await sio.emit("error", {"msg": "존재하지 않는 방입니다."}, to=sid)
      return

    room_data = rooms[room_id]
    current_gm = room_data.get("gm")

    if nickname != current_gm:
      await sio.emit("error", {"msg": "방장만 방장 권한을 위임할 수 있습니다."}, to=sid)
      return

    if target_nickname not in room_data["users"]:
      await sio.emit("error", {"msg": "해당 유저를 찾을 수 없습니다."}, to=sid)
      return

    if target_nickname == current_gm:
      return

    room_data["gm"] = target_nickname
    await emit_room_state_func(sio, room_id, target_nickname)

  @sio.event
  async def kick_user(sid, data):
    room_id = data.get("room_id")
    nickname = data.get("nickname")                # 요청자 (방장이어야 함)
    target_nickname = data.get("target_nickname")   # 강퇴 대상

    if room_id not in rooms:
      await sio.emit("error", {"msg": "존재하지 않는 방입니다."}, to=sid)
      return

    room_data = rooms[room_id]
    gm = room_data.get("gm")

    if nickname != gm:
      await sio.emit("error", {"msg": "방장만 유저를 강퇴할 수 있습니다."}, to=sid)
      return

    if target_nickname == gm:
      await sio.emit("error", {"msg": "자기 자신은 강퇴할 수 없습니다."}, to=sid)
      return

    if target_nickname not in room_data["users"]:
      await sio.emit("error", {"msg": "해당 유저를 찾을 수 없습니다."}, to=sid)
      return

    # 강퇴 대상의 sid 찾기 (같은 닉네임으로 여러 탭이 열려있을 수 있으므로 전부 수집)
    target_sids = [
      s for s, info in sid_to_room.items()
      if info.get("room_id") == room_id and info.get("nickname") == target_nickname
    ]

    logger.info(f"👢 [kick_user] target_nickname={target_nickname} → target_sids={target_sids} (sid_to_room 크기: {len(sid_to_room)})")

    # 방 데이터에서 제거
    room_data["users"].remove(target_nickname)
    if target_nickname in room_data["selections"]:
      del room_data["selections"][target_nickname]

    # 강퇴당한 사람이 임시 방장이었다면 그 자격도 소멸
    if room_data.get("temp_gm") == target_nickname:
      room_data["temp_gm"] = None

    if len(room_data["users"]) == 0:
      del rooms[room_id]
    else:
      if room_data.get("gm") == target_nickname or room_data.get("gm") not in room_data["users"]:
        room_data["gm"] = room_data["users"][0]
        room_data["temp_gm"] = None
      await emit_room_state_func(sio, room_id, room_data["gm"])

    # 강퇴당한 유저에게 알림 후 소켓 룸에서 정리 (매칭된 sid 전부 처리)
    if target_sids:
      for target_sid in target_sids:
        await sio.emit("kicked", {"msg": "방장에 의해 강퇴되었습니다."}, to=target_sid)
        await sio.leave_room(target_sid, room_id)
        if target_sid in sid_to_room:
          del sid_to_room[target_sid]
    else:
      logger.warning(f"⚠️ [kick_user] {target_nickname}의 sid를 찾지 못해 'kicked' 이벤트를 못 보냄")

  @sio.event
  async def update_note(sid, data):
    """개인 메모 저장 - 본인 것만, 서버에만 저장되고 다른 사람에게는 절대 전파되지 않음"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    text = data.get("text", "")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]

    if nickname not in room_data["users"]:
      return

    # 너무 긴 메모로 서버 메모리를 낭비하지 않도록 안전장치
    if len(text) > 20000:
      text = text[:20000]

    room_data.setdefault("player_notes", {})[nickname] = text