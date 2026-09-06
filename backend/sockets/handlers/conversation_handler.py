import uuid
from .room_handler import rooms, sid_to_room
from backend.services.phases import is_investigation_phase
from backend.logging_setup import get_logger

logger = get_logger(__name__)


async def _check_special_reaction(sio, room_id, room_data, obj, target_nickname, trigger):
  """오브젝트에 special_reactions(캐릭터별 맞춤 알림)가 지정돼 있으면, 대상자에게만 해당 트리거의 문구를 전송.
  trigger: "on_show"(밀담 중 보여주기로 봤을 때) / "on_give"(건네받아 실제 소유하게 됐을 때)"""
  reactions = obj.get("special_reactions") or {}
  target_character = room_data["selections"].get(target_nickname)
  char_reactions = reactions.get(target_character)
  if not char_reactions:
    return
  message = char_reactions.get(trigger)
  if not message:
    return

  target_sids = [
      s for s, info in sid_to_room.items()
      if info.get("room_id") == room_id and info.get("nickname") == target_nickname
  ]
  for target_sid in target_sids:
    await sio.emit("item_notice", {"object_id": obj.get("id"), "msg": message}, to=target_sid)


async def _check_owner_reaction(sio, room_id, room_data, obj, actor_nickname, partner_nickname):
  """오브젝트에 owner_character(이 아이템을 원래 갖고 있어야 자연스러운 캐릭터)가 지정돼 있고,
  지금 이걸 보여주거나 건네려는 사람이 실제로 그 캐릭터이면서, 상대방이 owner_reaction_targets에
  해당하는 캐릭터일 때 - 시도한 본인(소유자)에게 '상대방에게서 낌새를 느꼈다'는 알림을 보냄.
  (보여주기/건네기 둘 다 트리거되는 시점에 호출 - 실제로 완료됐는지와 무관하게 시도 자체로 발동)"""
  owner_character = obj.get("owner_character")
  reaction_targets = obj.get("owner_reaction_targets") or []
  message = obj.get("owner_reaction_message")
  if not owner_character or not reaction_targets or not message:
    return

  actor_character = room_data["selections"].get(actor_nickname)
  partner_character = room_data["selections"].get(partner_nickname)
  if actor_character != owner_character or partner_character not in reaction_targets:
    return

  await _emit_to_nickname(sio, room_id, actor_nickname, "item_notice", {"object_id": obj.get("id"), "msg": message})


async def _emit_to_nickname(sio, room_id, target_nickname, event_name, payload):
  """특정 닉네임의 현재 살아있는 소켓(들)에 개인 이벤트 전송"""
  target_sids = [
      s for s, info in sid_to_room.items()
      if info.get("room_id") == room_id and info.get("nickname") == target_nickname
  ]
  for target_sid in target_sids:
    await sio.emit(event_name, payload, to=target_sid)


async def _check_aversion(sio, room_id, room_data, obj, trigger, owner_nickname, other_nickname=None):
  """오브젝트에 aversion_character(특정 캐릭터가 거부감을 느끼는 규칙)가 지정돼 있고
  owner_nickname의 캐릭터가 그 대상이면, 상황(trigger)에 맞는 문구로 알림을 보냄.

  trigger: "give"(밀담으로 건네받아 실제 소유하게 됨 - 본인+건넨 사람 둘 다 알림)
           "show"(밀담 중 보여주기=감별 시도 - 본인+밀담 상대 둘 다 알림)
  owner_nickname: 거부감 대상 캐릭터(예: 설화) 역할을 맡은 사람
  other_nickname: 건넨 사람 / 밀담 상대방 (같이 알림 받을 대상)
  """
  aversion_character = obj.get("aversion_character")
  if not aversion_character:
    return
  owner_character = room_data["selections"].get(owner_nickname)
  if owner_character != aversion_character:
    return

  messages = obj.get("aversion_messages") or {}
  owner_msg = messages.get(f"{trigger}_owner") or obj.get("aversion_message") or "당신은 이 아이템에 거부감을 느낍니다."
  other_msg = messages.get(f"{trigger}_other")

  await _emit_to_nickname(sio, room_id, owner_nickname, "item_aversion", {"object_id": obj.get("id"), "msg": owner_msg})
  if other_nickname and other_msg:
    await _emit_to_nickname(sio, room_id, other_nickname, "item_aversion", {"object_id": obj.get("id"), "msg": other_msg})


