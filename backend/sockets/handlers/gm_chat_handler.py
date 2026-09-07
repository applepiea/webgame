import time
from .room_handler import rooms, sid_to_room
from backend.logging_setup import get_logger

logger = get_logger(__name__)


def register_gm_chat_handlers(sio, emit_room_state_func):
  """GM과 참여자 사이의 1:1 텍스트 문의 채팅. 다른 참여자에겐 절대 안 보이고,
  GM은 참여자별 스레드를 따로 보며 답장할 수 있음. 음성 채널(전체)과는 별개 기능."""

  async def _emit_to_nickname(room_id, target_nickname, event_name, payload):
    target_sids = [
        s for s, info in sid_to_room.items()
        if info.get("room_id") == room_id and info.get("nickname") == target_nickname
    ]
    for target_sid in target_sids:
      await sio.emit(event_name, payload, to=target_sid)

  @sio.event
  async def send_gm_chat_message(sid, data):
    """참여자 → GM, 또는 GM → 특정 참여자. 둘 다 이 이벤트 하나로 처리하고,
    보낸 사람이 GM인지 아닌지로 방향을 판단함."""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    text = (data.get("text") or "").strip()

    if room_id not in rooms or not text:
      return
    room_data = rooms[room_id]
    gm = room_data.get("gm")

    if nickname == gm:
      # GM이 특정 참여자에게 보내는 경우 - 대상 지정 필수
      target_nickname = data.get("target_nickname")
      if not target_nickname or target_nickname not in room_data["users"]:
        return
      thread_owner = target_nickname
      sender_role = "gm"
    else:
      # 참여자가 GM에게 보내는 경우 - 자기 자신의 스레드에 남김
      if nickname not in room_data["users"]:
        return
      thread_owner = nickname
      sender_role = "player"

    threads = room_data.setdefault("gm_chat_threads", {})
    thread = threads.setdefault(thread_owner, [])
    message = {
        "sender_role": sender_role,
        "sender_nickname": nickname,
        "text": text,
        "at": time.time(),
    }
    thread.append(message)

    logger.info(f"💬 [send_gm_chat_message] thread={thread_owner} sender={nickname}({sender_role}): {text[:30]}")

    # 이 스레드 당사자(참여자)와 GM 둘 다에게 새 메시지 전달 (다른 참여자에겐 절대 안 감)
    payload = {"thread_owner": thread_owner, "message": message}
    await _emit_to_nickname(room_id, thread_owner, "gm_chat_message", payload)
    if gm and gm != thread_owner:
      await _emit_to_nickname(room_id, gm, "gm_chat_message", payload)

  @sio.event
  async def request_gm_chat_history(sid, data):
    """재접속/최초 진입 시 본인 관련 채팅 내역을 요청.
    참여자는 자기 스레드만, GM은 전체 스레드를 받음 (다른 사람 스레드는 서로 절대 못 봄)."""
    room_id = data.get("room_id")
    nickname = data.get("nickname")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    threads = room_data.get("gm_chat_threads", {})
    gm = room_data.get("gm")

    if nickname == gm:
      await sio.emit("gm_chat_history", {"threads": threads}, to=sid)
    else:
      await sio.emit("gm_chat_history", {"threads": {nickname: threads.get(nickname, [])}}, to=sid)