from .room_handler import rooms
from backend.services.phases import is_investigation_phase, investigation_limit
from backend.logging_setup import get_logger

logger = get_logger(__name__)


async def _check_aversion(sio, sid, room_data, obj, new_owner_nickname):
  """직접 획득(claim_object)으로 소유자가 된 경우 - 거부감 대상 캐릭터 본인에게만 알림.
  (혼자 조사해서 얻은 거라 다른 사람에게 알릴 대상이 없음)"""
  aversion_character = obj.get("aversion_character")
  if not aversion_character:
    return
  new_owner_character = room_data["selections"].get(new_owner_nickname)
  if new_owner_character == aversion_character:
    messages = obj.get("aversion_messages") or {}
    message = messages.get("claim_owner") or obj.get("aversion_message") or "당신은 이 아이템에 거부감을 느낍니다."
    await sio.emit("item_aversion", {"object_id": obj.get("id"), "msg": message}, to=sid)


def register_object_handlers(sio, emit_room_state_func):

  @sio.event
  async def claim_object(sid, data):
    """보드에 있는 오브젝트를 클릭해서 내 인벤토리로 가져오기 (조사 시간에만 가능)"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    object_id = data.get("object_id")

    logger.info(f"📦 [claim_object 수신] room_id={room_id}, nickname={nickname}, object_id={object_id}")

    if room_id not in rooms:
      return

    room_data = rooms[room_id]

    if nickname not in room_data["users"]:
      await sio.emit("kicked", {"msg": "더 이상 이 방의 참여자가 아닙니다."}, to=sid)
      return

    if nickname == room_data.get("gm"):
      await sio.emit("error", {"msg": "진행자는 단서를 수집할 수 없습니다."}, to=sid)
      return

    game_state = room_data.get("game_state", {})
    phases = game_state.get("phases", [])
    current_phase = game_state.get("phase", 1)

    objects = game_state.get("objects", {})
    obj = objects.get(object_id)

    if obj is None:
      logger.warning(f"⚠️ [claim_object] 존재하지 않는 오브젝트 id={object_id}")
      return

    my_character = room_data["selections"].get(nickname)

    # 자신의 처소(소지품/증거/증언)는 본인이 직접 조사할 수 없음
    if obj.get("group") == "location":
      char_location = obj.get("character_location") or ""
      if my_character and my_character in char_location:
        await sio.emit("error", {"msg": "자신의 처소에 있는 물건은 스스로 조사할 수 없습니다."}, to=sid)
        return

    is_investigation = is_investigation_phase(phases, current_phase)
    exclusive_character = obj.get("exclusive_character")
    exclusive_phase = obj.get("exclusive_phase")

    is_exclusive_phase_now = (
        exclusive_character is not None
        and exclusive_phase is not None
        and current_phase == exclusive_phase
    )

    if is_exclusive_phase_now:
      # 지정된 페이즈에는 조사 시간 여부와 상관없이 지정된 캐릭터만 획득 가능 (다른 사람은 그 페이즈 내내 잠김)
      if my_character != exclusive_character:
        await sio.emit("error", {"msg": f"이 오브젝트는 지금 '{exclusive_character}'만 확인할 수 있습니다."}, to=sid)
        return
      # exclusive_character 본인이면 조사 시간이 아니어도 통과하고 아래 일반 로직으로 진행
    elif not is_investigation:
      await sio.emit("error", {"msg": "조사 시간이 아닙니다. 지금은 단서를 수집할 수 없습니다."}, to=sid)
      return


    if obj["owner"] is not None:
      # 이미 누군가 가져간 오브젝트 - 조용히 무시 (동시 클릭 대비)
      logger.warning(f"🚫 [claim_object] 이미 {obj['owner']}가 소유 중인 오브젝트")
      return

    # 인터뷰 카드는 자신(캐릭터)이 화자인 것을 스스로 가져갈 수 없음
    if obj.get("group") == "interview":
      my_character = room_data["selections"].get(nickname)
      if obj.get("speaker") == my_character:
        await sio.emit("error", {"msg": "자신이 한 말은 단서로 선택할 수 없습니다."}, to=sid)
        return

    # 이번 조사 시간에 이미 가져간 개수 확인 (시나리오별 페이즈 설정의 claim_limit)
    limit = investigation_limit(phases, current_phase)
    if limit is not None:
      claimed_this_phase = sum(
          1 for o in objects.values()
          if o.get("owner") == nickname and o.get("claimed_phase") == current_phase
      )
      if claimed_this_phase >= limit:
        await sio.emit("error", {"msg": f"이번 조사 시간에는 최대 {limit}개까지만 가져갈 수 있습니다."}, to=sid)
        return

    # 시나리오 전용 그룹별 획득 제한 (예: 이 시나리오의 내월당 규칙) - phases.json의 group_limits에서 정의
    group_limits = game_state.get("group_limits", [])
    obj_group = obj.get("group")
    rule = next((r for r in group_limits if r.get("group") == obj_group), None)

    if rule:
      per_phase_cap = rule.get("per_investigation_phase")
      if per_phase_cap is not None:
        count_this_phase = sum(
            1 for o in objects.values()
            if o.get("owner") == nickname and o.get("group") == obj_group and o.get("claimed_phase") == current_phase
        )
        if count_this_phase >= per_phase_cap:
          await sio.emit("error", {"msg": f"{obj_group} 단서는 조사 시간당 {per_phase_cap}개까지만 가져올 수 있습니다."}, to=sid)
          return

      total_cap = rule.get("total")
      if total_cap is not None:
        count_total = sum(
            1 for o in objects.values()
            if o.get("owner") == nickname and o.get("group") == obj_group
        )
        if count_total >= total_cap:
          await sio.emit("error", {"msg": f"{obj_group} 단서는 한 명당 최대 {total_cap}개까지만 가질 수 있습니다."}, to=sid)
          return

    obj["owner"] = nickname
    obj["revealed"] = True
    obj["viewed"] = False
    obj["claimed_phase"] = current_phase
    logger.info(f"✅ [claim_object] {nickname}가 오브젝트(id={object_id}) 획득 (phase={current_phase})")

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)

  @sio.event
  async def mark_object_viewed(sid, data):
    """인벤토리에서 오브젝트를 확대해서 뒷면을 확인했을 때 서버에 기록 (되돌려놓기 가능 여부 판단용)"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    object_id = data.get("object_id")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    objects = room_data.get("game_state", {}).get("objects", {})
    obj = objects.get(object_id)

    if obj is None or obj.get("owner") != nickname:
      return

    if not obj.get("viewed"):
      obj["viewed"] = True
      logger.info(f"👁️ [mark_object_viewed] {nickname}가 오브젝트(id={object_id}) 뒷면 확인")
      await _check_aversion(sio, sid, room_data, obj, nickname)
      gm = room_data.get("gm")
      await emit_room_state_func(sio, room_id, gm)

  @sio.event
  async def unclaim_object(sid, data):
    """아직 뒷면을 확인하지 않은 오브젝트를 다시 보드로 돌려놓기 - 조사 시간에만 가능"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    object_id = data.get("object_id")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    game_state = room_data.get("game_state", {})
    phases = game_state.get("phases", [])

    if not is_investigation_phase(phases, game_state.get("phase", 1)):
      await sio.emit("error", {"msg": "조사 시간에만 오브젝트를 다시 돌려놓을 수 있습니다."}, to=sid)
      return

    obj = game_state.get("objects", {}).get(object_id)
    if obj is None or obj.get("owner") != nickname:
      return

    if obj.get("viewed"):
      await sio.emit("error", {"msg": "이미 확인한 오브젝트는 되돌려놓을 수 없습니다."}, to=sid)
      return

    obj["owner"] = None
    obj["revealed"] = False
    obj["claimed_phase"] = None
    logger.info(f"↩️ [unclaim_object] {nickname}가 오브젝트(id={object_id})를 다시 보드로 돌려놓음")

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)