def _find_active_conversation(game_state, nickname):
  """nickname이 참여 중인 활성 밀담을 찾아 (conv_id, conv_data)를 반환. 없으면 (None, None)."""
  for conv_id, conv in game_state.get("conversations", {}).items():
    if nickname in conv["participants"]:
      return conv_id, conv
  return None, None


def _is_ending_revealed(game_state):
  """마지막 페이즈(결과 발표 등)에 도달했으면 True - 이 시점부터 전원 공개 모드"""
  phases = game_state.get("phases", [])
  return len(phases) > 0 and game_state.get("phase", 1) >= len(phases)


def register_conversation_handlers(sio, emit_room_state_func):

  @sio.event
  async def invite_conversation(sid, data):
    """상대 캐릭터에게 밀담을 신청. 서로 클릭하면(상호 신청) 밀담이 자동 시작됨."""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    target_nickname = data.get("target_nickname")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    game_state = room_data["game_state"]

    if nickname not in room_data["users"] or target_nickname not in room_data["users"]:
      return
    if nickname == target_nickname:
      return

    phases = game_state.get("phases", [])
    if not is_investigation_phase(phases, game_state.get("phase", 1)):
      await sio.emit("error", {"msg": "밀담은 조사 시간에만 신청할 수 있습니다."}, to=sid)
      return

    if _find_active_conversation(game_state, nickname)[0] is not None:
      await sio.emit("error", {"msg": "이미 밀담 중입니다. 먼저 종료해주세요."}, to=sid)
      return
    if _find_active_conversation(game_state, target_nickname)[0] is not None:
      await sio.emit("error", {"msg": "상대방이 이미 다른 밀담 중입니다."}, to=sid)
      return

    pending = game_state.setdefault("pending_invites", {})
    pending[nickname] = target_nickname
    logger.info(f"🤫 [invite_conversation] {nickname} → {target_nickname} 밀담 신청")

    # 상대방도 나를 신청했다면(서로 클릭) 밀담 시작
    if pending.get(target_nickname) == nickname:
      conv_id = str(uuid.uuid4())[:8]
      game_state.setdefault("conversations", {})[conv_id] = {
          "participants": [nickname, target_nickname],
          "phase": game_state.get("phase", 1),
      }
      pending.pop(nickname, None)
      pending.pop(target_nickname, None)
      logger.info(f"🗣️ [invite_conversation] 밀담 시작: {nickname} ↔ {target_nickname}")

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)

  @sio.event
  async def cancel_invite(sid, data):
    """내가 보낸 밀담 신청 취소"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    game_state = room_data["game_state"]
    game_state.get("pending_invites", {}).pop(nickname, None)

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)

  @sio.event
  async def end_conversation(sid, data):
    """밀담 종료 - 참여자 본인만 가능. 빌려준 오브젝트는 자동 회수."""
    room_id = data.get("room_id")
    nickname = data.get("nickname")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    game_state = room_data["game_state"]

    conv_id, conv = _find_active_conversation(game_state, nickname)
    if conv_id is None:
      return

    participants = conv["participants"]

    # 밀담 중 서로 대여했던 오브젝트를 원래 소유자에게 자동 반환
    for obj in game_state.get("objects", {}).values():
      if obj.get("owner") in participants and obj.get("loaned_to") in participants:
        obj["loaned_to"] = None

    del game_state["conversations"][conv_id]
    logger.info(f"🤐 [end_conversation] {nickname}가 밀담 종료: {participants}")

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)

  @sio.event
  async def show_object_to_partner(sid, data):
    """밀담 중 내 오브젝트를 상대방 인벤토리로 잠깐 보여주기"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    object_id = data.get("object_id")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    game_state = room_data["game_state"]

    conv_id, conv = _find_active_conversation(game_state, nickname)
    if conv_id is None:
      await sio.emit("error", {"msg": "밀담 중이 아닙니다."}, to=sid)
      return

    partner = next((p for p in conv["participants"] if p != nickname), None)
    if partner is None:
      return

    obj = game_state.get("objects", {}).get(object_id)
    if obj is None or obj.get("owner") != nickname:
      return

    # 캐릭터 설정집은 엔딩(마지막 페이즈)에 도달하기 전까지 밀담으로도 공유할 수 없음
    if obj.get("group") == "default_sheet" and not _is_ending_revealed(game_state):
      await sio.emit("error", {"msg": "캐릭터 설정집은 엔딩 전까지 다른 사람에게 공개할 수 없습니다."}, to=sid)
      return

    # 아직 확인(뒷면 열람)하지 않아 보드로 되돌려놓을 수 있는 아이템은 완전히 내 인벤토리에 들어온 게 아니므로 공유 불가
    if not obj.get("viewed"):
      await sio.emit("error", {"msg": "아직 확인하지 않아 되돌려놓을 수 있는 아이템은 보여줄 수 없습니다. 먼저 확인해주세요."}, to=sid)
      return

    obj["loaned_to"] = partner
    await _check_aversion(sio, room_id, room_data, obj, "show", partner)
    await _check_special_reaction(sio, room_id, room_data, obj, partner, "on_show")
    await _check_owner_reaction(sio, room_id, room_data, obj, nickname, partner)
    logger.info(f"👀 [show_object_to_partner] {nickname} → {partner}에게 오브젝트(id={object_id}) 공개")

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)

  @sio.event
  async def give_item_to_partner(sid, data):
    """밀담 중 '양도 가능(transferable)'으로 지정된 특별 아이템의 소유권을 완전히 상대에게 넘기기.
    show_object_to_partner(임시로 보여주기)와 달리 진짜로 주인이 바뀜 - 되돌리려면 상대가 다시 건네줘야 함."""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    object_id = data.get("object_id")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    game_state = room_data["game_state"]

    conv_id, conv = _find_active_conversation(game_state, nickname)
    if conv_id is None:
      await sio.emit("error", {"msg": "밀담 중이 아닙니다."}, to=sid)
      return

    partner = next((p for p in conv["participants"] if p != nickname), None)
    if partner is None:
      return

    obj = game_state.get("objects", {}).get(object_id)
    if obj is None or obj.get("owner") != nickname:
      return

    if not obj.get("transferable"):
      await sio.emit("error", {"msg": "이 오브젝트는 소유권을 넘길 수 없습니다."}, to=sid)
      return

    # 아직 확인(뒷면 열람)하지 않아 보드로 되돌려놓을 수 있는 아이템은 완전히 내 인벤토리에 들어온 게 아니므로 양도 불가
    if not obj.get("viewed"):
      await sio.emit("error", {"msg": "아직 확인하지 않아 되돌려놓을 수 있는 아이템은 건네줄 수 없습니다. 먼저 확인해주세요."}, to=sid)
      return

    obj["owner"] = partner
    obj["loaned_to"] = None  # 대여 중이었다면 정리 (이제 상대방이 진짜 주인이므로 의미 없음)
    await _check_aversion(sio, room_id, room_data, obj, "give", partner, other_nickname=nickname)
    await _check_special_reaction(sio, room_id, room_data, obj, partner, "on_give")
    logger.info(f"🎁 [give_item_to_partner] {nickname} → {partner}에게 오브젝트(id={object_id}) 소유권 이전")

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)

  @sio.event
  async def return_object(sid, data):
    """빌려본 오브젝트를 원래 소유자에게 돌려주기 - 빌린 사람만 가능"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    object_id = data.get("object_id")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    game_state = room_data["game_state"]

    obj = game_state.get("objects", {}).get(object_id)
    if obj is None or obj.get("loaned_to") != nickname:
      return

    obj["loaned_to"] = None
    logger.info(f"↩️ [return_object] {nickname}가 오브젝트(id={object_id}) 반환")

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)

  # ── 이윤 전용: 심문 (조사 페이즈당 1회, GM 승인 필요, 강제 밀담 생성) ─────────────────────────────

  @sio.event
  async def request_interrogation(sid, data):
    """이윤이 다른 참여자를 심문 신청. 신청 즉시 이번 조사 시간 quota를 소모하고, GM에게만 승인 요청이 감."""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    target_nickname = data.get("target_nickname")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    game_state = room_data["game_state"]

    special_ability_config = room_data.get("special_ability_config")
    ability_character = (special_ability_config or {}).get("ability_character")

    if not special_ability_config or room_data["selections"].get(nickname) != ability_character:
      await sio.emit("error", {"msg": "이 시나리오에서는 심문 기능을 사용할 수 없습니다."}, to=sid)
      return

    phases = game_state.get("phases", [])
    if not is_investigation_phase(phases, game_state.get("phase", 1)):
      await sio.emit("error", {"msg": "심문은 조사 시간에만 신청할 수 있습니다."}, to=sid)
      return

    if target_nickname not in room_data["users"] or target_nickname == nickname:
      return

    if game_state.get("interrogation_used_this_phase"):
      await sio.emit("error", {"msg": "이번 조사 시간엔 이미 심문을 신청했습니다."}, to=sid)
      return

    if target_nickname in game_state.get("interrogated_targets", []):
      await sio.emit("error", {"msg": "이미 심문했던 대상입니다. 다시 지목할 수 없습니다."}, to=sid)
      return

    if room_data.get("pending_interrogation"):
      await sio.emit("error", {"msg": "이미 GM의 응답을 기다리는 중입니다."}, to=sid)
      return

    # 결과(수락/거절)와 무관하게 신청 즉시 이번 페이즈 quota 소모
    game_state["interrogation_used_this_phase"] = True
    room_data["pending_interrogation"] = {"requester": nickname, "target": target_nickname}
    logger.info(f"⚖️ [request_interrogation] {nickname} → {target_nickname} 심문 신청, GM 응답 대기")

    target_character = room_data["selections"].get(target_nickname)
    await _emit_to_nickname(sio, room_id, room_data.get("gm"), "interrogation_request", {
        "requester": nickname,
        "target": target_nickname,
        "target_character": target_character,
    })

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)

  @sio.event
  async def respond_interrogation(sid, data):
    """GM이 심문 신청을 수락/거절"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    decision = data.get("decision")  # "accept" / "reject"

    if room_id not in rooms:
      return
    room_data = rooms[room_id]

    if nickname != room_data.get("gm"):
      await sio.emit("error", {"msg": "방장만 심문을 승인/거절할 수 있습니다."}, to=sid)
      return

    pending = room_data.get("pending_interrogation")
    if not pending:
      return

    requester = pending["requester"]
    target = pending["target"]
    room_data["pending_interrogation"] = None
    game_state = room_data["game_state"]
    special_ability_config = room_data.get("special_ability_config") or {}

    if decision == "accept":
      # 요청자/대상이 각각 다른 밀담 중이었다면 강제 종료 (대여 중이던 오브젝트도 정리)
      # 대상(target)이 밀담 중이었다면, 그 상대방에게는 왜 밀담이 끊겼는지 알려줌
      for who in (requester, target):
        conv_id, conv = _find_active_conversation(game_state, who)
        if conv_id is not None:
          participants = conv["participants"]
          for obj in game_state.get("objects", {}).values():
            if obj.get("owner") in participants and obj.get("loaned_to") in participants:
              obj["loaned_to"] = None
          game_state["conversations"].pop(conv_id, None)

          if who == target:
            other_partner = next((p for p in participants if p != target), None)
            if other_partner:
              partner_msg = special_ability_config.get("partner_notice_message") or "밀담 상대가 심문에 끌려갔습니다."
              await _emit_to_nickname(sio, room_id, other_partner, "interrogation_partner_taken", {"msg": partner_msg})

      conv_id = str(uuid.uuid4())[:8]
      game_state.setdefault("conversations", {})[conv_id] = {
          "participants": [requester, target],
          "phase": game_state.get("phase", 1),
      }
      game_state.setdefault("interrogated_targets", []).append(target)
      logger.info(f"⚖️ [respond_interrogation] GM 수락 - {requester} ↔ {target} 강제 밀담 시작")

      accept_message = special_ability_config.get("accept_message") or "심문이 시작되었습니다."
      await _emit_to_nickname(sio, room_id, target, "interrogation_started", {"msg": accept_message})
    else:
      logger.info(f"⚖️ [respond_interrogation] GM 거절 - {requester}의 {target} 심문 신청")
      reject_message = special_ability_config.get("reject_message") or "이번 조사 시간엔 더 이상 심문할 수 없습니다."
      await _emit_to_nickname(sio, room_id, requester, "interrogation_rejected", {"msg": reject_message})

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)