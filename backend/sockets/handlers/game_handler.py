import random
import time
from .room_handler import rooms
from backend.services.scenario_loader import build_default_inventory_items
from backend.services.phases import investigation_limit
from backend.logging_setup import get_logger

logger = get_logger(__name__)


def register_game_handlers(sio, emit_room_state_func):

  @sio.event
  async def select_character(sid, data):
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    char_name = data.get("char_name")

    logger.info(f"🎭 [select_character 수신] room_id={room_id}, nickname={nickname}, char_name={char_name}")

    if room_id not in rooms:
      logger.warning(f"⚠️ [select_character] 존재하지 않는 방: {room_id}")
      return

    room_data = rooms[room_id]

    if nickname not in room_data["users"]:
      logger.warning(f"🚫 [select_character] 방에 없는 유저의 요청 차단: {nickname} (강퇴/퇴장된 유저일 가능성) → kicked 재전송")
      await sio.emit("kicked", {"msg": "더 이상 이 방의 참여자가 아닙니다."}, to=sid)
      return

    if nickname == room_data.get("gm"):
      logger.warning(f"🚫 [select_character] 진행자({nickname})는 캐릭터를 선택할 수 없음")
      await sio.emit("error", {"msg": "진행자는 캐릭터를 선택할 수 없습니다."}, to=sid)
      return

    if room_data["selections"].get(nickname) == char_name:
      room_data["selections"][nickname] = None
      logger.info(f"↩️ [select_character] {nickname}의 선택 해제됨")
    else:
      room_data["selections"][nickname] = char_name
      logger.info(f"✅ [select_character] {nickname} → {char_name} 선택됨. 현재 selections: {room_data['selections']}")

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)

  @sio.event
  async def random_assign(sid, data):
    room_id = data.get("room_id")
    nickname = data.get("nickname")

    if room_id in rooms:
      room_data = rooms[room_id]
      gm = room_data.get("gm")

      if nickname != gm:
        await sio.emit("error", {"msg": "방장만 랜덤 선택을 실행할 수 있습니다."}, to=sid)
        return

      users = [u for u in room_data["users"] if u != gm]  # GM은 캐릭터를 갖지 않으므로 배정 대상에서 제외
      character_pool = [c["name"] for c in room_data["characters"]]

      if not character_pool or not users:
        return

      # 기존 선택 상태를 전부 초기화하고 새로 배정
      if len(character_pool) >= len(users):
        # 인원수만큼 중복 없이 무작위 배정
        assigned = random.sample(character_pool, len(users))
      else:
        # 캐릭터 수보다 인원이 많으면 어쩔 수 없이 중복 허용
        assigned = [random.choice(character_pool) for _ in users]

      room_data["selections"] = {user: char for user, char in zip(users, assigned)}

      await emit_room_state_func(sio, room_id, gm)

  @sio.event
  async def next_phase(sid, data):
    room_id = data.get("room_id")
    nickname = data.get("nickname")

    if room_id in rooms:
      room_data = rooms[room_id]
      gm = room_data.get("gm")

      if nickname != gm:
        return

      selections = room_data["selections"]
      all_selected = all(char is not None for char in selections.values())

      if not all_selected:
        await sio.emit("error", {"msg": "모든 참여자가 캐릭터를 선택해야 다음 단계로 넘어갈 수 있습니다!"}, to=sid)
        return

      chosen_chars = list(selections.values())
      has_duplicate = len(chosen_chars) != len(set(chosen_chars))

      if has_duplicate:
        await sio.emit("error", {"msg": "캐릭터가 겹친 참여자가 있습니다! 모두 다른 캐릭터를 선택해야 합니다."}, to=sid)
        return

      if room_data["game_state"].get("started"):
        # 이미 시작된 게임 - 중복 지급 방지
        logger.warning(f"⚠️ [next_phase] 이미 시작된 게임에 대한 중복 요청 무시: room_id={room_id}")
        return

      # 각 참여자에게 기본 인벤토리 아이템(시나리오 정보 + 캐릭터 설정집) 지급
      scenario_id = room_data.get("scenario_id", "scenario_01")
      objects = room_data["game_state"]["objects"]
      next_id = max(objects.keys(), default=0) + 1

      for user_nickname, char_name in selections.items():
        new_items, next_id = build_default_inventory_items(scenario_id, user_nickname, char_name, next_id)
        objects.update(new_items)
        logger.info(f"🎒 [next_phase] {user_nickname}({char_name})에게 기본 아이템 {len(new_items)}개 지급")

      # GM은 캐릭터가 없으니 설정집/지도는 빼고, 시나리오 정보 + 룰북만 지급
      gm_nickname = room_data.get("gm")
      if gm_nickname:
        gm_items, next_id = build_default_inventory_items(
            scenario_id, gm_nickname, None, next_id,
            include_sheet=False, include_map=False, include_rulebook=True,
        )
        objects.update(gm_items)
        logger.info(f"🎒 [next_phase] GM({gm_nickname})에게 기본 아이템 {len(gm_items)}개 지급 (정보+룰북)")

      room_data["game_state"]["started"] = True
      room_data["game_state"]["phase_started_at"] = time.time()
      await sio.emit("start_game_phase", {"selections": selections}, room=room_id)

  @sio.event
  async def advance_phase(sid, data):
    """GM이 '다음 단계로 넘어가기'를 눌렀을 때 게임 페이즈를 진행. 시간이 다 돼도 자동으로는 안 넘어감."""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    force = bool(data.get("force"))  # 미수집 경고를 보고도 GM이 강행하기로 한 경우 True

    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    gm = room_data.get("gm")
    temp_gm = room_data.get("temp_gm")

    # 진짜 방장 또는 (방장이 끊긴 동안의) 임시 방장만 페이즈를 넘길 수 있음
    if nickname != gm and nickname != temp_gm:
      await sio.emit("error", {"msg": "방장만 다음 단계로 넘길 수 있습니다."}, to=sid)
      return

    game_state = room_data["game_state"]
    current_phase = game_state.get("phase", 1)
    phases = game_state.get("phases", [])

    if current_phase >= len(phases):
      await sio.emit("error", {"msg": "이미 마지막 단계입니다."}, to=sid)
      return

    # 이번 페이즈가 조사 시간이고 획득 한도(claim_limit)가 정해져 있으면,
    # 한도까지 단서를 못 모은 사람이 있는지 확인 (phases.py 기반 공통 로직 - 어떤 시나리오든 동일하게 적용)
    limit = investigation_limit(phases, current_phase)
    if limit is not None and not force:
      objects = game_state.get("objects", {})
      incomplete = []
      for user in room_data["selections"].keys():  # GM은 캐릭터/단서가 없으므로 selections 기준 (자동 제외됨)
        claimed = sum(
            1 for o in objects.values()
            if o.get("owner") == user and o.get("claimed_phase") == current_phase
        )
        if claimed < limit:
          incomplete.append({"nickname": user, "claimed": claimed, "limit": limit})

      if incomplete:
        logger.warning(f"⚠️ [advance_phase] 단서를 다 모으지 못한 참여자 있음: {incomplete}")
        await sio.emit("phase_advance_incomplete", {"incomplete": incomplete}, to=sid)
        return

    # 페이즈가 바뀌면 그 순간 진행 중이던 밀담은 전부 종료 (대여 중인 오브젝트도 자동 회수)
    conversations = game_state.get("conversations", {})
    if conversations:
      for conv in conversations.values():
        participants = conv["participants"]
        for obj in game_state.get("objects", {}).values():
          if obj.get("owner") in participants and obj.get("loaned_to") in participants:
            obj["loaned_to"] = None
      game_state["conversations"] = {}
      game_state["pending_invites"] = {}
      logger.info(f"🤐 [advance_phase] 페이즈 전환으로 진행 중이던 밀담 전체 종료")

    game_state["phase"] = current_phase + 1
    game_state["phase_started_at"] = time.time()
    game_state["interrogation_used_this_phase"] = False  # 심문 quota는 페이즈마다 초기화 (심문 성공 기록은 유지)
    room_data["pending_interrogation"] = None  # 응답 안 된 심문 요청이 페이즈 넘어 이월되지 않도록 정리
    logger.info(f"⏭️ [advance_phase] {current_phase} → {game_state['phase']}페이즈로 진행")

    await emit_room_state_func(sio, room_id, gm)